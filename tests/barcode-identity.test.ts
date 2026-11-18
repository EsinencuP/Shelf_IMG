import { expect, it } from 'vitest';
import { barcodeIdentity } from '@/lib/server/barcode-identity';
it('extracts a product name only when the page explicitly binds it to the requested EAN', () => {
  const html = '<title>Майонез Слобода Семейный 850 мл - Штрих-код: 4600699006831</title>';
  expect(barcodeIdentity(html, '4600699006831')).toBe('Майонез Слобода Семейный 850 мл');
  expect(barcodeIdentity(html, '3017620422003')).toBeNull();
  expect(
    barcodeIdentity('<title>Поиск товара</title><p>4600699006831</p>', '4600699006831'),
  ).toBeNull();
});
