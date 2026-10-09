import { test, expect } from '@playwright/test';
import sharp from 'sharp';

test('a detected SKU conflict stays blocked after reopening and reloading the card', async ({
  page,
}) => {
  await page.route('**/api/config', (route) =>
    route.fulfill({
      json: {
        braveConfigured: false,
        geminiConfigured: true,
        accessProtected: false,
        serverReady: true,
      },
    }),
  );
  await page.route('**/api/verify', (route) =>
    route.fulfill({
      json: {
        verdict: 'conflict',
        brand: 'Другой бренд',
        quantity: '750 ml',
        variant: '',
        reasons: ['Объём на упаковке отличается от 500 мл.'],
      },
    }),
  );
  await page.goto('/');
  await page.getByRole('button', { name: 'Настройки', exact: true }).click();
  await page.getByLabel('Обработка фона').selectOption('white');
  await page.getByRole('button', { name: 'Готово', exact: true }).click();
  await page.getByLabel('Загрузить Excel или CSV').setInputFiles({
    name: 'conflict.csv',
    mimeType: 'text/csv',
    buffer: Buffer.from('SKU,Наименование RU\nCONFLICT,Тестовая бутылка 500 мл\n'),
  });
  await page.getByRole('button', { name: 'Импортировать 1 SKU' }).click();
  await page.getByRole('button', { name: 'Открыть CONFLICT', exact: true }).click();
  const review = page.locator('aside.review-pane');
  const png = await sharp(
    Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg" width="300" height="500"><rect width="300" height="500" fill="white"/><rect x="100" y="50" width="100" height="400" fill="#216a9b"/></svg>',
    ),
  )
    .png()
    .toBuffer();
  await review
    .locator('input[type="file"]')
    .setInputFiles({ name: 'fixture.png', mimeType: 'image/png', buffer: png });
  await review.getByRole('button', { name: 'Подготовить JPG', exact: true }).click();
  await expect(review.getByAltText('Подготовленный JPG на белом фоне')).toBeVisible();
  await review.getByRole('checkbox').check();
  await review.getByRole('button', { name: 'Проверить Gemini', exact: true }).click();
  await expect(review.getByText('Найдено противоречие', { exact: true })).toBeVisible();
  await expect(review.getByRole('button', { name: 'Подтвердить для экспорта' })).toBeDisabled();
  await review.getByRole('button', { name: 'Закрыть карточку', exact: true }).click();
  await page.getByRole('button', { name: 'Открыть CONFLICT', exact: true }).click();
  await expect(review.getByText('Найдено противоречие', { exact: true })).toBeVisible();
  await expect(review.getByRole('button', { name: 'Подтвердить для экспорта' })).toBeDisabled();
  await expect(page.getByText('Сохранено в браузере', { exact: false })).toBeVisible();
  await page.reload();
  await page.getByRole('button', { name: 'Открыть CONFLICT', exact: true }).click();
  await expect(review.getByText('Найдено противоречие', { exact: true })).toBeVisible();
  await expect(review.getByRole('button', { name: 'Подтвердить для экспорта' })).toBeDisabled();
});
