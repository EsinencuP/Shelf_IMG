import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import sharp from 'sharp';

test('search and JPEG defaults persist before importing; settings fit mobile and are accessible', async ({
  page,
}, testInfo) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Настройки', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('combobox', { name: 'Режим поиска', exact: true }).selectOption('moldova');
  await dialog.getByLabel('Качество JPEG').selectOption('0.9');
  await dialog.getByLabel('Обработка фона').selectOption('white');
  await expect(dialog.getByLabel('Лимит веб-запросов на SKU')).toBeDisabled();
  expect(
    (
      await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze()
    ).violations.map((v) => ({
      id: v.id,
      nodes: v.nodes.map((node) => ({ target: node.target, summary: node.failureSummary })),
    })),
  ).toEqual([]);
  await page.screenshot({ path: testInfo.outputPath('settings-desktop.png') });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await dialog.getByRole('button', { name: 'Готово', exact: true }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: testInfo.outputPath('settings-mobile.png') });
  await dialog.getByRole('button', { name: 'Готово', exact: true }).click();
  await page.reload();
  await page.getByRole('button', { name: 'Настройки', exact: true }).click();
  await expect(dialog.getByRole('combobox', { name: 'Режим поиска', exact: true })).toHaveValue(
    'moldova',
  );
  await expect(dialog.getByLabel('Качество JPEG')).toHaveValue('0.9');
  await expect(dialog.getByLabel('Обработка фона')).toHaveValue('white');
  await dialog
    .getByRole('combobox', { name: 'Режим поиска', exact: true })
    .selectOption('expanded');
  await dialog.getByLabel('Лимит веб-запросов на SKU').selectOption('1');
  await dialog.getByLabel('Использовать веб-поиск Brave').uncheck();
  await expect(dialog.getByLabel('Лимит веб-запросов на SKU')).toBeDisabled();
});

