import type { Cell, CellValue } from 'exceljs';
import type { ColumnMapping, ImportField, ParsedSheet, ProductRow } from './types';
import { safeFileStem, downloadBlob } from './export';

const MAX_BYTES = 10 * 1024 * 1024;
const MAX_ROWS = 500;
const MAX_COLUMNS = 50;
type SheetDetails = ParsedSheet & { sourceRows?: number[]; rowWarnings?: Record<number, string[]>; numericIdentifiers?: Record<number, number[]> };

const aliases: Record<ImportField, string[]> = {
  sku: ['sku', 'артикул', 'sku артикул', 'код sku', 'cod sku', 'cod produs', 'product sku', 'sku code'],
  internalCode: ['внутренний код', 'код товара', 'код', 'internal code', 'internalcode', 'cod intern', 'cod', 'item code', 'product code'],
  ean: ['ean', 'ean13', 'ean 13', 'ean штрихкод', 'ean barcode', 'gtin', 'gtin13', 'gtin14', 'штрихкод', 'штрих код', 'баркод', 'barcode', 'cod de bare', 'cod bare'],
  nameRu: ['наименование', 'название', 'наименование ru', 'наименование рус', 'название ru', 'наименование на русском', 'name ru', 'name russian', 'nameru', 'denumire ru', 'denumire rusa', 'denumire rusă', 'product name', 'name'],
  nameRo: ['наименование ro', 'название ro', 'наименование на румынском', 'наименование рум', 'name ro', 'namero', 'denumire', 'denumire ro', 'denumire romana', 'denumire română', 'nume produs', 'nume'],
  brand: ['бренд', 'марка', 'brand', 'marca', 'marcă', 'producator', 'producător'],
  quantity: ['объем', 'объём', 'объем упаковки', 'вес', 'фасовка', 'quantity', 'pack size', 'volume', 'volum', 'gramaj', 'cantitate'],
  widthMm: ['ширина', 'ширина мм', 'width', 'width mm', 'widthmm', 'latime', 'latime mm', 'lățime', 'latime cm', 'ширина см'],
  heightMm: ['высота', 'высота мм', 'height', 'height mm', 'heightmm', 'inaltime', 'inaltime mm', 'înălțime', 'inaltime cm', 'высота см'],
  depthMm: ['глубина', 'глубина мм', 'depth', 'depth mm', 'depthmm', 'adancime', 'adancime mm', 'adâncime', 'adancime cm', 'глубина см'],
};

const normalize = (value: string) => value.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

/** Suggests columns only; the import screen lets the user confirm this mapping. */
export function suggestMapping(headers: string[]): ColumnMapping {
  const mapping: ColumnMapping = {};
  const used = new Set<number>();
  for (const field of Object.keys(aliases) as ImportField[]) {
    const options = aliases[field].map(normalize);
    const index = headers.findIndex((header, i) => !used.has(i) && options.includes(normalize(header)));
    if (index >= 0) { mapping[field] = index; used.add(index); }
  }
  return mapping;
}

/** Rejects excessive ZIP expansion before ExcelJS attempts to unpack an XLSX. */
function validateXlsxArchive(buffer: ArrayBuffer) {
  const bytes = new Uint8Array(buffer);
  const view = new DataView(buffer);
  let end = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--) {
    if (view.getUint32(i, true) === 0x06054b50 && i + 22 + view.getUint16(i + 20, true) === bytes.length) { end = i; break; }
  }
  if (end < 0) throw new Error('Файл XLSX повреждён: не найден каталог ZIP.');
  const count = view.getUint16(end + 10, true);
  const directorySize = view.getUint32(end + 12, true);
  let offset = view.getUint32(end + 16, true);
  if (view.getUint16(end + 4, true) || view.getUint16(end + 6, true) || count === 0xffff || count > 3000 || offset + directorySize > end) {
    throw new Error('Этот XLSX слишком сложный или использует неподдерживаемый ZIP64. Сохраните отдельный лист с товарами.');
  }
  let expandedTotal = 0;
  for (let i = 0; i < count; i++) {
    if (offset + 46 > end || view.getUint32(offset, true) !== 0x02014b50) throw new Error('Повреждён каталог XLSX.');
    const flags = view.getUint16(offset + 8, true);
    const compressed = view.getUint32(offset + 20, true);
    const expanded = view.getUint32(offset + 24, true);
    const nameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    expandedTotal += expanded;
    if (flags & 1) throw new Error('XLSX защищён паролем. Сохраните копию без пароля.');
    if (expanded === 0xffffffff || expanded > 20 * 1024 * 1024 || expandedTotal > 50 * 1024 * 1024 || (expanded > 2 * 1024 * 1024 && expanded / Math.max(compressed, 1) > 200)) {
      throw new Error('XLSX слишком велик после распаковки. Удалите изображения и лишние листы, оставив до 500 товаров.');
    }
    offset += 46 + nameLength + extraLength + commentLength;
    if (offset > end) throw new Error('Повреждён каталог XLSX.');
  }
}

