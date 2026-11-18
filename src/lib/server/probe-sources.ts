import type { SourceStatus } from '../types';
import { sourceFailureDetails, sourceReason, isSourceFailure } from '../source-status';
import { obj, safeUrl } from './catalog-utils';
import { readBody } from './http';
import { USER_AGENT } from './public-fetch';
import { outboundFetch } from './outbound-fetch';
import {
  ZAKAZ_STORES,
  zakazCandidates,
  linellaLinks,
  bucuriaLinks,
  bucuriaProductCandidates,
} from './regional-search';
import { OPEN_CATALOGS, openCatalogCandidates, upcCandidates } from './supplemental-search';
import { offCandidates } from './search';
import { type SearchProduct } from './validation';

export const REFERENCE_EANS = ['4840053004404', '4600699006831', '3017620422003'] as const;
const fields = 'code,product_name,brands,quantity,images,selected_images,image_front_url,creator';
export interface ProbeRow {
  source: string;
  ean: string | null;
  httpStatus: number | null;
  elapsedMs: number;
  imageCount: number | null;
  status: SourceStatus;
  reason?: string;
  message?: string;
  usage?: Record<string, unknown>;
}
interface Source {
  name: string;
  interval: number;
  url: (ean: string) => string;
  images?: (body: string, ean: string) => string[];
  token?: string;
  missing?: string;
  usage?: boolean;
  bucuria?: boolean;
}
const product = (ean: string): SearchProduct => ({
  ean,
  brand: '',
  quantity: '',
  nameRu: '',
  nameRo: '',
});
const json = (body: string) => {
  const data: unknown = JSON.parse(body);
  if (!data || typeof data !== 'object' || Array.isArray(data))
    throw new Error('Invalid JSON object');
  return obj(data);
};
const imagesOf = (items: { imageUrl: string }[]) => items.map((item) => item.imageUrl);

function sources(env: Record<string, string | undefined>): Source[] {
  return [
    ...ZAKAZ_STORES.map((store) => ({
      name: store.name,
      interval: 800,
      url: (ean: string) =>
        `https://${store.api}/stores/${store.store}/products/search/?${new URLSearchParams({ q: ean })}`,
      images: (body: string) => {
        const data = json(body);
        if (!Array.isArray(data.results)) throw new Error('Missing results');
        return imagesOf(zakazCandidates(data, store));
      },
    })),
    {
      name: 'Linella',
      interval: 1000,
      url: (ean) =>
        `https://linella.md/?${new URLSearchParams({ dispatch: 'products.search', q: ean, search_performed: 'Y', sl: 'ro' })}`,
      images: (body) =>
        linellaLinks(body, 'https://linella.md/')
          .map((link) => link.thumbnail)
          .filter(Boolean),
    },
    {
      name: 'Bucuria',
      interval: 1000,
      bucuria: true,
      url: (ean) => `https://www.bucuria.md/ru/search?${new URLSearchParams({ s: ean })}`,
    },
    {
      name: 'Open Food Facts',
      interval: 4100,
      url: (ean) => `https://world.openfoodfacts.org/api/v2/product/${ean}.json?fields=${fields}`,
      images: (body, ean) => imagesOf(offCandidates(json(body), product(ean))),
    },
    ...OPEN_CATALOGS.map((catalog) => ({
      name: catalog.name,
      interval: 4100,
      url: (ean: string) =>
        `https://world.${catalog.domain}/api/v2/product/${ean}.json?fields=${fields}`,
      images: (body: string, ean: string) =>
        imagesOf(openCatalogCandidates(json(body), product(ean), catalog)),
    })),
    {
      name: 'UPCitemdb',
      interval: 10_000,
      url: (ean) =>
        `https://api.upcitemdb.com/prod/trial/lookup?${new URLSearchParams({ upc: ean })}`,
      images: (body, ean) => {
        const data = json(body);
        if (!Array.isArray(data.items)) throw new Error('Missing items');
        return imagesOf(upcCandidates(data, product(ean)));
      },
    },
    {
      name: 'SearXNG',
      interval: 1000,
      missing: env.SEARXNG_URL?.trim() ? undefined : 'Задайте SEARXNG_URL в .env.local.',
      token: env.SEARXNG_API_TOKEN?.trim(),
      url: (ean) => {
        const base = new URL(env.SEARXNG_URL!);
        if (
          !['http:', 'https:'].includes(base.protocol) ||
          base.username ||
          base.password ||
          base.search ||
          base.hash
        )
          throw new Error('Invalid service URL');
        const url = new URL(`${base.href.replace(/\/$/, '')}/search`);
        url.search = new URLSearchParams({
          q: `"${ean}"`,
          format: 'json',
          categories: 'images',
          safesearch: '2',
        }).toString();
        return url.href;
      },
      images: (body) => {
        const data = json(body);
        if (!Array.isArray(data.results)) throw new Error('Missing results');
        return data.results
          .map((item) => safeUrl(obj(item).img_src))
          .filter((url): url is string => !!url);
      },
    },
    {
      name: 'Tavily /usage',
      interval: 0,
      usage: true,
      missing: env.TAVILY_API_KEY?.trim() ? undefined : 'Задайте TAVILY_API_KEY в .env.local.',
      token: env.TAVILY_API_KEY?.trim(),
      url: () => 'https://api.tavily.com/usage',
    },
  ];
}

