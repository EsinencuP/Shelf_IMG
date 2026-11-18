import { test, expect } from '@playwright/test';
import sharp from 'sharp';
import JSZip from 'jszip';
import { readFile } from 'node:fs/promises';
test('manual approval syncs a JPEG to the shared library and keeps local export available on database failure', async ({
  page,
}) => {
  const id = '35a66c9f-cf92-4333-ae91-78291c5b6983';
  let saved: Record<string, any> | undefined;
  let fail = false;
  await page.route('**/api/config', (route) =>
    route.fulfill({
      json: {
        databaseConfigured: true,
        accessProtected: false,
        geminiConfigured: false,
        braveConfigured: false,
      },
    }),
  );
  await page.route('**/api/library', (route) => {
    saved = route.request().postDataJSON();
    return route.fulfill(
      fail
        ? { status: 502, json: { error: 'База временно недоступна' } }
        : { status: 201, json: { id } },
    );
  });
  await page.goto('/');
  await page.getByRole('button', { name: 'Настройки', exact: true }).click();
  await page.getByLabel('Обработка фона').selectOption('white');
  await page.getByRole('button', { name: 'Готово', exact: true }).click();
  await page.getByLabel('Загрузить Excel или CSV').setInputFiles({
    name: 'library.csv',
    mimeType: 'text/csv',
    buffer: Buffer.from('SKU,Наименование RU\nLIBRARY,Тестовая бутылка 500 мл\n'),
  });
  await page.getByRole('button', { name: 'Импортировать 1 SKU', exact: true }).click();
  await page.getByRole('button', { name: 'Открыть LIBRARY', exact: true }).click();
  const pane = page.locator('aside.review-pane');
  const image = await sharp(
    Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg" width="160" height="240"><rect width="160" height="240" fill="white"/><rect x="50" y="30" width="60" height="180" fill="#20669b"/></svg>',
    ),
  )
    .png()
    .toBuffer();
  await pane
    .locator('input[type="file"]')
    .setInputFiles({ name: 'fixture.png', mimeType: 'image/png', buffer: image });
  await pane.getByRole('button', { name: 'Подготовить JPG', exact: true }).click();
  await pane.getByRole('checkbox').check();
  await pane.getByRole('button', { name: 'Подтвердить для экспорта', exact: true }).click();
  await expect(pane.getByText(/Подтверждено ·/)).toBeVisible();
  expect(saved).toMatchObject({
    confirmed: true,
    rightsConfirmed: true,
    product: { nameRu: 'Тестовая бутылка 500 мл' },
  });
  expect((await sharp(Buffer.from(saved!.image, 'base64')).metadata()).format).toBe('jpeg');
  const downloaded = page.waitForEvent('download');
  await page.getByRole('button', { name: /Скачать ZIP/ }).click();
  const zip = await JSZip.loadAsync(await readFile((await (await downloaded).path())!));
  expect(JSON.parse(await zip.file('manifest.json')!.async('string')).rows[0].libraryId).toBe(id);
  fail = true;
  await pane.getByRole('button', { name: 'Отменить подтверждение', exact: true }).click();
  await pane.getByRole('button', { name: 'Подтвердить для экспорта', exact: true }).click();
  await expect(pane.getByText(/Подтверждено ·/)).toBeVisible();
  await expect(
    page.getByText(/Фото добавлено в экспорт\. Общий каталог: База временно недоступна/),
  ).toBeVisible();
});
