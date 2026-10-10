import { describe, expect, it } from 'vitest';
import { createManualProduct, EMPTY_MANUAL_PRODUCT } from '@/lib/manual-product';

describe('manual single-product input', () => {
  it('preserves text identifiers and normalizes optional dimensions without a spreadsheet', () => {
    const row = createManualProduct({
      ...EMPTY_MANUAL_PRODUCT,
      sku: ' 00123 ',
      internalCode: '00009',
      nameRo: 'Sticla 500 ml',
      brand: 'Brand',
      quantity: '500 ml',
      widthMm: '70,5',
      heightMm: '205',
    });
    expect(row).toMatchObject({
      sku: '00123',
      internalCode: '00009',
      nameRo: 'Sticla 500 ml',
      widthMm: 70.5,
      heightMm: 205,
      sourceRow: 1,
      status: 'pending',
    });
    expect(row.depthMm).toBeUndefined();
  });
  it('accepts a valid EAN alone and retains leading zeros', () => {
    const row = createManualProduct({
      ...EMPTY_MANUAL_PRODUCT,
      sku: 'EAN-ONLY',
      ean: '00012345600012',
    });
    expect(row.ean).toBe('00012345600012');
    expect(row.nameRu).toBe('Товар с EAN 00012345600012');
    expect(row.status).toBe('pending');
  });
  it('rejects missing search evidence, invalid EAN and nonpositive dimensions', () => {
    expect(() => createManualProduct({ ...EMPTY_MANUAL_PRODUCT, sku: 'SKU-ONLY' })).toThrow(
      'Для поиска',
    );
    expect(() =>
      createManualProduct({ ...EMPTY_MANUAL_PRODUCT, sku: 'SKU-ONLY', ean: ' -- ' }),
    ).toThrow('Для поиска');
    expect(() =>
      createManualProduct({ ...EMPTY_MANUAL_PRODUCT, sku: 'SKU', ean: '3017620422004' }),
    ).toThrow('контрольная');
    expect(() =>
      createManualProduct({ ...EMPTY_MANUAL_PRODUCT, sku: 'SKU', nameRu: 'Вода', widthMm: '-10' }),
    ).toThrow('положительным');
  });
});
