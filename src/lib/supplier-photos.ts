import { normalizeGtin } from './gtin';
import { safeFileStem } from './export';
import type { ProductRow } from './types';

const key = (value: string) => value.normalize('NFKC').trim().toLowerCase();

export function matchSupplierPhotos(rows: ProductRow[], files: File[]) {
  const index = new Map<string, Set<ProductRow>>();
  function add(value: string, row: ProductRow) {
    if (!value) return;
    let matches = index.get(value);
    if (!matches) index.set(value, (matches = new Set()));
    matches.add(row);
  }
  for (const row of rows) {
    for (const code of [row.sku, row.internalCode]) {
      if (code) {
        add(key(code), row);
        add(key(safeFileStem(code)), row);
      }
    }
    const gtin = normalizeGtin(row.ean);
    if (gtin) add(gtin, row);
  }
  const groups = new Map<ProductRow, File[]>();
  let unmatched = 0;
  let ambiguous = 0;
  for (const file of files) {
    const stem = key(file.name.replace(/\.[^.]+$/, ''));
    const matches = new Set([
      ...(index.get(stem) ?? []),
      ...(index.get(normalizeGtin(stem) ?? '') ?? []),
    ]);
    if (!matches.size) {
      unmatched++;
    } else if (matches.size > 1) {
      ambiguous++;
    } else {
      const row = matches.values().next().value!;
      groups.set(row, [...(groups.get(row) ?? []), file]);
    }
  }
  const matched: { row: ProductRow; file: File }[] = [];
  let occupied = 0;
  for (const [row, matches] of groups) {
    if (matches.length !== 1) ambiguous += matches.length;
    else if (row.originalBlob || row.status === 'searching') occupied++;
    else matched.push({ row, file: matches[0] });
  }
  return { matched, unmatched, ambiguous, occupied };
}

export async function supplierPhotoPatch(
  row: ProductRow,
  file: File,
): Promise<Partial<ProductRow>> {
  if (
    !['image/jpeg', 'image/png', 'image/webp'].includes(file.type) ||
    !file.size ||
    file.size > 4 * 1024 * 1024
  )
    throw new Error('Выберите JPG, PNG или WebP до 4 МБ.');
  const decoded = await createImageBitmap(file);
  const acceptable = decoded.width * decoded.height <= 20_000_000;
  decoded.close();
  if (!acceptable) throw new Error('Максимальный размер фото — 20 млн пикселей.');
  const id = crypto.randomUUID();
  return {
    originalBlob: file,
    outputBlob: undefined,
    candidates: [
      ...row.candidates,
      {
        id,
        title: file.name,
        imageUrl: '',
        pageUrl: '',
        source: 'Каталог поставщика',
        rights: 'unknown',
        gtinExact: false,
        warnings: ['Проверьте упаковку и права на использование фото поставщика.'],
      },
    ],
    selectedCandidateId: id,
    status: 'review',
    confirmed: false,
    rightsConfirmed: false,
    error: undefined,
    vision: undefined,
  };
}