export async function probeSources(
  options: {
    env?: Record<string, string | undefined>;
    fetch?: typeof fetch;
    sleep?: (ms: number) => Promise<void>;
    timeoutMs?: number;
  } = {},
) {
  const startedAt = performance.now();
  const env = options.env ?? process.env;
  const sleep = options.sleep ?? ((ms) => new Promise<void>((done) => setTimeout(done, ms)));
  // Local pacing only: a diagnostic must not consult caches, shared quotas or circuit breakers.
  const hosts = new Map<string, { tail: Promise<void>; started: number }>();
  async function get(url: string, source: Source) {
    const host = new URL(url).host;
    const state = hosts.get(host) ?? { tail: Promise.resolve(), started: 0 };
    hosts.set(host, state);
    const previous = state.tail;
    let release!: () => void;
    state.tail = new Promise<void>((done) => {
      release = done;
    });
    await previous;
    try {
      const wait = state.started + source.interval - Date.now();
      if (wait > 0) await sleep(wait);
      state.started = Date.now();
      const response = await outboundFetch(
        url,
        {
          headers: {
            'User-Agent': env.OPENFOODFACTS_USER_AGENT || USER_AGENT,
            ...(source.token ? { Authorization: `Bearer ${source.token}` } : {}),
          },
          timeoutMs: options.timeoutMs ?? 15_000,
          relay: false,
          redirect: source.token ? 'error' : 'follow',
          cache: 'no-store',
        },
        options.fetch,
      );
      return response;
    } finally {
      release();
    }
  }
  const generatedAt = new Date().toISOString();
  const rows = await Promise.all(
    sources(env).map(async (source) => {
      const results: ProbeRow[] = [];
      for (const ean of source.usage ? [null] : REFERENCE_EANS) {
        const row: ProbeRow = {
          source: source.name,
          ean,
          httpStatus: null,
          elapsedMs: 0,
          imageCount: null,
          status: 'disabled',
        };
        if (source.missing) {
          row.message = source.missing;
          row.reason = source.missing;
          results.push(row);
          continue;
        }
        const started = Date.now();
        let parsing = false;
        try {
          const response = await get(source.url(ean ?? ''), source);
          row.httpStatus = response.status;
          if (!response.ok) {
            await response.body?.cancel();
            row.status = sourceFailureDetails({ status: response.status }).status;
            row.message = `HTTP ${response.status}`;
          } else {
            parsing = true;
            const body = Buffer.from(await readBody(response, 2_000_000)).toString('utf8');
            if (source.usage) {
              const data = json(body);
              const account = obj(data.account),
                key = obj(data.key);
              if (!Object.keys(account).length || !Object.keys(key).length)
                throw new Error('Missing usage');
              // Allowlist usage fields; never persist an upstream body or credentials.
              row.usage = Object.fromEntries(
                ['current_plan', 'plan_usage', 'plan_limit', 'paygo_usage', 'paygo_limit'].map(
                  (field) => [field, account[field] ?? null],
                ),
              );
              row.usage.key_usage = key.usage ?? null;
              row.usage.key_limit = key.limit ?? null;
              row.status = 'ok';
            } else {
              let images = source.images?.(body, ean!) ?? [];
              if (source.bucuria) {
                for (const link of bucuriaLinks(body).slice(0, 3)) {
                  parsing = false;
                  const page = await get(link.url, source);
                  if (!page.ok) {
                    await page.body?.cancel();
                    row.status = sourceFailureDetails({ status: page.status }).status;
                    row.message = `Карточка Bucuria: HTTP ${page.status}`;
                    break;
                  }
                  parsing = true;
                  const html = Buffer.from(await readBody(page, 2_000_000)).toString('utf8');
                  images.push(...imagesOf(bucuriaProductCandidates(html, link.url)));
                }
              }
              row.imageCount = isSourceFailure(row.status) ? null : new Set(images).size;
              if (!isSourceFailure(row.status)) row.status = row.imageCount ? 'ok' : 'empty';
            }
          }
        } catch (error) {
          row.status =
            error instanceof Error && ['TimeoutError', 'AbortError'].includes(error.name)
              ? 'timeout'
              : parsing
                ? 'parse_error'
                : 'blocked';
          row.message =
            row.status === 'timeout'
              ? 'Превышено время ожидания.'
              : parsing
                ? 'Не удалось разобрать ответ источника.'
                : 'Не удалось выполнить запрос; проверьте сеть и адрес сервиса.';
        }
        row.reason =
          row.message ||
          (source.usage && row.status === 'ok'
            ? 'Тариф и использование квоты получены; поиск не запускался.'
            : sourceReason(row.status));
        row.elapsedMs = Date.now() - started;
        results.push(row);
      }
      return results;
    }),
  );
  return {
    generatedAt,
    referenceEans: [...REFERENCE_EANS],
    results: rows.flat(),
    elapsedMs: Math.max(0, Math.round(performance.now() - startedAt)),
  };
}
