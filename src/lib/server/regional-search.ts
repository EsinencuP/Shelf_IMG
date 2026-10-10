import { load } from 'cheerio/slim';
import type { Candidate, SearchDiagnostic } from '../types';
import {
  candidateId,
  catalogProducts,
  obj,
  str,
  safeUrl,
  publicHtml,
  publicJson,
} from './catalog-utils';
import { nativeQueries, canonicalText, titleRelevance } from './search-queries';
import { normalizeGtin, type SearchProduct } from './validation';
import { matchCandidate } from './matching';

export const ZAKAZ_STORES = [
  {
    id: 'metro-md',
    name: 'METRO Moldova',
    api: 'stores-api.zakaz.md',
    store: '48415601',
    site: 'metro.zakaz.md',
  },
  {
    id: 'bonus-md',
    name: 'Bonus Moldova',
    api: 'stores-api.zakaz.md',
    store: '484266118',
    site: 'bonus.zakaz.md',
  },
  {
    id: 'metro-ua',
    name: 'METRO Ukraine',
    api: 'stores-api.zakaz.ua',
    store: '48215611',
    site: 'metro.zakaz.ua',
  },
  {
    id: 'novus-ua',
    name: 'NOVUS',
    api: 'stores-api.zakaz.ua',
    store: '482010105',
    site: 'novus.zakaz.ua',
  },
  {
    id: 'auchan-ua',
    name: 'Auchan Ukraine',
    api: 'stores-api.zakaz.ua',
    store: '48246401',
    site: 'auchan.zakaz.ua',
  },
  {
    id: 'tavria-ua',
    name: 'Таврия В',
    api: 'stores-api.zakaz.ua',
    store: '48221130',
    site: 'tavriav.zakaz.ua',
  },
] as const;

export function zakazCandidates(data: unknown, source: (typeof ZAKAZ_STORES)[number]): Candidate[] {
  const results = obj(data).results;
  if (!Array.isArray(results)) return [];
  return results.slice(0, 40).flatMap((value) => {
    const item = obj(value),
      producer = obj(item.producer),
      images = obj(item.img);
    const imageUrl = safeUrl(images.s1350x1350 || images.s350x350);
    const pageUrl = safeUrl(item.web_url);
    const title = str(item.title),
      gtin = normalizeGtin(str(item.ean)) ? str(item.ean) : undefined;
    if (!imageUrl || !pageUrl || !title || new URL(pageUrl).hostname !== source.site) return [];
    return [
      {
        id: candidateId(imageUrl),
        title,
        gtin,
        brand: [str(producer.trademark), str(producer.name)].filter(Boolean).join(', '),
        quantity: title,
        imageUrl,
        pageUrl,
        source: source.name,
        rights: 'unknown' as const,
        gtinExact: !!gtin,
        warnings: [
          'Фотография из публичной карточки магазина; проверьте актуальность упаковки и права использования.',
        ],
      },
    ];
  });
}

function relevant(product: SearchProduct, candidates: Candidate[]): Candidate[] {
  return candidates
    .filter((candidate) => {
      if (matchCandidate(product, candidate).rejected) return false;
      if (
        product.ean &&
        candidate.gtin &&
        normalizeGtin(product.ean) === normalizeGtin(candidate.gtin)
      )
        return true;
      return titleRelevance(product, candidate.title) >= 0.35;
    })
    .sort((a, b) => titleRelevance(product, b.title) - titleRelevance(product, a.title));
}

async function searchZakaz(
  product: SearchProduct,
  source: (typeof ZAKAZ_STORES)[number],
): Promise<Candidate[]> {
  const result = new Map<string, Candidate>();
  for (const query of nativeQueries(
    source.api.endsWith('.ua') && product.nameRu ? { ...product, nameRo: '' } : product,
  ).slice(0, 2)) {
    const data = await publicJson(
      `https://${source.api}/stores/${source.store}/products/search/?${new URLSearchParams({ q: query })}`,
      800,
    );
    for (const candidate of relevant(product, zakazCandidates(data, source)))
      result.set(candidate.imageUrl, candidate);
    if (
      product.ean &&
      [...result.values()].some(
        (candidate) => normalizeGtin(candidate.gtin || '') === normalizeGtin(product.ean),
      )
    )
      break;
    if (!product.ean && result.size >= 3) break;
  }
  return [...result.values()].slice(0, 4);
}

