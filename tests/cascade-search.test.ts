import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { searchProducts } from '@/lib/server/search';
const mocks = vi.hoisted(() => ({
  sostavista: vi.fn(),
  regional: vi.fn(),
  supplemental: vi.fn(),
  web: vi.fn(),
  providers: vi.fn(),
  checkPhoto: vi.fn(),
}));
vi.mock('@/lib/server/source-photo', () => ({ checkSourcePhoto: mocks.checkPhoto }));
vi.mock('@/lib/server/sostavista-search', () => ({ searchSostavista: mocks.sostavista }));
vi.mock('@/lib/server/regional-search', () => ({ searchRegionalSources: mocks.regional }));
vi.mock('@/lib/server/supplemental-search', () => ({
  searchSupplementalCatalogs: mocks.supplemental,
}));
vi.mock('@/lib/server/web-discovery', () => ({
  configuredWebProviders: mocks.providers,
  searchWebDiscovery: mocks.web,
  WEB_PROVIDER_IDS: ['brave', 'tavily'],
  WEB_PROVIDER_NAMES: { brave: 'Brave', tavily: 'Tavily' },
}));
const product = {
  ean: '4600699006831',
  nameRu: 'Майонез Слобода 50,5% 850 мл',
  nameRo: '',
  brand: 'Слобода',
  quantity: '850 мл',
};
const exact = {
  id: 'exact',
  title: product.nameRu,
  brand: product.brand,
  quantity: product.quantity,
  gtin: product.ean,
  gtinExact: true,
  imageUrl: 'https://shop.md/front.jpg',
  pageUrl: 'https://shop.md/item',
  source: 'Shop',
  rights: 'unknown',
  warnings: [],
};
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('DATABASE_URL', '');
  mocks.regional.mockResolvedValue({ candidates: [], diagnostics: [] });
  mocks.providers.mockReturnValue([]);
  mocks.supplemental.mockResolvedValue({ candidates: [], diagnostics: [] });
  mocks.checkPhoto.mockResolvedValue('verified');
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response('', { status: 404 })),
  );
});
it('recovers unavailable Moldova shops using only the permitted regional web reserve', async () => {
  mocks.sostavista.mockResolvedValue([]);
  mocks.providers.mockReturnValue(['tavily']);
  mocks.regional.mockResolvedValue({
    candidates: [],
    diagnostics: [
      {
        id: 'metro-md',
        source: 'METRO',
        status: 'unavailable',
        count: 0,
        elapsedMs: 5,
        message: 'HTTP 403',
      },
    ],
  });
  mocks.web.mockResolvedValue({ candidates: [exact], diagnostics: [], warnings: [] });
  const result = await searchProducts(product, { mode: 'moldova', useWeb: true, webQueryLimit: 2 });
  expect(result.outcome).toBe('found');
  expect(mocks.web).toHaveBeenCalledWith(product, 2, 'moldova', undefined, expect.any(Function));
  expect(mocks.supplemental).not.toHaveBeenCalled();
});
it('preserves the disabled-web choice even when a shop is unavailable', async () => {
  mocks.sostavista.mockResolvedValue([]);
  mocks.providers.mockReturnValue(['tavily']);
  mocks.regional.mockResolvedValue({
    candidates: [],
    diagnostics: [
      { id: 'metro-md', source: 'METRO', status: 'unavailable', count: 0, elapsedMs: 5 },
    ],
  });
  const result = await searchProducts(product, {
    mode: 'moldova',
    useWeb: false,
    webQueryLimit: 2,
  });
  expect(result.outcome).toBe('deferred');
  expect(mocks.web).not.toHaveBeenCalled();
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});
it('stops after an exact EAN match before other catalogues and web credits', async () => {
  mocks.sostavista.mockResolvedValue([exact]);
  const result = await searchProducts(product);
  expect(result.outcome).toBe('found');
  expect(fetch).not.toHaveBeenCalled();
  expect(mocks.regional).not.toHaveBeenCalled();
  expect(mocks.supplemental).not.toHaveBeenCalled();
  expect(mocks.web).not.toHaveBeenCalled();
});
it('continues searching when an exact barcode leads to a missing photograph', async () => {
  mocks.sostavista.mockResolvedValue([exact]);
  mocks.checkPhoto.mockRejectedValueOnce(new Error('Source image missing'));
  mocks.regional.mockResolvedValue({
    candidates: [{ ...exact, id: 'alternative', imageUrl: 'https://other.md/product.jpg' }],
    diagnostics: [],
  });
  const result = await searchProducts(product, {
    mode: 'moldova',
    useWeb: false,
    webQueryLimit: 1,
  });
  expect(result.coverage).toBe('partial');
  expect(result.outcome).toBe('found');
  expect(result.candidates.map((item) => item.id)).toEqual(['alternative']);
});
it('keeps conflicts on the alternative candidate without warning about a successfully matched product', async () => {
  mocks.sostavista.mockResolvedValue([
    {
      ...exact,
      id: 'conflict',
      quantity: '850 г',
      imageUrl: 'https://sostavista.ru/media/front.jpg',
    },
  ]);
  mocks.regional.mockResolvedValue({
    candidates: [exact],
    diagnostics: [
      {
        id: 'metro-md',
        source: 'METRO',
        status: 'unavailable',
        count: 0,
        elapsedMs: 5,
        message: 'HTTP 403',
      },
    ],
  });
  const result = await searchProducts(product, {
    mode: 'moldova',
    useWeb: false,
    webQueryLimit: 1,
  });
  expect(result.outcome).toBe('found');
  expect(result.warnings).toEqual([]);
  expect(result.candidates[0].matchStatus).toBe('exact');
  expect(result.candidates[1].matchStatus).toBe('metadata_conflict');
  expect(result.diagnostics?.some((d) => d.message === 'HTTP 403')).toBe(true);
});
