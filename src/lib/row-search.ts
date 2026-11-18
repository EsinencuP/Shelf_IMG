import { eanIssue, gtinDigits, normalizeGtin } from './gtin';
import type { ProductRow } from './types';

type Identity = Pick<ProductRow, 'sku' | 'ean' | 'nameRu' | 'nameRo'>;
type RowInput = Identity & Partial<Pick<ProductRow, 'brand' | 'quantity'>>;

export function rowSearchError(
  { sku, ean, nameRu, nameRo, brand = '', quantity = '' }: RowInput,
  byName = false,
): string | undefined {
  if (!sku.trim()) return 'Отсутствует SKU.';
  if (!byName) {
    const issue = eanIssue(ean);
    if (issue) return issue;
  }
  if ((!ean || byName) && !nameRu.trim() && !nameRo.trim())
    return 'Укажите корректный GTIN или наименование RU/RO.';
  for (const [label, value, limit] of [
    ['Наименование RU', nameRu, 300],
    ['Наименование RO', nameRo, 300],
    ['Бренд', brand, 80],
    ['Фасовка', quantity, 80],
  ] as const)
    if (value.length > limit || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value))
      return `Проверьте поле «${label}». Допустимо до ${limit} символов.`;
}

export function canSearchByName(row: RowInput): boolean {
  return !!eanIssue(row.ean) && !rowSearchError(row, true);
}

export function rowSearchProduct(row: ProductRow, byName = row.searchByName === true) {
  const { ean, nameRu, nameRo, brand, quantity } = row;
  return { ean: byName ? '' : gtinDigits(ean), nameRu, nameRo, brand, quantity };
}

export function rowTitle({ ean, nameRu, nameRo }: Identity): string {
  return nameRu || nameRo || (normalizeGtin(ean) ? `Товар с EAN ${ean}` : '');
}
