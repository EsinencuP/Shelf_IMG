import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { obj, safeUrl } from '../src/lib/server/catalog-utils';
import { readBody } from '../src/lib/server/http';
import { USER_AGENT } from '../src/lib/server/public-fetch';
import {
  ZAKAZ_STORES,
  zakazCandidates,
  linellaLinks,
  bucuriaLinks,
  bucuriaProductCandidates,
} from '../src/lib/server/regional-search';
import {
  OPEN_CATALOGS,
  openCatalogCandidates,
  upcCandidates,
} from '../src/lib/server/supplemental-search';
import { offCandidates } from '../src/lib/server/search';
import { type SearchProduct } from '../src/lib/server/validation';

export const REFERENCE_EANS = ['4840053004404', '4600699006831', '3017620422003'] as const;
const fields = 'code,product_name,brands,quantity,images,selected_images,image_front_url,creator';
type State =
  | 'ok'
  | 'empty'
  | 'http-error'
  | 'timeout'
  | 'network-error'
  | 'invalid-response'
  | 'not-configured';
export interface ProbeRow {
  source: string;
  ean: string | null;
  httpStatus: number | null;
  elapsedMs: number;
  imageCount: number | null;
  status: State;
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
    ...ZAKAZ_STORES.filter((store) => store.id.endsWith('-md')).map((store) => ({
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
  const env = options.env ?? process.env;
  const request = options.fetch ?? fetch;
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
      const response = await request(url, {
        headers: {
          'User-Agent': env.OPENFOODFACTS_USER_AGENT || USER_AGENT,
          ...(source.token ? { Authorization: `Bearer ${source.token}` } : {}),
        },
        signal: AbortSignal.timeout(options.timeoutMs ?? 15_000),
        redirect: source.token ? 'error' : 'follow',
        cache: 'no-store',
      });
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
          status: 'not-configured',
        };
        if (source.missing) {
          row.message = source.missing;
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
            row.status = 'http-error';
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
                    row.status = 'http-error';
                    row.message = `Карточка Bucuria: HTTP ${page.status}`;
                    break;
                  }
                  parsing = true;
                  const html = Buffer.from(await readBody(page, 2_000_000)).toString('utf8');
                  images.push(...imagesOf(bucuriaProductCandidates(html, link.url)));
                }
              }
              row.imageCount = row.status === 'http-error' ? null : new Set(images).size;
              if (row.status !== 'http-error') row.status = row.imageCount ? 'ok' : 'empty';
            }
          }
        } catch (error) {
          row.status =
            error instanceof Error && ['TimeoutError', 'AbortError'].includes(error.name)
              ? 'timeout'
              : parsing
                ? 'invalid-response'
                : 'network-error';
          row.message =
            row.status === 'timeout'
              ? 'Превышено время ожидания.'
              : parsing
                ? 'Не удалось разобрать ответ источника.'
                : 'Не удалось выполнить запрос; проверьте сеть и адрес сервиса.';
        }
        row.elapsedMs = Date.now() - started;
        results.push(row);
      }
      return results;
    }),
  );
  return { generatedAt, referenceEans: [...REFERENCE_EANS], results: rows.flat() };
}

export async function runProbe(
  options: Parameters<typeof probeSources>[0] = {},
  outputPath = 'probe-report.json',
) {
  const report = await probeSources(options);
  console.table(
    report.results.map((row) => ({
      Источник: row.source,
      EAN: row.ean ?? '—',
      HTTP: row.httpStatus ?? '—',
      'Время, мс': row.elapsedMs,
      Изображения: row.imageCount ?? '—',
      Статус: row.status,
      Примечание: row.message ?? (row.usage ? JSON.stringify(row.usage) : ''),
    })),
  );
  await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  console.log(`Отчёт: ${resolve(outputPath)}`);
  return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  runProbe().catch(() => {
    console.error('Не удалось завершить проверку или записать probe-report.json.');
    process.exitCode = 1;
  });
}