function cellString(cell: Cell, warn: (text: string) => void): string {
  let value: CellValue | undefined = cell.value;
  if (value && typeof value === 'object' && ('formula' in value || 'sharedFormula' in value)) {
    warn(`Ячейка ${cell.address}: формула не вычислялась; использовано сохранённое значение Excel.`);
    value = value.result;
    if (value === undefined || value === null) { warn(`Ячейка ${cell.address}: у формулы нет сохранённого результата.`); return ''; }
  }
  if (value === null || value === undefined) return '';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) { warn(`Ячейка ${cell.address}: некорректное число.`); return ''; }
    if (!Number.isSafeInteger(value) && Number.isInteger(value) || Math.abs(value) >= 1e15) {
      warn(`Ячейка ${cell.address}: длинное число могло потерять точность в Excel. Проверьте идентификатор по оригиналу и храните его как текст.`);
    }
    const format = cell.numFmt?.split(';')[0].trim() || '';
    if (/^0+$/.test(format) && Number.isInteger(value) && value >= 0) return String(value).padStart(format.length, '0');
    return String(value);
  }
  if (typeof value === 'string') return value;
  if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE';
  if (value instanceof Date) return value.toISOString();
  if ('richText' in value) return value.richText.map(part => part.text).join('');
  if ('text' in value) return value.text;
  if ('error' in value) { warn(`Ячейка ${cell.address}: ошибка Excel ${value.error}.`); return value.error; }
  warn(`Ячейка ${cell.address}: неподдерживаемое значение.`);
  return '';
}

function csvRecords(text: string, delimiter: string): { values: string[]; line: number }[] {
  const records: { values: string[]; line: number }[] = [];
  let field = '', fields: string[] = [], quoted = false, afterQuote = false, line = 1, startLine = 1;
  const endField = () => { fields.push(field); field = ''; afterQuote = false; if (fields.length > MAX_COLUMNS) throw new Error('В файле больше 50 колонок.'); };
  const endRecord = () => { endField(); records.push({ values: fields, line: startLine }); fields = []; if (records.length > MAX_ROWS + 100) throw new Error('В CSV больше 500 товарных строк.'); };
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (quoted) {
      if (char === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else { quoted = false; afterQuote = true; } }
      else { field += char; if (char === '\n') line++; }
    } else if (char === '"') {
      if (field.trim() || afterQuote) throw new Error(`Некорректная кавычка в CSV, строка ${line}.`);
      field = ''; quoted = true;
    } else if (char === delimiter) endField();
    else if (char === '\r' || char === '\n') {
      endRecord();
      if (char === '\r' && text[i + 1] === '\n') i++;
      line++; startLine = line;
    } else if (afterQuote) {
      if (!/\s/.test(char)) throw new Error(`После закрывающей кавычки CSV ожидается разделитель, строка ${line}.`);
    } else field += char;
  }
  if (quoted) throw new Error(`Не закрыта кавычка в CSV, строка ${startLine}.`);
  if (field || fields.length || afterQuote) endRecord();
  return records;
}

