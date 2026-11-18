import { afterEach, expect, it, vi } from 'vitest';
import { discoverPage } from '@/lib/server/page-discovery';
import { publicGet } from '@/lib/server/public-fetch';
vi.mock('@/lib/server/public-fetch', async (original) => ({
  ...(await original<typeof import('@/lib/server/public-fetch')>()),
  publicGet: vi.fn(),
}));
vi.mock('@/lib/server/catalog-utils', async (original) => ({
  ...(await original<typeof import('@/lib/server/catalog-utils')>()),
  paced: async (_host: string, _interval: number, job: () => Promise<unknown>) => job(),
}));
const product = {
  ean: '3017620422003',
  nameRu: 'Nutella 400 г',
  nameRo: '',
  brand: 'Ferrero',
  quantity: '400g',
};
function page(status: number, quantity = '400 g') {
  vi.mocked(publicGet).mockResolvedValue({
    status,
    url: 'https://shop.md/item',
    headers: { 'content-type': 'text/html' },
    body: Buffer.from(
      '<script type="application/ld+json">' +
        JSON.stringify({
          '@type': 'Product',
          name: 'Nutella ' + quantity,
          brand: 'Ferrero',
          gtin13: product.ean,
          image: '/front.jpg',
          size: quantity,
        }) +
        '</script>',
    ),
  });
}
afterEach(() => vi.resetAllMocks());
it('extracts exact Product from SSR HTML without a browser', async () => {
  page(200);
  const r = await discoverPage('https://shop.md/item', product);
  expect(r.candidates[0].gtinExact).toBe(true);
  expect(r.rendered).toBe(false);
});
it.each([403, 429, 500])('does not retry failed HTML %s', async (status) => {
  page(status);
  expect((await discoverPage('https://shop.md/item', product)).candidates).toEqual([]);
  expect(publicGet).toHaveBeenCalledTimes(1);
});
it('preserves a quantity contradiction', async () => {
  page(200, '1 kg');
  expect((await discoverPage('https://shop.md/item', product)).conflict).toBe(true);
});
it('extracts a matching photo from Open Graph without asserting an unproven EAN', async () => {
  vi.mocked(publicGet).mockResolvedValue({
    status: 200,
    url: 'https://shop.md/item',
    headers: { 'content-type': 'text/html' },
    body: Buffer.from('<h1>Nutella 400 g</h1><meta property="og:image" content="/front.jpg">'),
  });
  const r = await discoverPage('https://shop.md/item', product);
  expect(r.candidates[0].imageUrl).toBe('https://shop.md/front.jpg');
  expect(r.candidates[0].gtinExact).toBe(false);
});
it('never extracts a generic Open Graph photo from an unrelated page', async () => {
  vi.mocked(publicGet).mockResolvedValue({
    status: 200,
    url: 'https://shop.md/item',
    headers: { 'content-type': 'text/html' },
    body: Buffer.from('<h1>Potatoes</h1><meta property="og:image" content="/front.jpg">'),
  });
  expect((await discoverPage('https://shop.md/item', product)).candidates).toEqual([]);
});
it('skips category pages before any fetch', async () => {
  expect(
    (await discoverPage('https://metro.zakaz.md/ro/categories/milk/tm=jlc/', product)).candidates,
  ).toEqual([]);
  expect(publicGet).not.toHaveBeenCalled();
});