export function linellaLinks(
  html: string,
  base: string,
): { title: string; url: string; thumbnail: string }[] {
  const $ = load(html),
    result: { title: string; url: string; thumbnail: string }[] = [];
  $('a.product-title')
    .slice(0, 60)
    .each((_, element) => {
      const link = $(element),
        url = safeUrl(link.attr('href'), base);
      if (!url || new URL(url).hostname !== 'linella.md') return;
      const card = link.closest('.ut2-gl__item,.ty-grid-list__item');
      const thumbnail = safeUrl(card.find('img').first().attr('src'), base) || '';
      result.push({ title: link.text().trim().slice(0, 300), url, thumbnail });
    });
  return result;
}

async function searchLinella(product: SearchProduct): Promise<Candidate[]> {
  const links = new Map<string, { title: string; url: string; thumbnail: string }>();
  for (const query of nativeQueries(product).slice(0, 3)) {
    const html = await publicHtml(
      `https://linella.md/?${new URLSearchParams({ dispatch: 'products.search', q: query, search_performed: 'Y', sl: /[а-я]/i.test(query) ? 'ru' : 'ro' })}`,
    );
    for (const link of linellaLinks(html, 'https://linella.md/')) {
      const item: Candidate = {
        id: candidateId(link.url),
        title: link.title,
        quantity: link.title,
        imageUrl: link.thumbnail,
        pageUrl: link.url,
        source: 'Linella',
        rights: 'unknown',
        gtinExact: false,
        warnings: [],
      };
      if (
        (titleRelevance(product, link.title) >= 0.35 ||
          (product.ean === query && linellaLinks(html, 'https://linella.md/').length <= 3)) &&
        !matchCandidate(product, item).rejected
      )
        links.set(link.url, link);
    }
    if (links.size >= 3) break;
  }
  const ordered = [...links.values()]
    .sort((a, b) => titleRelevance(product, b.title) - titleRelevance(product, a.title))
    .slice(0, 3);
  const results = await Promise.allSettled(
    ordered.map(async (link) => {
      const html = await publicHtml(link.url);
      return catalogProducts(html, link.url, product, true).map((item) => ({
        ...item,
        source: 'Linella',
      }));
    }),
  );
  return results.flatMap((result) => (result.status === 'fulfilled' ? result.value : []));
}

export function bucuriaLinks(html: string): { title: string; url: string }[] {
  const $ = load(html);
  return $('a.product-title[href]')
    .slice(0, 30)
    .map((_, element) => {
      const link = $(element),
        url = safeUrl(link.attr('href'), 'https://www.bucuria.md/');
      return url &&
        new URL(url).hostname === 'www.bucuria.md' &&
        new URL(url).pathname.startsWith('/ru/product/')
        ? { title: link.text().trim(), url }
        : null;
    })
    .get()
    .filter(Boolean);
}

export function bucuriaProductCandidates(html: string, pageUrl: string): Candidate[] {
  const $ = load(html),
    title = $('.product-content-desc > .product-title').first().text().trim();
  if (!title) return [];
  const items: Candidate[] = [];
  $('#product-weight-block-weights .weight-link[data-image]').each((_, element) => {
    const block = $(element),
      imageUrl = safeUrl(block.attr('data-image'), pageUrl),
      quantity = block.find('.product-weight-item').text().trim();
    if (!imageUrl || !/\d/.test(quantity)) return;
    const formatId = block.attr('data-weight-fade-id');
    const format = $('#product-weight-block .weight-link[data-id]')
      .filter((_, item) => $(item).attr('data-id') === formatId)
      .first();
    const label = format.find('.product-weight-item').text().trim();
    const variantPage = safeUrl(format.attr('data-link'), pageUrl) || pageUrl;
    items.push({
      id: candidateId(imageUrl),
      title: `Bucuria ${title} ${label} ${quantity}`,
      brand: 'Bucuria',
      quantity,
      imageUrl,
      pageUrl: variantPage,
      source: 'Bucuria — производитель',
      rights: 'unknown',
      gtinExact: false,
      warnings: [
        'Фотография связана с фасовкой в каталоге производителя. EAN не указан; проверьте потребительскую упаковку и права использования.',
      ],
    });
  });
  if (!items.length) {
    const imageUrl = safeUrl(
      $('.product-image-block img.product-image').first().attr('src'),
      pageUrl,
    );
    if (imageUrl)
      items.push({
        id: candidateId(imageUrl),
        title: `Bucuria ${title}`,
        brand: 'Bucuria',
        imageUrl,
        pageUrl,
        source: 'Bucuria — производитель',
        rights: 'unknown',
        gtinExact: false,
        warnings: [
          'Производитель не указал EAN или фасовку; проверьте потребительскую упаковку и права использования.',
        ],
      });
  }
  return items;
}

