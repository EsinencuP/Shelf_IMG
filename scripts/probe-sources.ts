import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { probeSources } from '../src/lib/server/probe-sources';
export { probeSources, REFERENCE_EANS } from '../src/lib/server/probe-sources';
export type { ProbeRow } from '../src/lib/server/probe-sources';

export async function runProbe(
  options: Parameters<typeof probeSources>[0] = {},
  outputPath = 'probe-report.json',
) {
  const report = await probeSources(options);
  console.table(
    report.results.map((row) => ({
      Источник: row.source,
      EAN: row.ean ?? '—',
      HTTP: row.httpStatus ?? '—',
      'Время, мс': row.elapsedMs,
      Изображения: row.imageCount ?? '—',
      Статус: row.status,
      Примечание: row.message ?? (row.usage ? JSON.stringify(row.usage) : ''),
    })),
  );
  await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  console.log(`Отчёт: ${resolve(outputPath)}`);
  return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  runProbe().catch(() => {
    console.error('Не удалось завершить проверку или записать probe-report.json.');
    process.exitCode = 1;
  });
}
