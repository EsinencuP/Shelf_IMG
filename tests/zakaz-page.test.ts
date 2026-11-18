import { expect, it } from 'vitest';
import { zakazPageEvidence } from '../src/lib/server/zakaz-page';
const ean = '4840053000109';
const page = 'https://metro.zakaz.md/ro/products/lapte-jlc-1000ml-moldova--04840053000109/';
const product = { ean, nameRu: '', nameRo: 'Lapte JLC 2.5% 1l', brand: 'JLC', quantity: '1l' };
const main = {
  ean: '0' + ean,
  title: 'Lapte JLC 2.5% 1l',
  web_url: page,
  producer: { trademark: 'JLC', name: 'JLC Group' },
  img: {
    s1350x1350: 'https://img1.zakaz.md/98f3eea0d4f44065b0fda29bd5cf5a39/1753674045-s1350x1350.jpg',
  },
};
function html(item: unknown, extras: unknown = {}) {
  return (
    '<h1>Ne pare rău, această pagină nu a fost găsită</h1><meta property="og:image" content="https://shop.md/logo.jpg"><script id="__NEXT_DATA__" type="application/json">' +
    JSON.stringify({
      props: {
        initialState: { product: { productData: { product: item }, recommendations: extras } },
      },
    }) +
    '</script>'
  );
}
it('recovers only the main hydrated product despite a rendered error page and unrelated recommendations', () => {
  const result = zakazPageEvidence(
    html(main, [
      { ...main, ean: '4840053000444', img: { s1350x1350: 'https://shop.md/wrong.jpg' } },
    ]),
    page,
    product,
  );
  expect(result.conflict).toBe(false);
  expect(result.candidates).toHaveLength(1);
  expect(result.candidates[0]).toMatchObject({
    gtin: '0' + ean,
    gtinExact: true,
    imageUrl: main.img.s1350x1350,
    source: 'METRO Moldova',
  });
});
it.each([
  { ...main, ean: '4840053000444' },
  {
    ...main,
    web_url: 'https://bonus.zakaz.md/ro/products/lapte-jlc-1000ml-moldova--04840053000109/',
  },
  { ...main, web_url: page.replace('lapte-jlc', 'another') },
  { ...main, title: 'Lapte JLC 3.5% 1l' },
  { ...main, title: 'Lapte JLC 2.5% 500ml' },
  { ...main, producer: { trademark: 'Lactis', name: 'Lactis' } },
])('rejects hydration conflicting with the actual route or requested identity', (item) => {
  const result = zakazPageEvidence(html(item), page, product);
  expect(result.candidates).toHaveLength(0);
  expect(result.conflict).toBe(true);
});
it('ignores main records on other sites and never uses a recommendation when the main product is absent', () => {
  expect(
    zakazPageEvidence(html(main), page.replace('metro.zakaz.md', 'shop.md'), product).candidates,
  ).toEqual([]);
  expect(zakazPageEvidence(html(null, [main]), page, product).candidates).toEqual([]);
  expect(
    zakazPageEvidence(
      '<script id="__NEXT_DATA__" type="application/json">broken</script>',
      page,
      product,
    ).candidates,
  ).toEqual([]);
});
it('keeps conflicting labelled volume visible for human review despite an exact GTIN and matching title', () => {
  const result = zakazPageEvidence(
    html({ ...main, taxons: [{ type: 'volume-capacity', name: '500ml' }] }),
    page,
    product,
  );
  expect(result.candidates[0]).toMatchObject({
    gtinExact: true,
    matchStatus: 'metadata_conflict',
    quantity: '500ml',
  });
});
