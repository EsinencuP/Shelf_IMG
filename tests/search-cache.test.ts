import { afterEach, expect, it, vi } from 'vitest';
import { cachedSearch, clearSearchCache } from '@/lib/server/search-cache';
import { DEFAULT_SEARCH_OPTIONS } from '@/lib/types';
afterEach(() => {
  clearSearchCache();
  vi.unstubAllEnvs();
});
it('memory reuse and refresh work without persistent filesystem/services', async () => {
  vi.stubEnv('SEARCH_CACHE_ENABLED', 'true');
  const p = { ean: '', nameRu: 'Bottle', nameRo: '', brand: '', quantity: '' };
  const job = vi.fn(async () => ({
    candidates: [],
    warnings: [],
    diagnostics: [{ id: 'shop', source: 'shop', status: 'ok' as const, count: 0, elapsedMs: 0 }],
  }));
  await cachedSearch(p, DEFAULT_SEARCH_OPTIONS, false, job);
  await cachedSearch(p, DEFAULT_SEARCH_OPTIONS, false, job);
  expect(job).toHaveBeenCalledTimes(1);
  await cachedSearch(p, DEFAULT_SEARCH_OPTIONS, true, job);
  expect(job).toHaveBeenCalledTimes(2);
});
