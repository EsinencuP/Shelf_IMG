import { describe, expect, it } from 'vitest';
import ExcelJS from 'exceljs';
import JSZip from 'jszip';
import { createRows, eanIssue, parseFile, suggestMapping } from '../src/lib/import';
import { buildExportArchive, safeFileStem } from '../src/lib/export';
import { DEFAULT_PROFILE, type Batch } from '../src/lib/types';

describe('Excel and CSV import', () => {
  it('reads quoted semicolon CSV, embedded newlines and leading-zero GTIN', async () => {
    const file = new File(
      ['SKU;EAN;Denumire;Ширина мм\r\n"A;1";"00012345600012";"Suc ""roșu""\n250 ml";42,5\r\n'],
      'products.csv',
    );
    const sheet = await parseFile(file);
    const mapping = suggestMapping(sheet.headers);
    expect(mapping).toEqual({ sku: 0, ean: 1, nameRo: 2, widthMm: 3 });
    const rows = createRows(sheet, mapping);
    expect(rows[0]).toMatchObject({
      sku: 'A;1',
      ean: '00012345600012',
      nameRo: 'Suc "roșu"\n250 ml',
      widthMm: 42.5,
      sourceRow: 2,
    });
  });

  it('keeps Excel numeric zero masks, only cached formula values, and unsafe-number diagnostics', async () => {
    const workbook = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet('Товары');
    worksheet.addRow(['SKU', 'EAN', 'Наименование RU']);
    worksheet.addRow(['A', 12345600012, { formula: '"Сок"', result: 'Сок' }]);
    worksheet.getCell('B2').numFmt = '00000000000000';
    worksheet.addRow(['B', 1234567890123456, 'Вода']);
    const sheet = await parseFile(
      new File([new Uint8Array(await workbook.xlsx.writeBuffer())], 'products.xlsx'),
    );
    expect(sheet.rows[0][1]).toBe('00012345600012');
    expect(sheet.rows[0][2]).toBe('Сок');
    expect(sheet.warnings.some((message) => message.includes('формула не вычислялась'))).toBe(true);
    const rows = createRows(sheet, suggestMapping(sheet.headers));
    expect(rows[1].qualityWarnings.some((message) => message.includes('потерять точность'))).toBe(
      true,
    );
    expect(rows[1].qualityWarnings.some((message) => message.includes('Начальные нули'))).toBe(
      true,
    );
    expect(rows[0].qualityWarnings.some((message) => message.includes('формула'))).toBe(true);
  });

  it('retains missing and duplicate SKU rows and diagnoses EAN rather than replacing it', () => {
    const rows = createRows(
      {
        name: 'test',
        headers: ['SKU', 'EAN', 'Наименование'],
        rows: [
          ['same', '123', 'Сок'],
          ['SAME', '', 'Вода'],
          ['', '4006381333931', 'Товар'],
        ],
        warnings: [],
      },
      { sku: 0, ean: 1, nameRu: 2 },
    );
    expect(rows).toHaveLength(3);
    expect(rows[0].ean).toBe('123');
    expect(rows[0].qualityWarnings.some((message) => message.includes('длина'))).toBe(true);
    expect(rows[1].qualityWarnings.some((message) => message.includes('Повторяющийся SKU'))).toBe(
      true,
    );
    expect(rows[2].status).toBe('error');
    expect(eanIssue('4006381333931')).toBeUndefined();
    expect(eanIssue('4006381333932')).toContain('контрольная');
    expect(eanIssue('4.00638E+12')).toContain('только цифры');
    expect(() =>
      createRows({ name: 'test', headers: ['SKU'], rows: [['A']], warnings: [] }, { sku: 0 }),
    ).toThrow('наименование');
  });

  it('permits disabling suggested optional columns in the mapping dialog', () => {
    const rows = createRows(
      {
        name: 'test',
        headers: ['SKU', 'EAN', 'Наименование'],
        rows: [['A', '4006381333931', 'Сок']],
        warnings: [],
      },
      { sku: 0, nameRu: 2, ean: undefined, nameRo: undefined },
    );
    expect(rows[0]).toMatchObject({ sku: 'A', ean: '', nameRu: 'Сок', status: 'pending' });
  });

  it('rejects oversized input, too many columns, rows and broken quoting', async () => {
    const oversized = { name: 'products.csv', size: 10 * 1024 * 1024 + 1 } as File;
    await expect(parseFile(oversized)).rejects.toThrow('10 МБ');
    await expect(
      parseFile(
        new File([Array.from({ length: 51 }, (_, i) => `C${i}`).join(',') + '\nrow'], 'bad.csv'),
      ),
    ).rejects.toThrow('50 колонок');
    await expect(
      parseFile(new File(['SKU,Name\n' + 'A,Product\n'.repeat(501)], 'bad.csv')),
    ).rejects.toThrow('500');
    await expect(parseFile(new File(['SKU,Name\nA,"broken'], 'bad.csv'))).rejects.toThrow(
      'кавычка',
    );
  });

  it('rejects ZIP expansion bombs before ExcelJS reads the workbook', async () => {
    const zip = new JSZip();
    zip.file('xl/worksheets/sheet1.xml', 'A'.repeat(3 * 1024 * 1024));
    const archive = await zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' });
    await expect(parseFile(new File([new Uint8Array(archive)], 'bomb.xlsx'))).rejects.toThrow(
      'после распаковки',
    );
  });
});

