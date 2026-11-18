import { ApiError } from './http';
import { DEFAULT_SEARCH_OPTIONS, type SearchOptions } from '../types';
import { gtinDigits, normalizeGtin } from '../gtin';
import { isSupplierMarket } from '../search-sources';

export { normalizeGtin } from '../gtin';

export function validateSearchOptions(input: unknown): SearchOptions {
  if (input === undefined) return { ...DEFAULT_SEARCH_OPTIONS };
  if (!input || typeof input !== 'object' || Array.isArray(input))
    throw new ApiError(422, 'Некорректные параметры поиска.');
  const record = input as Record<string, unknown>;
  const {
    mode = 'expanded',
    useWeb = true,
    webQueryLimit = 4,
    useCache = true,
    market,
    marketName,
  } = record;
  if (
    !['moldova', 'expanded'].includes(String(mode)) ||
    typeof mode !== 'string' ||
    typeof useWeb !== 'boolean' ||
    ![1, 2, 4, 6].includes(webQueryLimit as number) ||
    typeof useCache !== 'boolean' ||
    (market !== undefined && !isSupplierMarket(market))
  )
    throw new ApiError(422, 'Некорректный режим или лимит поиска.');
  if (
    marketName !== undefined &&
    (mode !== 'expanded' ||
      !isSupplierMarket(market) ||
      typeof marketName !== 'string' ||
      marketName.length > 200 ||
      /[\u0000-\u001f\u007f]/.test(marketName))
  )
    throw new ApiError(
      422,
      'Для названия на языке поставщика выберите рынок и укажите до 200 символов.',
    );
  return {
    mode: mode as SearchOptions['mode'],
    useWeb,
    webQueryLimit: webQueryLimit as number,
    useCache,
    ...(isSupplierMarket(market) ? { market } : {}),
    ...(typeof marketName === 'string' && marketName.trim()
      ? { marketName: marketName.trim() }
      : {}),
  };
}

export interface SearchProduct {
  ean: string;
  nameRu: string;
  nameRo: string;
  brand: string;
  quantity: string;
}

export function validateProduct(input: unknown): SearchProduct {
  if (!input || typeof input !== 'object' || Array.isArray(input))
    throw new ApiError(422, 'Ожидаются атрибуты товара.');
  const record = input as Record<string, unknown>;
  const limits: Record<keyof SearchProduct, number> = {
    ean: 32,
    nameRu: 300,
    nameRo: 300,
    brand: 80,
    quantity: 80,
  };
  const result = {} as SearchProduct;
  for (const field of Object.keys(limits) as (keyof SearchProduct)[]) {
    const value = record[field] ?? '';
    if (
      typeof value !== 'string' ||
      value.length > limits[field] ||
      /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value)
    )
      throw new ApiError(422, `Некорректное поле ${field}.`);
    result[field] = value.trim();
  }
  if (!result.ean && !result.nameRu && !result.nameRo)
    throw new ApiError(422, 'Укажите GTIN или наименование товара.');
  if (result.ean && !normalizeGtin(result.ean))
    throw new ApiError(422, 'GTIN имеет неверную длину или контрольную цифру.');
  result.ean = gtinDigits(result.ean);
  return result;
}
