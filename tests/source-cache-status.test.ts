import { afterEach, expect, it, vi } from 'vitest';
import { cachedSearch, clearSearchCache } from '@/lib/server/search-cache';
import { DEFAULT_SEARCH_OPTIONS, type SourceStatus, type SearchResponse } from '@/lib/types';
const product = { ean: '', nameRu: 'Тест', nameRo: '', brand: '', quantity: '' };
afterEach(() => {
  clearSearchCache();
  vi.unstubAllEnvs();
});
it.each(['blocked', 'quota', 'timeout', 'parse_error', 'relay_offline'] as SourceStatus[])(
  'does not cache %s as proof of product absence',
  async (status) => {
    vi.stubEnv('SEARCH_CACHE_ENABLED', 'true');
    const job = vi.fn(async (): Promise<SearchResponse> => ({
      candidates: [],
      warnings: [],
      diagnostics: [
        { id: 'a', source: 'A', status: 'empty', reason: 'No matches', count: 0, elapsedMs: 1 },
        { id: 'b', source: 'B', status, reason: 'Failure', count: 0, elapsedMs: 1 },
      ],
    }));
    await cachedSearch(product, DEFAULT_SEARCH_OPTIONS, false, job);
    await cachedSearch(product, DEFAULT_SEARCH_OPTIONS, false, job);
    expect(job).toHaveBeenCalledTimes(2);
  },
);
it('reuses a genuine empty response', async () => {
  vi.stubEnv('SEARCH_CACHE_ENABLED', 'true');
  const job = vi.fn(async (): Promise<SearchResponse> => ({
    candidates: [],
    warnings: [],
    diagnostics: [
      { id: 'a', source: 'A', status: 'empty', reason: 'No matches', count: 0, elapsedMs: 1 },
    ],
  }));
  await cachedSearch(product, DEFAULT_SEARCH_OPTIONS, false, job);
  await cachedSearch(product, DEFAULT_SEARCH_OPTIONS, false, job);
  expect(job).toHaveBeenCalledTimes(1);
});
