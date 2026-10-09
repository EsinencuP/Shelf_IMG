import { createHash } from 'node:crypto';
import type { Candidate, SearchResponse } from '../types';
import { ApiError, readBody } from './http';
import { publicGet, USER_AGENT, validatePublicUrl } from './public-fetch';
import { matchCandidate } from './matching';
import { normalizeGtin, type SearchProduct } from './validation';

const idFor = (value: string) => createHash('sha256').update(value).digest('hex').slice(0, 20);
const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const text = (value: unknown) => (typeof value === 'string' ? value.slice(0, 400) : '');
const publicUrl = (value: unknown, base?: string): string | null => {
  if (typeof value !== 'string') return null;
  try {
    return validatePublicUrl(base ? new URL(value, base).href : value).href;
  } catch {
    return null;
  }
};

async function providerJson(
  url: string,
  headers: Record<string, string> = {},
): Promise<Record<string, unknown>> {
  const response = await fetch(url, {
    cache: 'no-store',
    redirect: 'error',
    signal: AbortSignal.timeout(12_000),
    headers: {
      'User-Agent': process.env.OPENFOODFACTS_USER_AGENT || USER_AGENT,
      Accept: 'application/json',
      ...headers,
    },
  });
  if (!response.ok)
    throw new ApiError(
      response.status === 429 ? 429 : 502,
      response.status === 429
        ? 'Лимит источника исчерпан; повторите позже.'
        : 'Источник поиска временно недоступен.',
    );
  const body = await readBody(response, 1_000_000);
  try {
    return record(JSON.parse(Buffer.from(body).toString('utf8')));
  } catch {
    throw new ApiError(502, 'Источник вернул некорректный JSON.');
  }
}

// Product reads are paced to stay below OFF's 15 reads/minute/IP within this process.
// Multiple deployments behind one egress IP still need an external shared limiter.
let offTail: Promise<void> = Promise.resolve();
let offStarted = 0;
async function pacedOff<T>(job: () => Promise<T>): Promise<T> {
  const previous = offTail;
  let release!: () => void;
  offTail = new Promise<void>((resolve) => {
    release = resolve;
  });
  await previous;
  try {
    const wait = Math.max(0, offStarted + 4_100 - Date.now());
    if (wait) await new Promise((resolve) => setTimeout(resolve, wait));
    offStarted = Date.now();
    return await job();
  } finally {
    release();
  }
}

export function offCandidates(data: Record<string, unknown>, product: SearchProduct): Candidate[] {
  const item = record(data.product);
  if (
    !Object.keys(item).length ||
    !product.ean ||
    normalizeGtin(text(item.code)) !== normalizeGtin(product.ean)
  )
    return [];
  const images = record(item.images);
  const selected = record(record(item.selected_images).front);
  const display = record(selected.display);
  const languages = [
    ...new Set([
      'ro',
      'ru',
      'en',
      ...Object.keys(display),
      ...Object.keys(images)
        .filter((key) => key.startsWith('front_'))
        .map((key) => key.slice(6)),
    ]),
  ];
  const pageUrl = `https://world.openfoodfacts.org/product/${encodeURIComponent(text(item.code))}`;
  const candidates: Candidate[] = [];
  const seen = new Set<string>();
  for (const lang of languages) {
    const meta = record(images[`front_${lang}`]);
    let url = publicUrl(display[lang]);
    // Preserve the selected front crop, increasing only to the source's existing full resolution.
    if (url && /^\d+$/.test(String(meta.rev ?? '')))
      url = url.replace(/\.\d+\.jpg(?:\?.*)?$/, '.full.jpg');
    if (!url && /^\d+$/.test(String(meta.rev ?? '')) && /^(?:[a-z]{2})$/.test(lang)) {
      const code = text(item.code).padStart(13, '0');
      const path = code.replace(/^(...)(...)(...)(.*)$/, '$1/$2/$3/$4');
      url = `https://images.openfoodfacts.org/images/products/${path}/front_${lang}.${meta.rev}.full.jpg`;
    }
    if (!url || seen.has(url) || new URL(url).hostname !== 'images.openfoodfacts.org') continue;
    seen.add(url);
    const author = text(record(images[String(meta.imgid)]).uploader) || text(item.creator);
    candidates.push({
      id: idFor(url),
      title:
        text(item[`product_name_${lang}`]) || text(item.product_name) || 'Товар Open Food Facts',
      brand: text(item.brands),
      quantity: text(item.quantity),
      gtin: text(item.code),
      imageUrl: url,
      pageUrl,
      source: `Open Food Facts${author ? ` · ${author}` : ' · contributors'}`,
      rights: 'open_license',
      license: `CC BY-SA 3.0 — https://creativecommons.org/licenses/by-sa/3.0/; автор: ${author || 'Open Food Facts contributors'}; источник: ${pageUrl}`,
      gtinExact: true,
      warnings: [
        'Открытая база пищевых продуктов, заполненная участниками. Проверьте фотографию.',
        ...(!author
          ? [
              'Автор конкретной фотографии отсутствует в метаданных; проверьте атрибуцию на странице товара.',
            ]
          : []),
      ],
    });
    if (candidates.length >= 3) break;
  }
  if (!candidates.length) {
    const url = publicUrl(item.image_front_url);
    if (url && new URL(url).hostname === 'images.openfoodfacts.org')
      candidates.push({
        id: idFor(url),
        title: text(item.product_name) || 'Товар Open Food Facts',
        brand: text(item.brands),
        quantity: text(item.quantity),
        gtin: text(item.code),
        imageUrl: url,
        pageUrl,
        source: 'Open Food Facts · contributors',
        rights: 'open_license',
        license: `CC BY-SA 3.0 — https://creativecommons.org/licenses/by-sa/3.0/; источник: ${pageUrl}`,
        gtinExact: true,
        warnings: ['Проверьте автора фотографии на странице источника и актуальность упаковки.'],
      });
  }
  return candidates;
}

