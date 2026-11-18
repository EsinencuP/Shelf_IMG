import { test, expect } from '@playwright/test';
import sharp from 'sharp';

test('candidate previews use the authenticated API and selection keeps the verified bytes', async ({
  page,
}) => {
  const png = await sharp({
    create: { width: 100, height: 150, channels: 3, background: '#286b98' },
  })
    .png()
    .toBuffer();
  const authorization = 'Basic ' + Buffer.from('admin:admin').toString('base64');
  const proxied: string[] = [];
  await page.route('**/api/config', (route) =>
    route.fulfill({
      json: {
        serverReady: true,
        accessProtected: true,
        databaseConfigured: false,
        geminiConfigured: false,
      },
    }),
  );
  await page.route('**/api/session', (route) => {
    expect(route.request().headers().authorization).toBe(authorization);
    return route.fulfill({ json: { ok: true } });
  });
  await page.route('**/api/image?*', (route) => {
    expect(route.request().headers().authorization).toBe(authorization);
    const url = new URL(route.request().url());
    expect(url.searchParams.get('page')).toBe('https://shop.md/item');
    proxied.push(url.searchParams.get('url')!);
    return route.fulfill({ contentType: 'image/png', body: png });
  });
  await page.route('**/api/library/*/image', (route) => {
    expect(route.request().headers().authorization).toBe(authorization);
    return route.fulfill({ contentType: 'image/png', body: png });
  });
  await page.route('**/api/search', (route) =>
    route.fulfill({
      json: {
        candidates: [
          {
            id: 'external',
            title: 'Фото магазина',
            imageUrl: 'https://images.shop.md/front.jpg',
            pageUrl: 'https://shop.md/item',
            source: 'Магазин',
            rights: 'unknown',
            warnings: [],
            gtinExact: false,
          },
          {
            id: 'saved',
            title: 'Фото общего каталога',
            imageUrl: '/api/library/35a66c9f-cf92-4333-ae91-78291c5b6983/image',
            pageUrl: '',
            source: 'Общий каталог',
            rights: 'unknown',
            warnings: [],
            gtinExact: false,
          },
        ],
        warnings: [],
        diagnostics: [],
        outcome: 'review',
      },
    }),
  );
  await page.goto('/');
  await page.getByRole('button', { name: 'Настройки', exact: true }).click();
  const settings = page.getByRole('dialog');
  await settings.getByLabel('Пароль приложения').fill('admin');
  await settings.getByRole('button', { name: 'Проверить доступ', exact: true }).click();
  await expect(page.getByText('Доступ к серверу подтверждён.', { exact: false })).toBeVisible();
  await settings.getByRole('button', { name: 'Готово', exact: true }).click();
  await page.getByLabel('Загрузить Excel или CSV').setInputFiles({
    name: 'photo.csv',
    mimeType: 'text/csv',
    buffer: Buffer.from('SKU,Наименование RU\nPHOTO,Фото товара\n'),
  });
  await page.getByRole('dialog').getByRole('button', { name: 'Импортировать 1 SKU' }).click();
  await page.getByRole('button', { name: 'Найти изображения', exact: true }).click();
  await expect(page.locator('.status-review')).toBeVisible();
  await page.getByRole('button', { name: 'Открыть PHOTO', exact: true }).click();
  const review = page.locator('aside.review-pane');
  await expect(review.getByAltText('Фото магазина')).toHaveAttribute('src', /^blob:/);
  await expect(review.getByAltText('Фото общего каталога')).toHaveAttribute('src', /^blob:/);
  expect(proxied).toContain('https://images.shop.md/front.jpg');
  const requestsBeforeSelection = proxied.length;
  await review.locator('.candidate-card').first().click();
  await expect(review.getByAltText('Исходная фотография товара')).toBeVisible();
  expect(proxied).toHaveLength(requestsBeforeSelection);
});
