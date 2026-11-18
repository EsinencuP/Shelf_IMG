import { sourceDiagnostic, sourceFailureDetails } from '../source-status';
import { load } from 'cheerio/slim';
import type { Candidate, SearchAttempt, SearchDiagnostic } from '../types';
import {
  candidateId,
  catalogProducts,
  obj,
  str,
  safeUrl,
  publicHtml,
  publicJson,
} from './catalog-utils';
import { nativeQueries, canonicalText, titleRelevance, withMarketName } from './search-queries';
import { normalizeGtin, type SearchProduct } from './validation';
import { matchCandidate } from './matching';
import { ApiError } from './http';
import { recordSearchAttempt } from './search-attempt';
import type { SupplierMarket } from '../search-sources';

class PartialCatalogFailure extends Error {
  constructor(
    public candidates: Candidate[],
    public failure: unknown,
  ) {
    super('Часть карточек недоступна.');
  }
}
function collectCards(results: PromiseSettledResult<Candidate[]>[]): Candidate[] {
  const candidates = results.flatMap((result) =>
    result.status === 'fulfilled' ? result.value : [],
  );
  const failure = results.find((result) => result.status === 'rejected');
  if (failure?.status === 'rejected') throw new PartialCatalogFailure(candidates, failure.reason);
  return candidates;
}

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

function relevant(
  product: SearchProduct,
  candidates: Candidate[],
  discovery = product,
): Candidate[] {
  return candidates
    .filter((candidate) => {
      if (matchCandidate(product, candidate).rejected) return false;
      if (
        product.ean &&
        candidate.gtin &&
        normalizeGtin(product.ean) === normalizeGtin(candidate.gtin)
      )
        return true;
      return titleRelevance(discovery, candidate.title) >= 0.35;
    })
    .sort((a, b) => titleRelevance(discovery, b.title) - titleRelevance(discovery, a.title));
}