function csvDelimiter(text: string) {
  text = text.replace(/^(?:[ \t]*\r?\n)+/, '');
  const counts = new Map([[';', 0], [',', 0], ['\t', 0]]);
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '"') { if (quoted && text[i + 1] === '"') i++; else quoted = !quoted; }
    else if (!quoted && /[\r\n]/.test(text[i])) break;
    else if (!quoted && counts.has(text[i])) counts.set(text[i], counts.get(text[i])! + 1);
  }
  return [...counts].sort((a, b) => b[1] - a[1])[0][0];
}

function finishSheet(name: string, records: { values: string[]; line: number }[], warnings: string[], rowWarnings: Record<number, string[]> = {}, numericIdentifiers: Record<number, number[]> = {}): SheetDetails {
  const first = records.findIndex(record => record.values.some(value => value.trim()));
  if (first < 0) throw new Error('Файл не содержит данных.');
  const rawHeaders = records[first].values;
  let width = rawHeaders.length;
  const data = records.slice(first + 1).filter(record => record.values.some(value => value.trim()));
  for (const record of data) width = Math.max(width, record.values.length);
  if (width > MAX_COLUMNS) throw new Error('В файле больше 50 колонок.');
  if (data.length > MAX_ROWS) throw new Error('В файле больше 500 товарных строк. Разделите его на несколько партий.');
  if (!data.length) throw new Error('Есть заголовки, но нет товаров.');
  const headers = Array.from({ length: width }, (_, index) => rawHeaders[index]?.trim() || `Колонка ${index + 1}`);
  if (new Set(headers.map(normalize)).size !== headers.length) warnings.push('В файле повторяются заголовки. Проверьте соответствие колонок по их позиции.');
  if (first > 0 || records[first].line > 1) warnings.push(`Заголовки прочитаны из строки ${records[first].line}.`);
  return { name, headers, rows: data.map(record => Array.from({ length: width }, (_, index) => record.values[index] ?? '')), warnings: [...new Set(warnings)], sourceRows: data.map(record => record.line), rowWarnings, numericIdentifiers };
}

/** Reads CSV or the first XLSX worksheet without executing spreadsheet formulas. */
export async function parseFile(file: File): Promise<ParsedSheet> {
  if (file.size > MAX_BYTES) throw new Error('Файл больше 10 МБ. Сохраните отдельную таблицу с товарами.');
  if (!file.size) throw new Error('Файл пуст.');
  if (/\.csv$/i.test(file.name)) {
    let text = await file.text();
    if (text.includes('\ufffd')) throw new Error('CSV содержит неверную кодировку. Сохраните его в UTF-8.');
    text = text.replace(/^\ufeff/, '');
    return finishSheet(file.name, csvRecords(text, csvDelimiter(text)), []);
  }
  if (!/\.xlsx$/i.test(file.name)) throw new Error('Поддерживаются файлы .xlsx и .csv (UTF-8).');
  const buffer = await file.arrayBuffer();
  validateXlsxArchive(buffer);
  const { default: ExcelJS } = await import('exceljs');
  const workbook = new ExcelJS.Workbook();
  try { await workbook.xlsx.load(buffer as never); }
  catch { throw new Error('Не удалось прочитать XLSX. Сохраните таблицу заново в Excel без пароля.'); }
  const worksheet = workbook.worksheets[0];
  if (!worksheet) throw new Error('XLSX не содержит листов.');
  if (worksheet.columnCount > MAX_COLUMNS || worksheet.rowCount > MAX_ROWS + 1) throw new Error('Первый лист должен содержать не больше 50 колонок и 500 строк товаров. Удалите лишнее форматирование или разделите файл.');
  const warnings: string[] = workbook.worksheets.length > 1 ? [`Прочитан только первый лист «${worksheet.name}». Остальные листы не импортированы.`] : [];
  const rowWarnings: Record<number, string[]> = {};
  const numericIdentifiers: Record<number, number[]> = {};
  const records: { values: string[]; line: number }[] = [];
  worksheet.eachRow({ includeEmpty: false }, row => {
    const warn = (message: string) => { warnings.push(message); (rowWarnings[row.number] ??= []).push(message); };
    const values = Array.from({ length: worksheet.columnCount }, (_, index) => {
      const cell = row.getCell(index + 1);
      const value = cell.value;
      const raw = value && typeof value === 'object' && ('formula' in value || 'sharedFormula' in value) ? value.result : value;
      if (typeof raw === 'number' && !/^0+$/.test(cell.numFmt?.split(';')[0].trim() || '')) (numericIdentifiers[row.number] ??= []).push(index);
      return cellString(cell, warn);
    });
    records.push({ values, line: row.number });
  });
  return finishSheet(`${file.name} · ${worksheet.name}`, records, warnings, rowWarnings, numericIdentifiers);
}