async function fromOff(product: SearchProduct): Promise<Candidate[]> {
  if (!product.ean) return [];
  const code = product.ean.replace(/[\s-]/g, '');
  const fields =
    'code,product_name,product_name_ru,product_name_ro,product_name_en,brands,quantity,images,selected_images,image_front_url,creator';
  // v2 remains supported and supplies the documented selected front image/uploader schema.
  const data = await pacedOff(() =>
    providerJson(`https://world.openfoodfacts.org/api/v2/product/${code}.json?fields=${fields}`),
  );
  return offCandidates(data, product);
}

export function productJsonLdCandidates(
  html: string,
  pageUrl: string,
  product: SearchProduct,
): Candidate[] {
  const requested = product.ean ? normalizeGtin(product.ean) : null;
  if (!requested) return [];
  const candidates: Candidate[] = [];
  let visited = 0;
  const walk = (value: unknown, depth = 0): void => {
    if (depth > 10 || visited++ > 300 || candidates.length >= 4) return;
    if (Array.isArray(value)) {
      value.slice(0, 100).forEach((node) => walk(node, depth + 1));
      return;
    }
    const node = record(value);
    const types = Array.isArray(node['@type']) ? node['@type'] : [node['@type']];
    if (types.some((type) => typeof type === 'string' && /(?:^|[/#])Product$/.test(type))) {
      const gtins = ['gtin', 'gtin8', 'gtin12', 'gtin13', 'gtin14']
        .map((key) => text(node[key]))
        .filter(Boolean);
      const gtin = gtins.find((value) => normalizeGtin(value) === requested);
      if (gtin) {
        const images = Array.isArray(node.image) ? node.image : [node.image];
        for (const image of images.slice(0, 3)) {
          const imageNode = record(image);
          const imageUrl = publicUrl(
            typeof image === 'string' ? image : imageNode.url || imageNode.contentUrl,
            pageUrl,
          );
          if (!imageUrl) continue;
          candidates.push({
            id: idFor(imageUrl),
            title: text(node.name) || 'Товар каталога',
            brand: text(node.brand) || text(record(node.brand).name),
            quantity: text(node.size) || text(record(node.weight).value),
            gtin,
            imageUrl,
            pageUrl,
            source: new URL(pageUrl).hostname,
            rights: 'unknown',
            gtinExact: true,
            warnings: [
              'GTIN и изображение связаны в Product JSON-LD источника; сведения требуют проверки.',
              'Права использования не подтверждены.',
            ],
          });
        }
      }
    }
    // Only graph containers are traversed; recommendations/relatedProducts are not evidence.
    if (node['@graph']) walk(node['@graph'], depth + 1);
    if (node.mainEntity) walk(node.mainEntity, depth + 1);
  };
  const scripts = html.matchAll(
    /<script\b[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script\s*>/gi,
  );
  for (const script of scripts) {
    if (script[1].length > 200_000) continue;
    try {
      walk(JSON.parse(script[1]));
    } catch {
      /* An invalid script is not product evidence. */
    }
  }
  return candidates;
}

async function fromBrave(product: SearchProduct, warnings: string[]): Promise<Candidate[]> {
  const key = process.env.BRAVE_SEARCH_API_KEY;
  if (!key) return [];
  const query = (
    product.ean
      ? `"${product.ean.replace(/[\s-]/g, '')}"`
      : [product.brand, product.nameRo || product.nameRu, product.quantity]
          .filter(Boolean)
          .join(' ')
  ).slice(0, 400);
  const headers = { 'X-Subscription-Token': key };
  const candidates: Candidate[] = [];
  // Two API calls total per SKU: one original-image search and one web search. No pagination/retries.
  let completed = 0;
  let images: Record<string, unknown> = {};
  try {
    images = await providerJson(
      `https://api.search.brave.com/res/v1/images/search?${new URLSearchParams({ q: query, count: '6', country: 'ALL', safesearch: 'strict', spellcheck: 'false' })}`,
      headers,
    );
    completed++;
  } catch (error) {
    warnings.push(
      error instanceof ApiError
        ? `Brave Images: ${error.message}`
        : 'Brave Images временно недоступен.',
    );
  }
  for (const result of Array.isArray(images.results) ? images.results.slice(0, 6) : []) {
    const item = record(result);
    const imageUrl = publicUrl(record(item.properties).url);
    const pageUrl = publicUrl(item.url);
    if (!imageUrl || !pageUrl) continue;
    candidates.push({
      id: idFor(imageUrl),
      title: text(item.title) || 'Изображение из поиска',
      imageUrl,
      pageUrl,
      source: text(item.source) || new URL(pageUrl).hostname,
      rights: 'unknown',
      gtinExact: false,
      warnings: [
        'Результат поиска не подтверждает GTIN и вариант упаковки.',
        'Права использования не подтверждены.',
      ],
    });
  }
  // Avoid a burst across image/web endpoints on low-rate plans; this is not a durable quota limiter.
  await new Promise((resolve) => setTimeout(resolve, 1_100));
  let web: Record<string, unknown> = {};
  try {
    web = await providerJson(
      `https://api.search.brave.com/res/v1/web/search?${new URLSearchParams({ q: query, count: '3', country: 'ALL', safesearch: 'strict', spellcheck: 'false' })}`,
      headers,
    );
    completed++;
  } catch (error) {
    warnings.push(
      error instanceof ApiError ? `Brave Web: ${error.message}` : 'Brave Web временно недоступен.',
    );
  }
  if (!completed) throw new ApiError(502, 'Оба поиска Brave временно недоступны.');
  const pages = record(web.web).results;
  if (product.ean)
    for (const result of Array.isArray(pages) ? pages.slice(0, 2) : []) {
      const pageUrl = publicUrl(record(result).url);
      if (!pageUrl) continue;
      try {
        const page = await publicGet(pageUrl, {
          maxBytes: 750_000,
          timeoutMs: 8_000,
          accept: 'text/html',
        });
        if (page.status === 200 && page.headers['content-type']?.includes('text/html'))
          candidates.push(
            ...productJsonLdCandidates(page.body.toString('utf8'), page.url, product),
          );
      } catch {
        warnings.push('Одна из страниц источника недоступна или отклонена проверкой безопасности.');
      }
    }
  return candidates;
}

export async function searchProducts(product: SearchProduct): Promise<SearchResponse> {
  const warnings: string[] = [];
  const candidates: Candidate[] = [];
  let successfulSources = 0;
  try {
    candidates.push(...(await fromOff(product)));
    if (product.ean) successfulSources++;
  } catch (error) {
    warnings.push(
      error instanceof ApiError
        ? `Open Food Facts: ${error.message}`
        : 'Open Food Facts временно недоступен.',
    );
  }
  if (!process.env.BRAVE_SEARCH_API_KEY)
    warnings.push(
      'Веб-поиск отключён: BRAVE_SEARCH_API_KEY не настроен. Open Food Facts охватывает только пищевые товары.',
    );
  else
    try {
      candidates.push(...(await fromBrave(product, warnings)));
      successfulSources++;
    } catch (error) {
      warnings.push(
        error instanceof ApiError ? `Brave: ${error.message}` : 'Brave Search временно недоступен.',
      );
    }
  if (!successfulSources && (product.ean || process.env.BRAVE_SEARCH_API_KEY))
    throw new ApiError(502, warnings.join(' '));
  const byImage = new Map<string, Candidate>();
  for (const candidate of candidates) {
    const result = matchCandidate(product, candidate);
    if (result.rejected) {
      warnings.push(
        `Отклонён «${candidate.title}»: ${result.candidate.warnings.filter((warning) => /отличается|отличаются/.test(warning)).join(' ')}`,
      );
      continue;
    }
    const previous = byImage.get(candidate.imageUrl);
    if (!previous || (!previous.gtinExact && result.candidate.gtinExact))
      byImage.set(candidate.imageUrl, result.candidate);
  }
  return {
    candidates: [...byImage.values()]
      .sort((a, b) => Number(b.gtinExact) - Number(a.gtinExact))
      .slice(0, 10),
    warnings: [...new Set(warnings)],
  };
}
