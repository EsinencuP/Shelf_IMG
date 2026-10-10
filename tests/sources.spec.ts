import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

test('Moldova source directory and saved per-source diagnostics are usable', async ({
  page,
}, testInfo) => {
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
  await page.route('**/api/search', (route) =>
    route.fulfill({
      json: {
        candidates: [],
        warnings: ['Brave не подключён.'],
        diagnostics: [
          { id: 'metro-md', source: 'METRO Moldova', status: 'ok', count: 0, elapsedMs: 250 },
          { id: 'brave', source: 'Brave Search', status: 'not_configured', count: 0, elapsedMs: 0 },
        ],
      },
    }),
  );
  await page.goto('/');
  await page.getByRole('button', { name: 'Источники', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'Прямые источники: Молдова и регион' }),
  ).toBeVisible();
  await expect(page.getByRole('link', { name: 'linella.md', exact: true })).toBeVisible();
  await expect(page.getByText('Bucuria — производитель', { exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'UPCitemdb', exact: true })).toBeVisible();
  const a11y = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze();
  expect(a11y.violations.map((item) => item.id)).toEqual([]);
  await page.screenshot({ path: testInfo.outputPath('sources-desktop.png'), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await page
    .getByRole('button', { name: 'Один артикул', exact: true })
    .count()
    .then(async (count) => {
      if (!count) await page.getByRole('button', { name: 'Подготовка фото', exact: true }).click();
    });
  await page.getByRole('button', { name: 'Один артикул', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('SKU / артикул').fill('DIAGNOSTIC');
  await dialog.getByLabel('Наименование RU').fill('Тест поиска');
  await dialog.getByRole('button', { name: 'Найти фотографии', exact: true }).click();
  await expect(page.locator('.status-not_found')).toBeVisible();
  const details = page.locator('.search-diagnostics');
  await details.locator('summary').click();
  await expect(details.getByText('METRO Moldova', { exact: true })).toBeVisible();
  await expect(details.getByText('Нет ключа', { exact: true })).toBeVisible();
  await expect(page.getByText('Сохранено в браузере', { exact: false })).toBeVisible();
  await page.reload();
  await page.getByRole('button', { name: 'Открыть DIAGNOSTIC', exact: true }).click();
  await page.locator('.search-diagnostics summary').click();
  await expect(
    page.locator('.search-diagnostics').getByText('METRO Moldova', { exact: true }),
  ).toBeVisible();
});
