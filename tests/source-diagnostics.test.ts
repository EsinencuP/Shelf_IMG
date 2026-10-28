import { afterEach, expect, it, vi } from 'vitest';
import { searchRegionalSources } from '@/lib/server/regional-search';
import { publicJson, publicHtml, catalogProducts } from '@/lib/server/catalog-utils';
import { ApiError } from '@/lib/server/http';
vi.mock('@/lib/server/catalog-utils', async (original) => ({
  ...(await original<object>()),
  publicJson: vi.fn(),
  publicHtml: vi.fn(),
  catalogProducts: vi.fn(),
}));
const product = {
  ean: '3017620422003',
  nameRu: 'Nutella 400g',
  nameRo: '',
  brand: 'Ferrero',
  quantity: '400g',
};
afterEach(() => vi.resetAllMocks());

it.each([
  [new ApiError(502, 'Источник ответил HTTP 403.'), 'blocked'],
  [new ApiError(429, 'Квота исчерпана.'), 'quota'],
  [new ApiError(504, 'Источник не ответил вовремя.'), 'timeout'],
  [new ApiError(502, 'Некорректная выдача.'), 'parse_error'],
] as const)('reports the actual catalog failure instead of empty (%s)', async (error, status) => {
  vi.mocked(publicJson).mockRejectedValue(error);
  vi.mocked(publicHtml).mockResolvedValue('<html></html>');
  const response = await searchRegionalSources(product, 'moldova');
  expect(response.diagnostics.find((row) => row.id === 'metro-md')).toMatchObject({
    status,
    reason: error.message,
    count: 0,
  });
  expect(response.diagnostics.every((row) => !!row.reason)).toBe(true);
});

it('retains successful photos and the failure when another Linella card fails', async () => {
  vi.mocked(publicJson).mockResolvedValue({ results: [] });
  vi.mocked(publicHtml).mockImplementation(async (url) => {
    if (url.includes('?'))
      return '<html><a class="product-title" href="/one/">Nutella 400g</a><a class="product-title" href="/two/">Nutella 400g</a></html>';
    if (url.endsWith('/two/')) throw new ApiError(429, 'Квота карточек исчерпана.');
    return '<html>Product</html>';
  });
  vi.mocked(catalogProducts).mockReturnValue([
    {
      id: 'photo',
      title: product.nameRu,
      imageUrl: 'https://linella.md/photo.jpg',
      pageUrl: 'https://linella.md/one/',
      source: 'Linella',
      rights: 'unknown',
      gtinExact: true,
      gtin: product.ean,
      warnings: [],
    },
  ]);
  const response = await searchRegionalSources(product, 'moldova');
  expect(response.candidates).toHaveLength(1);
  expect(response.diagnostics.find((row) => row.id === 'linella')).toMatchObject({
    status: 'quota',
    count: 1,
    reason: 'Квота карточек исчерпана.',
  });
});
