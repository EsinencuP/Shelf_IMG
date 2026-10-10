import type { Candidate, SearchDiagnostic } from '../types';
import { obj, str, safeUrl, candidateId, publicJson } from './catalog-utils';
import { normalizeGtin, type SearchProduct } from './validation';

export const OPEN_CATALOGS = [
  { id: 'beauty-facts', name: 'Open Beauty Facts', domain: 'openbeautyfacts.org' },
  { id: 'products-facts', name: 'Open Products Facts', domain: 'openproductsfacts.org' },
  { id: 'petfood-facts', name: 'Open Pet Food Facts', domain: 'openpetfoodfacts.org' },
] as const;

export function openCatalogCandidates(
  data: unknown,
  product: SearchProduct,
  catalog: (typeof OPEN_CATALOGS)[number],
): Candidate[] {
  const item = obj(obj(data).product),
    code = str(item.code);
  if (!product.ean || !code || normalizeGtin(code) !== normalizeGtin(product.ean)) return [];
  const images = obj(item.images),
    selected = obj(obj(item.selected_images).front),
    display = obj(selected.display);
  const urls = [...Object.values(display), item.image_front_url]
    .map((value) => safeUrl(value))
    .filter((url): url is string => !!url);
  return [...new Set(urls)]
    .filter(
      (url) =>
        new URL(url).hostname === `images.${catalog.domain}` ||
        new URL(url).hostname === 'images.openfoodfacts.org',
    )
    .slice(0, 2)
    .map((url) => {
      const language = url.match(/front_([a-z]{2})\./)?.[1];
      const metadata = language ? obj(images[`front_${language}`]) : {};
      const author =
        str(obj(images[String(metadata.imgid)]).uploader) || `${catalog.name} contributors`;
      if (language && /^\d+$/.test(String(metadata.rev ?? '')))
        url = url.replace(/\.\d+\.jpg(?:\?.*)?$/, '.full.jpg');
      return {
        id: candidateId(url),
        title:
          str(item.product_name_ro) ||
          str(item.product_name_ru) ||
          str(item.product_name) ||
          `Товар ${code}`,
        gtin: code,
        brand: str(item.brands),
        quantity: str(item.quantity),
        imageUrl: url,
        pageUrl: `https://world.${catalog.domain}/product/${code}`,
        source: catalog.name,
        rights: 'open_license' as const,
        license: `CC BY-SA 3.0 — https://creativecommons.org/licenses/by-sa/3.0/; автор: ${author}`,
        gtinExact: true,
        warnings: [
          'Каталог заполняется участниками: проверьте автора фотографии, вариант и актуальность упаковки.',
        ],
      };
    });
}

export function upcCandidates(data: unknown, product: SearchProduct): Candidate[] {
  const items = obj(data).items;
  if (!Array.isArray(items) || !product.ean) return [];
  return items.flatMap((value) => {
    const item = obj(value),
      gtin = str(item.ean) || str(item.upc) || str(item.gtin);
    if (!gtin || normalizeGtin(gtin) !== normalizeGtin(product.ean)) return [];
    const images = Array.isArray(item.images) ? item.images : [];
    return images.slice(0, 3).flatMap((image) => {
      const imageUrl = safeUrl(image);
      if (!imageUrl) return [];
      return [
        {
          id: candidateId(imageUrl),
          title: str(item.title) || `Товар ${gtin}`,
          brand: str(item.brand),
          quantity: str(item.size) || str(item.weight),
          gtin,
          imageUrl,
          pageUrl: `https://www.upcitemdb.com/upc/${encodeURIComponent(gtin)}`,
          source: 'UPCitemdb',
          rights: 'unknown' as const,
          gtinExact: true,
          warnings: [
            'Запись каталога соответствует EAN; фото и права использования требуют проверки.',
          ],
        },
      ];
    });
  });
}

export async function searchSupplementalCatalogs(
  product: SearchProduct,
): Promise<{ candidates: Candidate[]; diagnostics: SearchDiagnostic[] }> {
  if (!product.ean) return { candidates: [], diagnostics: [] };
  const code = product.ean.replace(/[\s-]/g, '');
  const fields =
    'code,product_name,product_name_ru,product_name_ro,brands,quantity,images,selected_images,image_front_url,creator';
  const jobs = [
    ...OPEN_CATALOGS.map((catalog) => ({
      id: catalog.id,
      name: catalog.name,
      run: async () =>
        openCatalogCandidates(
          await publicJson(
            `https://world.${catalog.domain}/api/v2/product/${code}.json?fields=${fields}`,
            4100,
          ),
          product,
          catalog,
        ),
    })),
    {
      id: 'upcitemdb',
      name: 'UPCitemdb',
      run: async () =>
        upcCandidates(
          await publicJson(
            `https://api.upcitemdb.com/prod/trial/lookup?${new URLSearchParams({ upc: code })}`,
            10000,
          ),
          product,
        ),
    },
  ];
  const candidates: Candidate[] = [],
    diagnostics: SearchDiagnostic[] = [];
  await Promise.all(
    jobs.map(async (job) => {
      const start = Date.now();
      try {
        const result = await job.run();
        candidates.push(...result);
        diagnostics.push({
          id: job.id,
          source: job.name,
          status: 'ok',
          count: result.length,
          elapsedMs: Date.now() - start,
          requests: 1,
        });
      } catch (error) {
        diagnostics.push({
          id: job.id,
          source: job.name,
          status: 'unavailable',
          count: 0,
          elapsedMs: Date.now() - start,
          requests: 1,
          message: error instanceof Error ? error.message : 'Источник недоступен.',
        });
      }
    }),
  );
  return { candidates, diagnostics };
}