test('batch search snapshot, per-SKU expanded retry, guided approval and JPG invalidation work together', async ({
  page,
}, testInfo) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const searches: Record<string, unknown>[] = [];
  await page.route('**/api/search', (route) => {
    searches.push(route.request().postDataJSON());
    return route.fulfill({
      json: {
        candidates: [],
        warnings: [],
        diagnostics: [
          { id: 'metro-md', source: 'METRO Moldova', status: 'ok', count: 0, elapsedMs: 20 },
        ],
      },
    });
  });
  await page.goto('/');
  await page.getByRole('button', { name: 'Настройки', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('combobox', { name: 'Режим поиска', exact: true }).selectOption('moldova');
  await dialog.getByLabel('Обработка фона').selectOption('white');
  await dialog.getByRole('button', { name: 'Готово', exact: true }).click();
  await page.getByLabel('Загрузить Excel или CSV').setInputFiles({
    name: 'controls.csv',
    mimeType: 'text/csv',
    buffer: Buffer.from('SKU,Наименование RU\nFIRST,Тестовая бутылка\nSECOND,Другой товар\n'),
  });
  await dialog.getByRole('button', { name: 'Импортировать 2 SKU', exact: true }).click();
  await page.getByRole('button', { name: 'Найти изображения', exact: true }).click();
  await expect(page.locator('.status-not_found')).toHaveCount(2);
  expect(searches.map((item) => item.searchOptions)).toEqual([
    { mode: 'moldova', useWeb: true, webQueryLimit: 4 },
    { mode: 'moldova', useWeb: true, webQueryLimit: 4 },
  ]);
  await page.getByRole('button', { name: 'Открыть FIRST', exact: true }).click();
  const review = page.locator('aside.review-pane');
  await review.getByRole('button', { name: 'Расширить поиск для SKU', exact: true }).click();
  await expect(page.locator('.status-not_found')).toHaveCount(2);
  await expect(review.getByRole('button', { name: 'Повторить поиск', exact: true })).toBeEnabled();
  expect(searches.at(-1)?.searchOptions).toEqual({
    mode: 'expanded',
    useWeb: true,
    webQueryLimit: 4,
  });
  await expect(page.locator('.batch-search-controls')).toContainText('Молдова');
  const buffer = await sharp(
    Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg" width="400" height="600"><rect width="400" height="600" fill="white"/><rect x="130" y="50" width="140" height="500" rx="18" fill="#23669a"/></svg>',
    ),
  )
    .png()
    .toBuffer();
  await review
    .locator('input[type=file]')
    .setInputFiles({ name: 'bottle.png', mimeType: 'image/png', buffer });
  await review.getByRole('button', { name: 'Подготовить JPG', exact: true }).click();
  await expect(review.getByAltText('Подготовленный JPG на белом фоне')).toBeVisible();
  await review.getByRole('checkbox').check();
  await review.getByRole('button', { name: 'Подтвердить и перейти дальше', exact: true }).click();
  await expect(review.getByRole('heading', { name: 'SECOND', exact: true })).toBeFocused();
  await expect(page.locator('.status-ready')).toHaveCount(1);
  await page.getByRole('button', { name: 'Открыть FIRST', exact: true }).click();
  await expect(review.getByText(/Подтверждено ·/)).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('guided-review-desktop.png'), fullPage: true });
  await page.getByRole('button', { name: 'Настройки', exact: true }).click();
  await dialog.getByLabel('Имена файлов').selectOption('internalCode');
  await dialog.getByRole('button', { name: 'Готово', exact: true }).click();
  await expect(page.locator('.status-ready')).toHaveCount(1);
  await page.getByRole('button', { name: 'Настройки', exact: true }).click();
  await dialog.getByLabel('Качество JPEG').selectOption('0.9');
  await dialog.getByLabel('Обработка фона').selectOption('ai');
  await dialog.getByRole('button', { name: 'Готово', exact: true }).click();
  await expect(page.locator('.status-ready')).toHaveCount(0);
  await expect(review.getByAltText('Исходная фотография товара')).toBeVisible();
  await expect(review.getByAltText('Подготовленный JPG на белом фоне')).toHaveCount(0);
  await expect(
    review.getByRole('button', { name: 'Подтвердить для экспорта', exact: true }),
  ).toHaveCount(0);
  await review
    .getByRole('combobox', { name: 'Обработка этой фотографии', exact: true })
    .selectOption('white');
  await expect(page.getByText('Сохранено в браузере', { exact: false })).toBeVisible();
  await page.reload();
  await page.getByRole('button', { name: 'Открыть FIRST', exact: true }).click();
  await expect(review.getByAltText('Исходная фотография товара')).toBeVisible();
  await expect(review.getByAltText('Подготовленный JPG на белом фоне')).toHaveCount(0);
  await expect(
    review.getByRole('combobox', { name: 'Обработка этой фотографии', exact: true }),
  ).toHaveValue('white');
  await page
    .locator('.toolbar-actions')
    .getByRole('button', { name: 'Подготовить JPG', exact: true })
    .click();
  await expect(review.getByAltText('Подготовленный JPG на белом фоне')).toBeVisible();
  await expect(
    review.getByRole('button', { name: 'Подтвердить для экспорта', exact: true }),
  ).toBeEnabled();
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await page.screenshot({ path: testInfo.outputPath('guided-review-mobile.png'), fullPage: true });
  expect(
    (
      await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze()
    ).violations.map((v) => ({
      id: v.id,
      nodes: v.nodes.map((node) => ({ target: node.target, summary: node.failureSummary })),
    })),
  ).toEqual([]);
  await review.getByRole('button', { name: 'Подтвердить для экспорта', exact: true }).click();
  // Failure after an approved image must remove the old output instead of keeping it exportable.
  await page.evaluate(() => {
    HTMLCanvasElement.prototype.toBlob = function (callback) {
      callback(null);
    };
  });
  await review.getByRole('button', { name: 'Обработать снова', exact: true }).click();
  await expect(review.getByText('Браузер не смог создать JPEG.', { exact: true })).toBeVisible();
  await expect(review.getByAltText('Подготовленный JPG на белом фоне')).toHaveCount(0);
  await expect(page.locator('.status-ready')).toHaveCount(0);
  await expect(
    review.getByRole('button', { name: 'Подтвердить для экспорта', exact: true }),
  ).toHaveCount(0);
  expect(errors).toEqual([]);
});
