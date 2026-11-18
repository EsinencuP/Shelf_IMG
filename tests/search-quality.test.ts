import { expect, it } from 'vitest';
import { matchCandidate, parseQuantity } from '@/lib/server/matching';
import { catalogProducts } from '@/lib/server/catalog-utils';
const product = {
  ean: '',
  nameRo: 'Coca-Cola Original 500 ml',
  nameRu: '',
  brand: '',
  quantity: '500 ml',
};
const candidate = {
  id: 'a',
  title: 'Coca-Cola Zero 500 ml',
  imageUrl: 'https://shop.md/front.jpg',
  pageUrl: 'https://shop.md/item',
  source: 'shop',
  rights: 'unknown' as const,
  gtinExact: false,
  warnings: [],
};
it('rejects Zero as a substitute for Original', () =>
  expect(matchCandidate(product, candidate).rejected).toBe(true));
it('rejects a case of bottles as a substitute for one bottle', () => {
  expect(parseQuantity('24 x Coca-Cola 500 ml bottles pack of 24')?.count).toBe(24);
  expect(
    matchCandidate(product, {
      ...candidate,
      title: '24 x Coca-Cola Original 500 ml bottles pack of 24',
    }).rejected,
  ).toBe(true);
});
it('omits social icons erroneously included in Product image arrays', () => {
  const html =
    '<script type="application/ld+json">' +
    JSON.stringify({
      '@type': 'Product',
      name: 'Coca-Cola 500 ml',
      image: ['/front.jpg', '/instagram.png', '/facebook.png'],
    }) +
    '</script>';
  expect(
    catalogProducts(html, 'https://shop.md/item', product, true).map((c) => c.imageUrl),
  ).toEqual(['https://shop.md/front.jpg']);
});
it('rejects a conflicting volume exposed only in the product URL', () => {
  expect(
    matchCandidate(
      { ...product, quantity: '850 ml' },
      {
        ...candidate,
        title: 'Майонез Слобода Семейный',
        pageUrl: 'https://shop.md/product/sloboda-800ml-123/',
      },
    ).rejected,
  ).toBe(true);
});

const mayonnaise = {
  ean: '4600699006831',
  nameRu: 'Майонез Слобода Семейный 50,5% 850 мл',
  nameRo: '',
  brand: 'Слобода',
  quantity: '850 мл',
};
const contradictory = {
  ...candidate,
  title: 'Майонез «Слобода» Провансаль Семейный 50,5% 850 мл',
  quantity: '850 г',
  brand: 'Слобода',
  gtin: mayonnaise.ean,
  gtinExact: true,
};
it('retains the reported Sloboda barcode with contradictory units for visual review', () => {
  const result = matchCandidate(mayonnaise, contradictory);
  expect(result.rejected).toBe(false);
  expect(result.candidate.matchStatus).toBe('metadata_conflict');
  expect(result.candidate.matchReasons?.join(' ')).toContain('противоречит');
});
it('still rejects another size, another EAN and unverified contradictory metadata', () => {
  expect(
    matchCandidate(mayonnaise, {
      ...contradictory,
      title: 'Майонез Слобода 50,5% 800 мл',
      quantity: '800 мл',
    }).rejected,
  ).toBe(true);
  expect(matchCandidate(mayonnaise, { ...contradictory, gtin: '3017620422003' }).rejected).toBe(
    true,
  );
  expect(matchCandidate(mayonnaise, { ...contradictory, gtinExact: false }).rejected).toBe(true);
});