describe('Auditable export', () => {
  it('uses SKU for missing internal codes and records the naming fallback', async () => {
    const rows = createRows(
      { name: 'test', headers: ['SKU', 'Название'], rows: [['SKU-1', 'Товар']], warnings: [] },
      { sku: 0, nameRu: 1 },
    );
    Object.assign(rows[0], {
      status: 'ready',
      confirmed: true,
      rightsConfirmed: true,
      outputBlob: new Blob([new Uint8Array([0xff, 0xd8, 0xff, 0xd9])], { type: 'image/jpeg' }),
    });
    const batch: Batch = {
      id: 'fallback',
      name: 'Партия',
      createdAt: new Date().toISOString(),
      rows,
      profile: { ...DEFAULT_PROFILE, naming: 'internalCode' },
    };
    const zip = await JSZip.loadAsync(await (await buildExportArchive(batch)).arrayBuffer());
    expect(zip.file('images/SKU-1.jpg')).not.toBeNull();
    const manifest = JSON.parse(await zip.file('manifest.json')!.async('string'));
    expect(manifest.rows[0]).toMatchObject({
      internalCode: '',
      requestedFilename: 'SKU-1',
      namingFallback: true,
      exported: true,
    });
    expect(manifest.rows[0].warnings).toContain(
      'Внутренний код отсутствует; имя файла взято из SKU.',
    );
  });

  it('exports only approved JPEGs, handles Windows collisions, and reports every source row', async () => {
    const rows = createRows(
      {
        name: 'test',
        headers: ['SKU', 'EAN', 'Название'],
        rows: [
          ['CON', '00012345600012', 'Сок'],
          ['con', '', 'Вода'],
          ['other', '', 'Не найдено'],
          ['no-rights', '', 'Товар'],
        ],
        warnings: [],
      },
      { sku: 0, ean: 1, nameRu: 2 },
    );
    for (const row of [rows[0], rows[1], rows[3]]) {
      row.status = 'ready';
      row.confirmed = true;
      row.rightsConfirmed = true;
      row.outputBlob = new Blob([new Uint8Array([0xff, 0xd8, 0xff, 0xd9])], { type: 'image/jpeg' });
    }
    rows[2].status = 'not_found';
    rows[3].rightsConfirmed = false;
    const batch: Batch = {
      id: 'batch',
      name: 'Партия',
      createdAt: new Date().toISOString(),
      rows,
      profile: DEFAULT_PROFILE,
    };
    const zip = await JSZip.loadAsync(await (await buildExportArchive(batch)).arrayBuffer());
    const images = Object.keys(zip.files).filter((name) => name.endsWith('.jpg'));
    expect(images).toHaveLength(2);
    expect(new Set(images.map((name) => name.toLowerCase())).size).toBe(2);
    expect(images.every((name) => !name.toLowerCase().match(/\/con\.jpg$/))).toBe(true);
    const manifest = JSON.parse(await zip.file('manifest.json')!.async('string'));
    expect(manifest.rows).toHaveLength(4);
    expect(manifest.exportedImages).toBe(2);
    expect(manifest.rows[2]).toMatchObject({ sourceRow: 4, exported: false, fileName: null });
    expect(manifest.rows[3].exclusionReason).toContain('Право');
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load((await zip.file('report.xlsx')!.async('nodebuffer')) as never);
    expect(workbook.worksheets[0].rowCount).toBe(5);
    expect(workbook.worksheets[0].getCell('D2').value).toBe('00012345600012');
    expect(await zip.file('attributions.txt')!.async('string')).toContain('Строка 5');
    expect(safeFileStem('a/b:*?')).toBe('a_b___');
  });
});