/** Returns an explanation for invalid GTIN; an empty value is permitted for name search. */
export function eanIssue(value: string): string | undefined {
  if (!value) return undefined;
  if (!/^\d+$/.test(value)) return 'EAN должен содержать только цифры. Значение сохранено без исправлений.';
  if (![8, 12, 13, 14].includes(value.length)) return 'Допустимая длина GTIN: 8, 12, 13 или 14 цифр. Значение сохранено без исправлений.';
  let sum = 0;
  for (let i = value.length - 2, weight = 3; i >= 0; i--, weight = weight === 3 ? 1 : 3) sum += Number(value[i]) * weight;
  if ((10 - sum % 10) % 10 !== Number(value.at(-1))) return 'Неверная контрольная цифра EAN. Значение сохранено без исправлений; проверьте исходную таблицу.';
  return undefined;
}

/** Creates all imported rows, preserving invalid rows and diagnostics for the report. */
export function createRows(sheet: ParsedSheet, mapping: ColumnMapping): ProductRow[] {
  if (mapping.sku === undefined || mapping.nameRu === undefined && mapping.nameRo === undefined) throw new Error('Укажите колонку SKU и хотя бы одно наименование (RU или RO).');
  for (const index of Object.values(mapping)) if (!Number.isInteger(index) || index < 0 || index >= sheet.headers.length) throw new Error('Выбрана неверная колонка. Проверьте соответствие полей.');
  const details = sheet as SheetDetails;
  const rows = sheet.rows.map((values, index): ProductRow => {
    const get = (field: ImportField) => mapping[field] === undefined ? '' : (values[mapping[field]!] ?? '').trim();
    const sourceRow = details.sourceRows?.[index] ?? index + 2;
    const qualityWarnings = [...(details.rowWarnings?.[sourceRow] ?? [])];
    for (const field of ['sku', 'internalCode', 'ean'] as const) {
      if (mapping[field] !== undefined && details.numericIdentifiers?.[sourceRow]?.includes(mapping[field]!)) qualityWarnings.push(`${field === 'ean' ? 'EAN' : field === 'sku' ? 'SKU' : 'Внутренний код'} прочитан из числовой ячейки без фиксированной маски. Начальные нули могли быть утрачены; проверьте оригинал.`);
    }
    const sku = get('sku'), nameRu = get('nameRu'), nameRo = get('nameRo'), ean = get('ean');
    const issue = eanIssue(ean);
    if (issue) qualityWarnings.push(issue);
    if (!ean) qualityWarnings.push('EAN отсутствует: доступен поиск по наименованию.');
    const dimension = (field: 'widthMm' | 'heightMm' | 'depthMm') => {
      const raw = get(field);
      if (!raw) return undefined;
      const number = Number(raw.replace(/[\s\u00a0]/g, '').replace(',', '.'));
      if (!Number.isFinite(number) || number <= 0) { qualityWarnings.push(`Размер «${sheet.headers[mapping[field]!]}» должен быть положительным числом.`); return undefined; }
      const header = normalize(sheet.headers[mapping[field]!]);
      if (/(?:\bcm\b|\bсм\b)/u.test(header) || header.includes(' см')) { qualityWarnings.push(`Размер «${sheet.headers[mapping[field]!]}» переведён из см в мм.`); return number * 10; }
      if (!header.includes('mm') && !header.includes('мм')) qualityWarnings.push(`Единицы «${sheet.headers[mapping[field]!]}» не указаны: принято мм. Проверьте размер.`);
      return number;
    };
    const missing = [!sku && 'SKU', !nameRu && !nameRo && 'наименование'].filter(Boolean);
    const internalCode = get('internalCode');
    if (sku && safeFileStem(sku) !== sku) qualityWarnings.push('SKU содержит символы, недопустимые в имени файла Windows. В ZIP имя будет безопасно преобразовано.');
    if (internalCode && safeFileStem(internalCode) !== internalCode) qualityWarnings.push('Внутренний код будет безопасно преобразован для имени файла Windows.');
    return { id: crypto.randomUUID(), sourceRow, sku, internalCode, ean, nameRu, nameRo, brand: get('brand'), quantity: get('quantity'), widthMm: dimension('widthMm'), heightMm: dimension('heightMm'), depthMm: dimension('depthMm'), status: missing.length ? 'error' : 'pending', candidates: [], qualityWarnings: [...new Set(qualityWarnings)], ...(missing.length ? { error: `Отсутствует: ${missing.join(', ')}.` } : {}) };
  });
  const groups = new Map<string, ProductRow[]>();
  for (const row of rows) if (row.sku) { const key = row.sku.normalize('NFKC').toLowerCase(); groups.set(key, [...(groups.get(key) ?? []), row]); }
  for (const group of groups.values()) if (group.length > 1) for (const row of group) row.qualityWarnings.push(`Повторяющийся SKU (строки ${group.map(item => item.sourceRow).join(', ')}). ZIP получит разные имена файлов.`);
  for (const field of ['sku', 'internalCode'] as const) {
    const names = new Map<string, ProductRow[]>();
    for (const row of rows) if (row[field]) { const key = safeFileStem(row[field]).toLowerCase(); names.set(key, [...(names.get(key) ?? []), row]); }
    for (const group of names.values()) if (group.length > 1) for (const row of group) row.qualityWarnings.push(`Совпадение имени файла по ${field === 'sku' ? 'SKU' : 'внутреннему коду'} после нормализации. При экспорте будет добавлен номер строки.`);
  }
  return rows;
}

