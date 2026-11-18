import type { Candidate } from '../types';
import { candidateId, obj, publicJson, safeUrl, str } from './catalog-utils';
import { normalizeGtin, type SearchProduct } from './validation';

/** Public barcode lookup used by the source's own scanner, without keys or LLMs. */
export async function searchSostavista(product: SearchProduct): Promise<Candidate[]> {
  if (!product.ean) return [];
  const data = obj(
    await publicJson(
      `https://sostavista.ru/api/barcode?${new URLSearchParams({ c: product.ean.replace(/[\s-]/g, '') })}`,
    ),
  );
  if (data.ok !== true || normalizeGtin(str(data.code)) !== normalizeGtin(product.ean)) return [];
  const item = obj(data.product);
  const imageUrl = safeUrl(item.image, 'https://sostavista.ru');
  const pageUrl = safeUrl(item.url, 'https://sostavista.ru');
  if (
    !imageUrl ||
    !pageUrl ||
    new URL(imageUrl).hostname !== 'sostavista.ru' ||
    new URL(pageUrl).hostname !== 'sostavista.ru' ||
    !str(item.name)
  )
    return [];
  return [
    {
      id: candidateId(imageUrl),
      title: str(item.name),
      brand: str(item.brand),
      quantity: str(item.quantity),
      gtin: str(data.code),
      gtinExact: true,
      imageUrl,
      pageUrl,
      source: 'Состависта · база EAN',
      rights: 'unknown',
      warnings: [
        'Связь фото с EAN подтверждена ответом справочника; проверьте актуальность упаковки и права использования.',
        'Фасовка в справочнике может содержать ошибку единиц; сверяйте этикетку.',
      ],
    },
  ];
}
