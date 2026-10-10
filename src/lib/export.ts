import type { Batch, ProductRow } from './types';
import { STATUS_LABELS } from './types';
import { DEFAULT_SEARCH_OPTIONS } from './types';

/** Makes a single Windows-safe stem without inventing a SKU. */
export function safeFileStem(value: string): string {
  let stem = value
    .normalize('NFKC')
    .replace(/[<>:"/\\|?*\u0000-\u001f\u007f]/g, '_')
    .replace(/[. ]+$/g, '')
    .trim()
    .slice(0, 100)
    .replace(/[. ]+$/g, '');
  if (!stem || /^\.+$/.test(stem)) stem = 'unnamed';
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(stem)) stem = `_${stem}`;
  return stem;
}

export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

function assignNames(batch: Batch) {
  const used = new Set<string>();
  return batch.rows.map((row) => {
    const namingFallback = batch.profile.naming === 'internalCode' && !row.internalCode.trim();
    const requested =
      batch.profile.naming === 'internalCode' ? row.internalCode.trim() || row.sku : row.sku;
    const base = safeFileStem(requested || `row_${row.sourceRow}`);
    let stem = base,
      suffix = 1;
    while (used.has(stem.toLowerCase())) {
      stem = `${base}_row${row.sourceRow}${suffix > 1 ? `_${suffix}` : ''}`;
      suffix++;
    }
    used.add(stem.toLowerCase());
    return { requested, stem, changed: stem !== requested, namingFallback };
  });
}

function exclusionReason(row: ProductRow): string | undefined {
  if (row.status !== 'ready') return `Статус: ${STATUS_LABELS[row.status]}`;
  if (row.vision?.verdict === 'conflict')
    return 'Проверка изображения обнаружила конфликт атрибутов товара';
  if (!row.confirmed) return 'Соответствие товара не подтверждено';
  if (!row.rightsConfirmed) return 'Право использования не подтверждено';
  if (!row.outputBlob?.size) return 'Готовое изображение отсутствует';
  return undefined;
}

/** Builds an auditable ZIP. Every source row is reported; only approved JPEGs enter images/. */
export async function buildExportArchive(batch: Batch): Promise<Blob> {
  const [{ default: JSZip }, { default: ExcelJS }] = await Promise.all([
    import('jszip'),
    import('exceljs'),
  ]);
  const zip = new JSZip();
  const names = assignNames(batch);
  const manifestRows = [];
  for (const [index, row] of batch.rows.entries()) {
    const candidate = row.candidates.find((item) => item.id === row.selectedCandidateId);
    let reason = exclusionReason(row);
    if (!reason && !names[index].requested.trim())
      reason = 'Отсутствует SKU или внутренний код для выбранного имени файла';
    let bytes: Uint8Array | undefined;
    if (!reason) {
      bytes = new Uint8Array(await row.outputBlob!.arrayBuffer());
      if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes[2] !== 0xff)
        reason = 'Готовый файл не является JPEG. Повторите обработку.';
    }
    const filename = reason ? null : `images/${names[index].stem}.jpg`;
    if (filename && bytes) zip.file(filename, bytes);
    manifestRows.push({
      rowId: row.id,
      sourceRow: row.sourceRow,
      sku: row.sku,
      internalCode: row.internalCode,
      ean: row.ean,
      nameRu: row.nameRu,
      nameRo: row.nameRo,
      brand: row.brand,
      quantity: row.quantity,
      widthMm: row.widthMm ?? null,
      heightMm: row.heightMm ?? null,
      depthMm: row.depthMm ?? null,
      status: row.status,
      confirmed: Boolean(row.confirmed),
      rightsConfirmed: Boolean(row.rightsConfirmed),
      requestedFilename: names[index].requested,
      filenameChanged: names[index].changed,
      namingFallback: names[index].namingFallback,
      fileName: filename,
      exported: !reason,
      exclusionReason: reason ?? null,
      imageWidthPx: row.outputWidth ?? null,
      imageHeightPx: row.outputHeight ?? null,
      processingMethod: row.processingMethod ?? null,
      processingOverride: row.processingOverride ?? null,
      vision: row.vision ?? null,
      searchDiagnostics: row.searchDiagnostics ?? [],
      searchOptions: row.lastSearchOptions ?? null,
      selectedCandidateId: row.selectedCandidateId ?? null,
      candidates: row.candidates.map((item) => ({
        id: item.id,
        title: item.title,
        provider: item.source,
        pageUrl: item.pageUrl,
        imageUrl: item.imageUrl,
        gtin: item.gtin ?? null,
        rights: item.rights,
        license: item.license ?? null,
        warnings: item.warnings,
      })),
      source: candidate
        ? {
            title: candidate.title,
            provider: candidate.source,
            pageUrl: candidate.pageUrl,
            imageUrl: candidate.imageUrl,
            gtin: candidate.gtin ?? null,
            rights: candidate.rights,
            license: candidate.license ?? null,
            warnings: candidate.warnings,
          }
        : null,
      warnings: [
        ...new Set([
          ...(row.inputWarnings ?? []),
          ...row.qualityWarnings,
          ...(candidate?.warnings ?? []),
          ...(names[index].namingFallback
            ? ['Внутренний код отсутствует; имя файла взято из SKU.']
            : []),
          ...(names[index].changed
            ? ['Имя файла изменено для совместимости с Windows и предотвращения совпадений.']
            : []),
        ]),
      ],
      error: row.error ?? null,
    });
  }
  const manifest = {
    version: 1,
    batchId: batch.id,
    batchName: batch.name,
    createdAt: batch.createdAt,
    exportedAt: new Date().toISOString(),
    profile: batch.profile,
    searchOptions: batch.searchOptions ?? DEFAULT_SEARCH_OPTIONS,
    totalRows: batch.rows.length,
    exportedImages: manifestRows.filter((row) => row.exported).length,
    rows: manifestRows,
  };
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'Shelf Image Studio';
  const report = workbook.addWorksheet('Отчёт');
  report.columns = [
    { header: 'Исходная строка', key: 'sourceRow', width: 18 },
    { header: 'SKU', key: 'sku', width: 22 },
    { header: 'Внутренний код', key: 'internalCode', width: 22 },
    { header: 'EAN', key: 'ean', width: 22 },
    { header: 'Наименование RU', key: 'nameRu', width: 40 },
    { header: 'Наименование RO', key: 'nameRo', width: 40 },
    { header: 'Бренд', key: 'brand', width: 22 },
    { header: 'Фасовка', key: 'quantity', width: 18 },
    { header: 'Статус', key: 'statusLabel', width: 22 },
    { header: 'Экспортирован', key: 'exportedLabel', width: 18 },
    { header: 'Файл в ZIP', key: 'fileName', width: 36 },
    { header: 'Причина исключения', key: 'exclusionReason', width: 42 },
    { header: 'Товар подтверждён', key: 'confirmedLabel', width: 22 },
    { header: 'Права подтверждены', key: 'rightsConfirmedLabel', width: 22 },
    { header: 'Ширина мм', key: 'widthMm', width: 15 },
    { header: 'Высота мм', key: 'heightMm', width: 15 },
    { header: 'Глубина мм', key: 'depthMm', width: 15 },
    { header: 'Ширина px', key: 'imageWidthPx', width: 15 },
    { header: 'Высота px', key: 'imageHeightPx', width: 15 },
    { header: 'Метод обработки', key: 'processingMethod', width: 26 },
    { header: 'Источник', key: 'provider', width: 22 },
    { header: 'Страница товара', key: 'pageUrl', width: 55 },
    { header: 'URL изображения', key: 'imageUrl', width: 55 },
    { header: 'Права источника', key: 'rights', width: 22 },
    { header: 'Лицензия', key: 'license', width: 45 },
    { header: 'Найдено кандидатов', key: 'candidateCount', width: 22 },
    { header: 'Страницы кандидатов', key: 'candidatePages', width: 55 },
    { header: 'Предупреждения', key: 'warningsText', width: 65 },
    { header: 'Ошибка', key: 'error', width: 45 },
  ];
  for (const row of manifestRows)
    report.addRow({
      ...row,
      statusLabel: STATUS_LABELS[row.status],
      exportedLabel: row.exported ? 'Да' : 'Нет',
      confirmedLabel: row.confirmed ? 'Да' : 'Нет',
      rightsConfirmedLabel: row.rightsConfirmed ? 'Да' : 'Нет',
      provider: row.source?.provider ?? '',
      pageUrl: row.source?.pageUrl ?? '',
      imageUrl: row.source?.imageUrl ?? '',
      rights: row.source?.rights ?? '',
      license: row.source?.license ?? '',
      candidateCount: row.candidates.length,
      candidatePages: [...new Set(row.candidates.map((candidate) => candidate.pageUrl))]
        .filter(Boolean)
        .join('\n'),
      warningsText: row.warnings.join('\n'),
    });
  for (const key of ['sku', 'internalCode', 'ean']) report.getColumn(key).numFmt = '@';
  report.views = [{ state: 'frozen', ySplit: 1, xSplit: 2 }];
  report.autoFilter = {
    from: { row: 1, column: 1 },
    to: { row: batch.rows.length + 1, column: report.columns.length },
  };
  report.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
  report.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF192E34' } };
  report.getRow(1).height = 32;
  report.eachRow((row) => {
    row.alignment = { vertical: 'top', wrapText: true };
    if (row.number > 1) row.height = 44;
  });
  zip.file('report.xlsx', new Uint8Array(await workbook.xlsx.writeBuffer()));
  zip.file('manifest.json', JSON.stringify(manifest, null, 2));
  const attributions = manifestRows
    .map(
      (row) =>
        `Строка ${row.sourceRow} · SKU ${row.sku || '(пусто)'}\nФайл: ${row.fileName ?? '(не экспортирован)'}\nСтраница: ${row.source?.pageUrl || '(не указана)'}\nИзображение: ${row.source?.imageUrl || '(не указано)'}\nПрава источника: ${row.source?.rights ?? 'не указаны'}\nЛицензия: ${row.source?.license ?? 'не указана'}\nПодтверждение прав пользователем: ${row.rightsConfirmed ? 'да' : 'нет'}\nПричина исключения: ${row.exclusionReason ?? '—'}\n`,
    )
    .join('\n');
  zip.file(
    'attributions.txt',
    `Shelf Image Studio\nПартия: ${batch.name}\nПодтверждение пользователя фиксирует его решение и не создаёт лицензию на фотографию.\n\n${attributions}`,
  );
  const archive = await zip.generateAsync({
    type: 'uint8array',
    compression: 'DEFLATE',
    compressionOptions: { level: 6 },
  });
  return new Blob([archive as BlobPart], { type: 'application/zip' });
}

export async function exportBatch(batch: Batch): Promise<void> {
  const archive = await buildExportArchive(batch);
  downloadBlob(archive, `${safeFileStem(batch.name)}_Shelf.zip`);
}
