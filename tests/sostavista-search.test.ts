import { afterEach, expect, it, vi } from 'vitest';
import { searchSostavista } from '@/lib/server/sostavista-search';
import { publicJson } from '@/lib/server/catalog-utils';
vi.mock('@/lib/server/catalog-utils', async (original) => ({
  ...(await original<typeof import('@/lib/server/catalog-utils')>()),
  publicJson: vi.fn(),
}));
afterEach(() => vi.resetAllMocks());
const product = { ean: '4600699006831', nameRu: '', nameRo: '', brand: '', quantity: '' };
it('binds photos only to the exact barcode returned by the public scanner API', async () => {
  vi.mocked(publicJson).mockResolvedValue({
    ok: true,
    code: product.ean,
    product: {
      name: 'Майонез Слобода 850 мл',
      image: '/media/front.jpg',
      url: '/tovar/item',
      quantity: '850 г',
    },
  });
  const result = await searchSostavista(product);
  expect(result[0]).toMatchObject({
    gtinExact: true,
    gtin: product.ean,
    imageUrl: 'https://sostavista.ru/media/front.jpg',
    quantity: '850 г',
  });
  vi.mocked(publicJson).mockResolvedValue({
    ok: true,
    code: '3017620422003',
    product: { name: 'Other', image: '/media/front.jpg', url: '/tovar/item' },
  });
  expect(await searchSostavista(product)).toEqual([]);
});
