import { afterEach, expect, it, vi } from 'vitest';
import { searchProducts } from '@/lib/server/search';
import { searchRegionalSources } from '@/lib/server/regional-search';
import { SOURCE_STATUS_LABELS } from '@/lib/source-status';
vi.mock('@/lib/server/regional-search', async (original) => ({
  ...(await original<object>()),
  searchRegionalSources: vi.fn(async () => ({ candidates: [], diagnostics: [] })),
}));
vi.mock('@/lib/server/supplemental-search', async (original) => ({
  ...(await original<object>()),
  searchSupplementalCatalogs: vi.fn(async () => ({ candidates: [], diagnostics: [] })),
}));
afterEach(() => {
  vi.resetAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});
const product = { ean: '', nameRu: 'Тестовый товар', nameRo: '', brand: '', quantity: '' };
const options = { mode: 'moldova' as const, useWeb: false, webQueryLimit: 1, useCache: false };
function setup() {
  vi.stubEnv('DATABASE_URL', '');
  vi.stubEnv('BRAVE_SEARCH_API_KEY', '');
  vi.stubEnv('TAVILY_API_KEY', '');
  vi.stubEnv('SEARXNG_URL', '');
  const fetcher = vi.fn();
  vi.stubGlobal('fetch', fetcher);
  return fetcher;
}
it('lists skipped sources and their reasons without making extra requests', async () => {
  const fetcher = setup();
  const response = await searchProducts(product, options);
  expect(response.diagnostics?.find((row) => row.id === 'food-facts')).toMatchObject({
    status: 'disabled',
    count: 0,
  });
  expect(
    response.diagnostics?.every(
      (row) => !!row.reason && Object.hasOwn(SOURCE_STATUS_LABELS, row.status),
    ),
  ).toBe(true);
  expect(fetcher).not.toHaveBeenCalled();
});
it('returns a blocked source reason instead of a definitive not-found outcome', async () => {
  setup();
  vi.mocked(searchRegionalSources).mockResolvedValueOnce({
    candidates: [],
    diagnostics: [
      {
        id: 'metro-md',
        source: 'METRO Moldova',
        status: 'blocked',
        reason: 'HTTP 403',
        httpStatus: 403,
        count: 0,
        elapsedMs: 1,
      },
    ],
  });
  const response = await searchProducts(product, options);
  expect(response.diagnostics?.find((row) => row.id === 'metro-md')).toMatchObject({
    status: 'blocked',
    reason: 'HTTP 403',
  });
  expect(response.outcome).toBe('deferred');
});