async function searchBucuria(product: SearchProduct): Promise<Candidate[]> {
  if (!/bucuria|букурия/i.test(`${product.brand} ${product.nameRo} ${product.nameRu}`)) return [];
  const names = nativeQueries(product).filter((query) => !/^[\d]+$/.test(query));
  const query = (names[0] || product.brand).replace(/bucuria|букурия/gi, '').trim();
  if (!query) return [];
  const html = await publicHtml(
    `https://www.bucuria.md/ru/search?${new URLSearchParams({ s: query })}`,
  );
  const links = bucuriaLinks(html)
    .filter((link) => titleRelevance(product, `Bucuria ${link.title}`) >= 0.35)
    .slice(0, 2);
  const results = await Promise.allSettled(
    links.map(async (link) => {
      const page = await publicHtml(link.url);
      return relevant(product, bucuriaProductCandidates(page, link.url));
    }),
  );
  return results.flatMap((result) => (result.status === 'fulfilled' ? result.value : []));
}

export async function searchRegionalSources(
  product: SearchProduct,
  mode: 'moldova' | 'expanded' = 'expanded',
): Promise<{ candidates: Candidate[]; diagnostics: SearchDiagnostic[] }> {
  const jobs = [
    ...ZAKAZ_STORES.map((source) => ({
      id: source.id,
      name: source.name,
      run: () => searchZakaz(product, source),
    })),
    { id: 'linella', name: 'Linella', run: () => searchLinella(product) },
    { id: 'bucuria', name: 'Bucuria — производитель', run: () => searchBucuria(product) },
  ];
  const diagnostics: SearchDiagnostic[] = [];
  const candidates: Candidate[] = [];
  // Small waves avoid bursting all requests at the same catalog host.
  for (let index = 0; index < jobs.length; index += 3) {
    await Promise.all(
      jobs.slice(index, index + 3).map(async (job) => {
        const start = Date.now();
        try {
          if (mode === 'moldova' && job.id.endsWith('-ua')) {
            diagnostics.push({
              id: job.id,
              source: job.name,
              status: 'skipped',
              count: 0,
              elapsedMs: 0,
              message: 'Отключён в режиме «Молдова». Расширьте поиск для этой позиции.',
            });
            return;
          }
          if (
            job.id === 'bucuria' &&
            !/bucuria|букурия/i.test(`${product.brand} ${product.nameRo} ${product.nameRu}`)
          ) {
            diagnostics.push({
              id: job.id,
              source: job.name,
              status: 'skipped',
              count: 0,
              elapsedMs: 0,
            });
            return;
          }
          const result = await job.run();
          candidates.push(...result);
          diagnostics.push({
            id: job.id,
            source: job.name,
            status: 'ok',
            count: result.length,
            elapsedMs: Date.now() - start,
          });
        } catch (error) {
          diagnostics.push({
            id: job.id,
            source: job.name,
            status: 'unavailable',
            count: 0,
            elapsedMs: Date.now() - start,
            message: error instanceof Error ? error.message : 'Источник временно недоступен.',
          });
        }
      }),
    );
  }
  return { candidates, diagnostics };
}
