import { test, expect } from '@playwright/test';
test('cloud source settings show Brave safety gate without local services', async ({ page }) => {
  await page.route('**/api/config', (route) =>
    route.fulfill({
      json: {
        braveConfigured: true,
        braveFreeOnlyConfirmed: false,
        tavilyConfigured: true,
        geminiConfigured: false,
        accessProtected: false,
        serverReady: true,
      },
    }),
  );
  await page.goto('/');
  await page.getByRole('button', { name: 'Источники', exact: true }).first().click();
  await expect(page.locator('.sources-grid')).toContainText('Brave Search');
  await expect(page.locator('.sources-grid')).toContainText('Расход не подтверждён');
  await expect(page.locator('.sources-grid')).not.toContainText('SearXNG');
  await expect(page.locator('.sources-grid')).not.toContainText('Crawl4AI');
  await page.getByRole('button', { name: 'Настройки', exact: true }).click();
  await expect(page.getByRole('combobox', { name: 'Источники поиска', exact: true })).toHaveCount(
    0,
  );
  await expect(page.getByRole('dialog')).toContainText('Brave');
});
