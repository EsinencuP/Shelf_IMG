import { ApiError } from './http';

export interface SearchProduct { ean: string; nameRu: string; nameRo: string; brand: string; quantity: string }

export function normalizeGtin(value: string): string | null {
  const digits = value.replace(/[\s-]/g, '');
  if (![8, 12, 13, 14].includes(digits.length) || !/^\d+$/.test(digits)) return null;
  let sum = 0;
  for (let i = digits.length - 2, multiplier = 3; i >= 0; i--, multiplier = multiplier === 3 ? 1 : 3) sum += Number(digits[i]) * multiplier;
  if ((10 - sum % 10) % 10 !== Number(digits.at(-1))) return null;
  return digits.padStart(14, '0');
}

export function validateProduct(input: unknown): SearchProduct {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new ApiError(422, 'Ожидаются атрибуты товара.');
  const record = input as Record<string, unknown>;
  const limits: Record<keyof SearchProduct, number> = { ean: 32, nameRu: 300, nameRo: 300, brand: 80, quantity: 80 };
  const result = {} as SearchProduct;
  for (const field of Object.keys(limits) as (keyof SearchProduct)[]) {
    const value = record[field] ?? '';
    if (typeof value !== 'string' || value.length > limits[field] || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value)) throw new ApiError(422, `Некорректное поле ${field}.`);
    result[field] = value.trim();
  }
  if (!result.ean && !result.nameRu && !result.nameRo) throw new ApiError(422, 'Укажите GTIN или наименование товара.');
  if (result.ean && !normalizeGtin(result.ean)) throw new ApiError(422, 'GTIN имеет неверную длину или контрольную цифру.');
  return result;
}
