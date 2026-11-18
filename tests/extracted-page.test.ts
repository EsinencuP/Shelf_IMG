import { expect, it } from 'vitest';
import { extractedPageCandidates } from '../src/lib/server/extracted-page';
const product = {
  ean: '4840053000109',
  nameRu: '',
  nameRo: 'Lapte JLC 2.5% 1l',
  brand: 'JLC',
  quantity: '1l',
};
const page = {
  url: 'https://metro.zakaz.md/ro/products/lapte-jlc-1000ml-moldova--04840053000109',
  title: 'Lapte JLC 2.5% 1l',
  raw_content:
    '# Lapte JLC 2.5% 1l\n\n## Produse asemănătoare\n![Lapte JLC 0.93l](https://img1.zakaz.md/other.jpg)',
  images: [
    'https://img1.zakaz.md/front-s350x350.jpg',
    'https://img1.zakaz.md/other.jpg',
    'https://img1.zakaz.md/logo.svg',
  ],
};
it('recovers the main Zakaz photo and source GTIN, excluding recommendations and logos', () => {
  const found = extractedPageCandidates(page, product);
  expect(found).toHaveLength(1);
  expect(found[0].gtinExact).toBe(true);
  expect(found[0].matchStatus).toBe('exact');
  expect(found[0].imageUrl).toBe(page.images[0]);
});
it('rejects an extracted page for a different barcode or size', () => {
  expect(extractedPageCandidates(page, { ...product, ean: '3017620422003' })).toEqual([]);
  expect(
    extractedPageCandidates({ ...page, raw_content: '# Lapte JLC 2.5% 0.93l' }, product),
  ).toEqual([]);
});
it('rejects contradictory labelled barcode evidence', () => {
  expect(
    extractedPageCandidates(
      { ...page, raw_content: '# Lapte JLC 2.5% 1l\nEAN: 3017620422003' },
      product,
    ),
  ).toEqual([]);
});
it('requires captions for photos on a generic page without identity evidence', () => {
  const generic = {
    ...page,
    url: 'https://shop.md/milk',
    raw_content: '# Lapte JLC 2.5% 1l\n![Lapte JLC 2.5% 1l](https://shop.md/milk.jpg)',
    images: ['https://shop.md/milk.jpg', 'https://shop.md/unrelated.jpg'],
  };
  const found = extractedPageCandidates(generic, { ...product, ean: '' });
  expect(found).toHaveLength(1);
  expect(found[0].gtinExact).toBe(false);
});
it('ignores arbitrary unlabelled numbers and private image addresses', () => {
  expect(
    extractedPageCandidates(
      { ...page, url: 'https://shop.md/milk', raw_content: '# Lapte JLC 2.5% 1l\n' + product.ean },
      product,
    ),
  ).toEqual([]);
  expect(
    extractedPageCandidates({ ...page, images: ['https://127.0.0.1/photo.jpg'] }, product),
  ).toEqual([]);
});
