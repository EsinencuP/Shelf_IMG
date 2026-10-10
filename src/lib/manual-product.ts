import { createRows, eanIssue } from './import';
import type { ImportField, ProductRow } from './types';

export type ManualProductInput = Record<ImportField, string>;

export const EMPTY_MANUAL_PRODUCT: ManualProductInput = {
  sku: '',
  internalCode: '',
  ean: '',
  nameRu: '',
  nameRo: '',
  brand: '',
  quantity: '',
  widthMm: '',
  heightMm: '',
  depthMm: '',
};

/** Uses the same product normalization as Excel, without requiring an uploaded file. */
export function createManualProduct(input: ManualProductInput): ProductRow {
  const fields = Object.keys(EMPTY_MANUAL_PRODUCT) as ImportField[];
  const values = Object.fromEntries(
    fields.map((field) => [field, input[field].trim()]),
  ) as ManualProductInput;
  if (!values.sku) throw new Error('Укажите SKU / артикул товара.');
  values.ean = values.ean.replace(/[\s-]/g, '');
  if (!values.ean && !values.nameRu && !values.nameRo) {
    throw new Error('Для поиска укажите EAN или название товара на русском либо румынском языке.');
  }
  const issue = eanIssue(values.ean);
  if (issue)
    throw new Error(
      issue
        .replace(
          'Значение сохранено без исправлений; проверьте исходную таблицу.',
          'Проверьте введённый штрихкод.',
        )
        .replace('Значение сохранено без исправлений.', ''),
    );
  for (const field of fields) {
    const limit =
      field === 'nameRu' || field === 'nameRo'
        ? 300
        : field === 'brand' || field === 'quantity'
          ? 80
          : 120;
    if (values[field].length > limit) throw new Error(`Поле ${field} слишком длинное.`);
  }
  for (const [field, label] of [
    ['widthMm', 'Ширина'],
    ['heightMm', 'Высота'],
    ['depthMm', 'Глубина'],
  ] as const) {
    if (!values[field]) continue;
    const value = Number(values[field].replace(/[\s\u00a0]/g, '').replace(',', '.'));
    if (!Number.isFinite(value) || value <= 0)
      throw new Error(`${label} должна быть положительным числом в миллиметрах.`);
  }
  // This label identifies the entered barcode, rather than inventing a catalog product name.
  if (!values.nameRu && !values.nameRo) values.nameRu = `Товар с EAN ${values.ean}`;
  const [row] = createRows(
    {
      name: 'Ручной ввод',
      headers: [
        'SKU',
        'Внутренний код',
        'EAN',
        'Наименование RU',
        'Наименование RO',
        'Бренд',
        'Объём / масса',
        'Ширина мм',
        'Высота мм',
        'Глубина мм',
      ],
      rows: [fields.map((field) => values[field])],
      warnings: [],
    },
    Object.fromEntries(fields.map((field, index) => [field, index])),
  );
  return { ...row, sourceRow: 1 };
}
