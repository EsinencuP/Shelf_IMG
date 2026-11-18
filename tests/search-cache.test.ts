import { afterEach, expect, it, vi } from 'vitest';
import { cachedSearch, clearSearchCache } from '@/lib/server/search-cache';
import { DEFAULT_SEARCH_OPTIONS } from '@/lib/types';
import { abortable } from '@/lib/server/search-signal';
afterEach(() => {
  clearSearchCache();
  vi.unstubAllEnvs();
});
it('cancels shared work only after the last caller leaves', async () => {
  vi.stubEnv('SEARCH_CACHE_ENABLED', 'true');
  const product = { ean: '', nameRu: 'Bottle', nameRo: '', brand: '', quantity: '' };
  const first = new AbortController();
  const second = new AbortController();
  let operationSignal: AbortSignal | undefined;
  const job = vi.fn((signal?: AbortSignal) => {
    operationSignal = signal;
    return abortable(new Promise<never>(() => {}), signal);
  });
  const a = cachedSearch(product, DEFAULT_SEARCH_OPTIONS, false, job, first.signal);
  const b = cachedSearch(product, DEFAULT_SEARCH_OPTIONS, false, job, second.signal);
  first.abort();
  await expect(a).rejects.toMatchObject({ name: 'AbortError' });
  expect(operationSignal?.aborted).toBe(false);
  second.abort();
  await expect(b).rejects.toMatchObject({ name: 'AbortError' });
  expect(operationSignal?.aborted).toBe(true);
  expect(job).toHaveBeenCalledOnce();
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
