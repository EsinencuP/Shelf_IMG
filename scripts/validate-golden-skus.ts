import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { validateGoldenSkus } from '../tests/fixtures/validate-golden-skus';

export function runGoldenValidation(args = process.argv.slice(2)): number {
  const draft = args.includes('--draft');
  const paths = args.filter((arg) => arg !== '--draft');
  if (paths.length > 1 || paths.some((arg) => arg.startsWith('-'))) {
    console.error('Использование: npm run golden:validate -- [--draft] [путь.json]');
    return 2;
  }
  const path =
    paths[0] ?? fileURLToPath(new URL('../tests/fixtures/golden-skus.json', import.meta.url));
  let input: unknown;
  try {
    input = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    console.error('Не удалось прочитать файл золотого набора или разобрать JSON.');
    return 1;
  }
  const errors = validateGoldenSkus(input, { requireReady: !draft });
  if (errors.length) {
    console.error(errors.join('\n'));
    return 1;
  }
  console.log(
    draft
      ? 'Формат и GTIN проверены. Режим --draft не подтверждает готовность набора.'
      : 'Золотой набор готов: 20 SKU, JSON-схема и GTIN проверены.',
  );
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  process.exitCode = runGoldenValidation();
