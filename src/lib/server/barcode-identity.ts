import { load } from 'cheerio/slim';
import { publicHtml } from './catalog-utils';
import { normalizeGtin, type SearchProduct } from './validation';

export function barcodeIdentity(html: string, ean: string): string | null {
  const $ = load(html);
  const title = $('title').text().trim();
  const match = title.match(/^(.+?)\s*[-–—]\s*Штрих-код:\s*(\d{8,14})\s*$/i);
  if (!match || normalizeGtin(match[2]) !== normalizeGtin(ean)) return null;
  return match[1].trim().slice(0, 200);
}

export async function resolveBarcodeIdentity(product: SearchProduct): Promise<SearchProduct> {
  if (
    !product.ean ||
    [product.nameRu, product.nameRo].some((name) => name && !/^Товар с EAN /i.test(name))
  )
    return product;
  const url = `https://barcode-list.ru/barcode/RU/${encodeURIComponent('Поиск')}.htm?${new URLSearchParams({ barcode: product.ean.replace(/[\s-]/g, '') })}`;
  const name = barcodeIdentity(await publicHtml(url), product.ean);
  return name ? { ...product, nameRu: name } : product;
}
