import { test, expect } from '@playwright/test';
import { SOURCE_STATUS_LABELS } from '../src/lib/source-status';
import type { SourceStatus } from '../src/lib/types';

test('SKU card shows source reasons, preserves errors and restores saved diagnostics', async ({
  page,
}, testInfo) => {
  const statuses = Object.keys(SOURCE_STATUS_LABELS) as SourceStatus[];
  await page.route('**/api/config', (route) =>
    route.fulfill({
      json: {
        braveConfigured: false,
        geminiConfigured: false,
        accessProtected: false,
        serverReady: true,
        databaseConfigured: false,
      },
    }),
  );
  await page.route('**/api/search', (route) =>
    route.fulfill({
      json: {
        candidates: [],
        warnings: [],
        outcome: 'deferred',
        diagnostics: [
          ...statuses.map((status) => ({
            id: status,
            source: `Источник ${status}`,
            status,
            reason: `Причина ${status}: проверка источника.`,
            count: status === 'ok' ? 2 : 0,
            elapsedMs: 10,
          })),
          {
            id: 'legacy',
            source: 'Старый отчёт METRO',
            status: 'unavailable',
            message: 'Источник ответил HTTP 403.',
            count: 0,
            elapsedMs: 10,
          },
        ],
      },
    }),
  );
  await page.goto('/');
  await page.getByRole('button', { name: 'Один артикул', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('SKU / артикул').fill('SOURCE-REASONS');
  await dialog.getByLabel('Наименование RU').fill('Проверка причин поиска');
  await dialog.getByRole('button', { name: 'Найти фотографии', exact: true }).click();
  const details = page.locator('.search-diagnostics').filter({ hasText: 'Поиск по источникам' });
  await details.locator('summary').click();
  for (const status of statuses) {
    const row = details
      .locator('li')
      .filter({ has: page.getByText(`Источник ${status}`, { exact: true }) });
    await expect(row).toHaveAttribute('data-source-status', status);
    await expect(row.locator('strong')).toHaveText(
      status === 'ok' ? '2 фото' : SOURCE_STATUS_LABELS[status],
    );
    await expect(row.locator('small')).toHaveText(`Причина ${status}: проверка источника.`);
    if (['blocked', 'timeout', 'quota', 'parse_error', 'relay_offline'].includes(status))
      await expect(row).not.toContainText('Фото не найдены');
  }
  const legacy = details.locator('li').filter({ hasText: 'Старый отчёт METRO' });
  await expect(legacy).toHaveAttribute('data-source-status', 'blocked');
  await expect(legacy).toContainText('HTTP 403');
  await page.screenshot({
    path: testInfo.outputPath('source-reasons-desktop.png'),
    fullPage: true,
  });
  await page.reload();
  await page.getByRole('button', { name: 'Открыть SOURCE-REASONS', exact: true }).click();
  await details.locator('summary').click();
  await expect(details.locator('[data-source-status="quota"]')).toContainText('Причина quota');
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await page.screenshot({ path: testInfo.outputPath('source-reasons-mobile.png'), fullPage: true });
});