/** Downloads an empty, text-safe import template; the second sheet explains fields. */
export async function downloadTemplate(): Promise<void> {
  const { default: ExcelJS } = await import('exceljs');
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('Товары');
  sheet.columns = [
    { header: 'SKU', key: 'sku', width: 20 }, { header: 'Внутренний код', key: 'code', width: 20 },
    { header: 'EAN', key: 'ean', width: 22 }, { header: 'Наименование RU', key: 'ru', width: 44 },
    { header: 'Наименование RO', key: 'ro', width: 44 }, { header: 'Бренд', key: 'brand', width: 22 },
    { header: 'Фасовка', key: 'quantity', width: 20 }, { header: 'Ширина мм', key: 'width', width: 16 },
    { header: 'Высота мм', key: 'height', width: 16 }, { header: 'Глубина мм', key: 'depth', width: 16 },
  ];
  for (let i = 1; i <= 3; i++) sheet.getColumn(i).numFmt = '@';
  sheet.views = [{ state: 'frozen', ySplit: 1 }];
  sheet.autoFilter = 'A1:J1';
  sheet.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
  sheet.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF192E34' } };
  const help = workbook.addWorksheet('Инструкция');
  help.columns = [{ width: 110 }];
  for (const text of ['Заполните первый лист «Товары», начиная со строки 2.', 'Обязательны SKU и хотя бы одно наименование (RU или RO). EAN можно оставить пустым.', 'SKU, внутренний код и EAN вводите как текст. Начальные нули важны; не вводите штрихкод в научной записи.', 'Все размеры указываются в миллиметрах и должны быть положительными.', 'Одна строка — одна товарная позиция. До 500 строк и 10 МБ на файл.', 'В этом шаблоне нет реальных товаров или готовых фотографий.']) help.addRow([text]);
  help.eachRow(row => { row.alignment = { wrapText: true, vertical: 'top' }; row.height = 36; });
  const buffer = await workbook.xlsx.writeBuffer();
  downloadBlob(new Blob([new Uint8Array(buffer)], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }), 'Shelf_import_template.xlsx');
}