async function searchZakaz(
  product: SearchProduct,
  source: (typeof ZAKAZ_STORES)[number],
  attempts: SearchAttempt[],
  marketName?: string,
): Promise<Candidate[]> {
  const result = new Map<string, Candidate>();
  const discovery = withMarketName(product, marketName);
  try {
    for (const query of nativeQueries(discovery)) {
      const found = await recordSearchAttempt(
        attempts,
        query,
        async () => {
          const data = await publicJson(
            `https://${source.api}/stores/${source.store}/products/search/?${new URLSearchParams({ q: query })}`,
            800,
          );
          if (!Array.isArray(obj(data).results))
            throw new ApiError(502, 'Каталог вернул некорректную выдачу.');
          return relevant(product, zakazCandidates(data, source), discovery);
        },
        (results) => results.length,
      );
      for (const candidate of found) result.set(candidate.imageUrl, candidate);
      if (
        product.ean &&
        [...result.values()].some(
          (candidate) => normalizeGtin(candidate.gtin || '') === normalizeGtin(product.ean),
        )
      )
        break;
      if (!product.ean && result.size >= 3) break;
    }
  } catch (error) {
    if (result.size) throw new PartialCatalogFailure([...result.values()].slice(0, 4), error);
    throw error;
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

async function searchLinella(
  product: SearchProduct,
  attempts: SearchAttempt[],
): Promise<Candidate[]> {
  const links = new Map<string, { title: string; url: string; thumbnail: string }>();
  let failedSearch: PromiseRejectedResult | undefined;
  for (const query of nativeQueries(product).slice(0, 3)) {
    const pageLinks = await recordSearchAttempt(
      attempts,
      query,
      async () => {
        const html = await publicHtml(
          `https://linella.md/?${new URLSearchParams({ dispatch: 'products.search', q: query, search_performed: 'Y', sl: /[а-я]/i.test(query) ? 'ru' : 'ro' })}`,
        );
        return linellaLinks(html, 'https://linella.md/');
      },
      (results) => results.length,
    ).catch((reason: unknown) => {
      failedSearch = { status: 'rejected', reason };
      return null;
    });
    if (pageLinks === null) break;
    for (const link of pageLinks) {
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
          (product.ean === query && pageLinks.length <= 3)) &&
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
    ordered.map((link) =>
      recordSearchAttempt(
        attempts,
        new URL(link.url).pathname,
        async () => {
          const html = await publicHtml(link.url);
          return catalogProducts(html, link.url, product, true).map((item) => ({
            ...item,
            source: 'Linella',
          }));
        },
        (results) => results.length,
      ),
    ),
  );
  if (failedSearch) results.unshift(failedSearch);
  return collectCards(results);
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

async function searchBucuria(
  product: SearchProduct,
  attempts: SearchAttempt[],
): Promise<Candidate[]> {
  if (!/bucuria|букурия/i.test(`${product.brand} ${product.nameRo} ${product.nameRu}`)) return [];
  const names = nativeQueries(product).filter((query) => !/^[\d]+$/.test(query));
  const query = (names[0] || product.brand).replace(/bucuria|букурия/gi, '').trim();
  if (!query) return [];
  const links = await recordSearchAttempt(
    attempts,
    query,
    async () => {
      const html = await publicHtml(
        `https://www.bucuria.md/ru/search?${new URLSearchParams({ s: query })}`,
      );
      return bucuriaLinks(html)
        .filter((link) => titleRelevance(product, `Bucuria ${link.title}`) >= 0.35)
        .slice(0, 2);
    },
    (results) => results.length,
  );
  const results = await Promise.allSettled(
    links.map((link) =>
      recordSearchAttempt(
        attempts,
        new URL(link.url).pathname,
        async () => {
          const page = await publicHtml(link.url);
          return relevant(product, bucuriaProductCandidates(page, link.url));
        },
        (results) => results.length,
      ),
    ),
  );
  return collectCards(results);
}

export async function searchRegionalSources(
  product: SearchProduct,
  mode: 'moldova' | 'expanded' = 'expanded',
  market?: SupplierMarket,
  marketName?: string,
): Promise<{ candidates: Candidate[]; diagnostics: SearchDiagnostic[] }> {
  const jobs = [
    ...ZAKAZ_STORES.map((source) => ({
      id: source.id,
      name: source.name,
      run: (attempts: SearchAttempt[]) =>
        searchZakaz(
          product,
          source,
          attempts,
          market === 'UA' && source.id.endsWith('-ua') ? marketName : undefined,
        ),
    })),
    {
      id: 'linella',
      name: 'Linella',
      run: (attempts: SearchAttempt[]) => searchLinella(product, attempts),
    },
    {
      id: 'bucuria',
      name: 'Bucuria — производитель',
      run: (attempts: SearchAttempt[]) => searchBucuria(product, attempts),
    },
  ];
  const diagnostics: SearchDiagnostic[] = [];
  const candidates: Candidate[] = [];
  // Per-host pacing serializes shared catalogs; independent hosts run in parallel.
  await Promise.all(
    jobs.map(async (job) => {
      const start = Date.now();
      const attempts: SearchAttempt[] = [];
      const sourceMarket: 'UA' | 'MD' = job.id.endsWith('-ua') ? 'UA' : 'MD';
      try {
        if ((mode === 'moldova' || (market && market !== 'UA')) && sourceMarket === 'UA') {
          diagnostics.push(
            sourceDiagnostic({
              id: job.id,
              source: job.name,
              status: 'skipped',
              count: 0,
              elapsedMs: 0,
              message: 'Украинский каталог вне выбранного рынка.',
            }),
          );
          return;
        }
        if (
          job.id === 'bucuria' &&
          !/bucuria|букурия/i.test(`${product.brand} ${product.nameRo} ${product.nameRu}`)
        ) {
          diagnostics.push(
            sourceDiagnostic({
              id: job.id,
              source: job.name,
              status: 'skipped',
              count: 0,
              elapsedMs: 0,
              message: 'Каталог Bucuria не опрашивается для товаров других производителей.',
            }),
          );
          return;
        }
        const result = await job.run(attempts);
        candidates.push(...result.map<Candidate>((candidate) => ({ ...candidate, sourceMarket })));
        diagnostics.push(
          sourceDiagnostic({
            id: job.id,
            source: job.name,
            status: 'ok',
            count: result.length,
            elapsedMs: Date.now() - start,
            requests: attempts.length,
            attempts,
          }),
        );
      } catch (error) {
        if (error instanceof PartialCatalogFailure)
          candidates.push(
            ...error.candidates.map<Candidate>((candidate) => ({
              ...candidate,
              sourceMarket,
            })),
          );
        diagnostics.push(
          sourceDiagnostic({
            id: job.id,
            source: job.name,
            count: error instanceof PartialCatalogFailure ? error.candidates.length : 0,
            elapsedMs: Date.now() - start,
            requests: attempts.length,
            attempts,
            message: error instanceof Error ? error.message : 'Источник временно недоступен.',
            ...sourceFailureDetails(error instanceof PartialCatalogFailure ? error.failure : error),
          }),
        );
      }
    }),
  );
  return { candidates, diagnostics };
}
