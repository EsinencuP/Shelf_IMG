import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import JSZip from 'jszip';
import sharp from 'sharp';
import ExcelJS from 'exceljs';
import { readFile } from 'node:fs/promises';

const csv =
  'SKU;Внутренний код;EAN;Наименование RU;Наименование RO;Ширина мм;Высота мм;Глубина мм\n00123;INT-123;;Тестовая бутылка 500 мл;Sticla test 500 ml;70;205;70\n00200;;;;Produs fara fotografie;80;100;80\n';

test('empty screen is accessible, keyboard usable and fits desktop/mobile', async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Подготовка фотографий' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Загрузить Excel', exact: true })).toBeEnabled();
  await page.screenshot({ path: testInfo.outputPath('desktop-empty.png'), fullPage: true });
  const accessibility = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21aa'])
    .analyze();
  expect(
    accessibility.violations.map((item) => ({
      id: item.id,
      nodes: item.nodes.map((node) => node.target),
    })),
  ).toEqual([]);
  await page.getByRole('button', { name: 'Настройки', exact: true }).focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).not.toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: testInfo.outputPath('mobile-empty.png'), fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await expect(page.getByRole('button', { name: 'Загрузить Excel', exact: true })).toBeVisible();
});

test('Excel import, manual photo, white crop, approval, reload and auditable ZIP work end-to-end', async ({
  page,
}, testInfo) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/');
  await page.getByRole('button', { name: 'Настройки', exact: true }).click();
  await page.getByLabel('Обработка фона').selectOption('white');
  await page.getByRole('button', { name: 'Готово', exact: true }).click();
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('Товары');
  sheet.addRows(
    csv
      .trim()
      .split('\n')
      .map((line) => line.split(';')),
  );
  sheet.getColumn(1).numFmt = '@';
  await page.getByLabel('Загрузить Excel или CSV').setInputFiles({
    name: 'pilot.xlsx',
    mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    buffer: Buffer.from(await workbook.xlsx.writeBuffer()),
  });
  const mapping = page.getByRole('dialog');
  await mapping.getByLabel('EAN / штрихкод').selectOption('');
  await mapping.getByRole('button', { name: 'Импортировать 2 SKU', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'pilot', exact: true })).toBeVisible();
  await expect(page.getByText('SKU 00123 · Код INT-123', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Открыть 00123', exact: true }).click();
  const review = page.locator('aside.review-pane');
  const image = await sharp(
    Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg" width="500" height="800"><rect width="500" height="800" fill="white"/><rect x="200" y="100" width="100" height="100" rx="8" fill="#fd8318"/><rect x="170" y="190" width="160" height="500" rx="28" fill="#20669b"/><rect x="180" y="340" width="140" height="150" fill="white"/><rect x="195" y="380" width="110" height="35" fill="#bd334d"/></svg>',
    ),
  )
    .png()
    .toBuffer();
  await review
    .locator('input[type="file"]')
    .setInputFiles({ name: 'test-bottle.png', mimeType: 'image/png', buffer: image });
  await review.getByRole('button', { name: 'Подготовить JPG', exact: true }).click();
  await expect(review.getByAltText('Подготовленный JPG на белом фоне')).toBeVisible();
  await expect(review.getByRole('button', { name: 'Подтвердить для экспорта' })).toBeDisabled();
  await review.getByRole('checkbox').check();
  await review.getByRole('button', { name: 'Подтвердить для экспорта' }).click();
  await expect(review.getByText(/Подтверждено ·/)).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('desktop-batch.png'), fullPage: true });
  // Switch immediately after approval to exercise the debounce-save regression.
  await page.getByRole('button', { name: 'Мои партии', exact: false }).click();
  await page.getByRole('button', { name: 'Открыть', exact: true }).click();
  await page.reload();
  await expect(page.getByRole('heading', { name: 'pilot', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Открыть 00123', exact: true }).click();
  await expect(page.getByText(/Подтверждено ·/)).toBeVisible();
  await expect(page.getByAltText('Подготовленный JPG на белом фоне')).toBeVisible();

  const downloaded = page.waitForEvent('download');
  await page.getByRole('button', { name: /Скачать ZIP/ }).click();
  const download = await downloaded;
  expect(download.suggestedFilename()).toBe('pilot_Shelf.zip');
  const file = await download.path();
  const zip = await JSZip.loadAsync(await readFile(file!));
  expect(zip.file('images/00123.jpg')).not.toBeNull();
  expect(zip.file('images/00200.jpg')).toBeNull();
  expect(zip.file('report.xlsx')).not.toBeNull();
  expect(zip.file('attributions.txt')).not.toBeNull();
  const manifest = JSON.parse(await zip.file('manifest.json')!.async('string'));
  expect(manifest.totalRows).toBe(2);
  expect(manifest.exportedImages).toBe(1);
  expect(manifest.rows[0].sku).toBe('00123');
  expect(manifest.rows[0].widthMm).toBe(70);
  expect(manifest.rows[0].source.provider).toBe('Загружено пользователем');
  expect(manifest.rows[0].warnings.join(' ')).toContain('EAN');
  const jpeg = await zip.file('images/00123.jpg')!.async('nodebuffer');
  const metadata = await sharp(jpeg).metadata();
  expect(metadata.format).toBe('jpeg');
  expect(metadata.hasAlpha).toBe(false);
  expect(metadata.width).toBe(160);
  expect(metadata.height).toBe(590);
  expect(errors).toEqual([]);

  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: testInfo.outputPath('mobile-batch.png'), fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
});

test('search UI handles real contract and SSRF guard rejects a private image URL', async ({
  page,
  request,
}) => {
  // Only the upstream-dependent search response is deterministic here; production uses the real connector.
  await page.route('**/api/search', async (route) =>
    route.fulfill({ json: { candidates: [], warnings: ['По указанному EAN фотографий нет.'] } }),
  );
  await page.goto('/');
  await page.getByLabel('Загрузить Excel или CSV').setInputFiles({
    name: 'missing.csv',
    mimeType: 'text/csv',
    buffer: Buffer.from('SKU,Наименование RU\nMISSING,Тест отсутствующей фотографии\n'),
  });
  await page.getByRole('button', { name: 'Импортировать 1 SKU' }).click();
  await page.getByRole('button', { name: 'Найти изображения', exact: true }).click();
  await expect(page.locator('.status-not_found')).toHaveText('Не найдено');
  const response = await request.get('/api/image?url=https%3A%2F%2F127.0.0.1%2Fsecret.jpg');
  expect(response.status()).toBe(422);
});
