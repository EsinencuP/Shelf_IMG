import { createHash } from 'node:crypto';
import type { SearchOptions, SearchResponse } from '../types';
import { normalizeGtin, type SearchProduct } from './validation';
import { isSourceFailure } from '../source-status';

interface Entry {
  response: SearchResponse;
  storedAt: number;
  expiresAt: number;
}
const memory = new Map<string, Entry>();
const running = new Map<string, Promise<SearchResponse>>();
const generations = new Map<string, number>();

export function cacheEnabled(): boolean {
  return (
    process.env.SEARCH_CACHE_ENABLED !== 'false' &&
    (process.env.NODE_ENV !== 'test' || process.env.SEARCH_CACHE_ENABLED === 'true')
  );
}

export function searchCacheKey(product: SearchProduct, options: SearchOptions): string {
  const normalized = Object.fromEntries(
    Object.entries(product).map(([field, value]) => [
      field,
      field === 'ean' ? normalizeGtin(value) || value : value.normalize('NFKC').trim(),
    ]),
  );
  return createHash('sha256')
    .update(
      JSON.stringify({
        version: 10,
        product: normalized,
        mode: options.mode,
        market: options.market,
        useWeb: options.useWeb,
        webQueryLimit: options.webQueryLimit,
        sources: [
          'BRAVE_SEARCH_API_KEY',
          'BRAVE_FREE_ONLY_CONFIRMED',
          'BRAVE_FREE_ONLY_KEY_SHA256',
          'TAVILY_API_KEY',
        ].map((key) => process.env[key] || ''),
      }),
    )
    .digest('hex');
}

function ttl(positive: boolean): number {
  const value = Number(
    process.env[positive ? 'SEARCH_CACHE_TTL_SECONDS' : 'SEARCH_NEGATIVE_CACHE_TTL_SECONDS'],
  );
  return Number.isFinite(value) && value >= 60
    ? Math.min(86400, Math.floor(value))
    : positive
      ? 21600
      : 600;
}

function withHit(response: SearchResponse, source: string): SearchResponse {
  return {
    ...structuredClone(response),
    diagnostics: [
      {
        id: 'cache',
        source: 'Кэш поиска',
        status: 'ok',
        count: response.candidates.length,
        elapsedMs: 0,
        message: `Повторный запрос: результат из ${source}. Обновление доступно через повторный поиск.`,
      },
      ...(response.diagnostics || []).filter((item) => item.id !== 'cache'),
    ],
  };
}

export async function cachedSearch(
  product: SearchProduct,
  options: SearchOptions,
  refresh: boolean,
  job: () => Promise<SearchResponse>,
): Promise<SearchResponse> {
  if (!cacheEnabled() || options.useCache === false) return job();
  const key = searchCacheKey(product, options);
  if (!refresh) {
    const entry = memory.get(key);
    if (entry && entry.expiresAt > Date.now()) return withHit(entry.response, 'памяти сервера');
    memory.delete(key);
    if (running.has(key)) return withHit(await running.get(key)!, 'совмещённого запроса');
  }
  const generation = (generations.get(key) ?? 0) + 1;
  if (generations.size >= 2000) {
    for (const oldKey of generations.keys()) {
      if (!running.has(oldKey)) {
        generations.delete(oldKey);
        break;
      }
    }
  }
  generations.set(key, generation);
  const operation = (async () => {
    const response = await job();
    // An empty result during upstream errors is not reliable absence evidence.
    const cacheable =
      response.coverage !== 'partial' &&
      (response.candidates.length > 0 ||
        (!!response.diagnostics?.some((item) => item.status === 'ok' || item.status === 'empty') &&
          !response.diagnostics.some(
            (item) =>
              isSourceFailure(item.status) ||
              /недоступ|ошиб|исчерпан|не получил|некоррект/i.test(item.message ?? ''),
          )));
    if (cacheable && generations.get(key) === generation) {
      const storedAt = Date.now(),
        ttlSeconds = ttl(response.candidates.length > 0);
      remember(key, response, storedAt, ttlSeconds);
    }
    return response;
  })();
  // Explicit refresh does not replace another caller's running operation.
  if (!refresh) running.set(key, operation);
  try {
    return await operation;
  } finally {
    if (running.get(key) === operation) running.delete(key);
  }
}

function remember(key: string, response: SearchResponse, storedAt: number, seconds: number) {
  for (const [oldKey, entry] of memory) if (entry.expiresAt <= Date.now()) memory.delete(oldKey);
  if (memory.size >= 300) memory.delete(memory.keys().next().value!);
  memory.set(key, {
    response: structuredClone(response),
    storedAt,
    expiresAt: storedAt + seconds * 1000,
  });
}

export function clearSearchCache() {
  memory.clear();
  running.clear();
  generations.clear();
}
