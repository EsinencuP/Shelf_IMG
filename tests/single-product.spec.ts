import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

test('manual form starts one-SKU search, keeps previous batches and persists its result', async ({
  page,
}) => {
  const requests: Record<string, string>[] = [];
  await page.route('**/api/search', async (route) => {
    requests.push(route.request().postDataJSON());
    await route.fulfill({
      json: { candidates: [], warnings: ['Для тестового товара фотографий нет.'] },
    });
  });
  await page.goto('/');
  await page.getByRole('button', { name: 'Один артикул', exact: true }).click();
  const form = page.getByRole('dialog');
  await form.getByLabel('SKU / артикул').fill('00123');
  await form.getByLabel('EAN / штрихкод').fill('00012345600012');
  await form.getByLabel('Ширина, мм').fill('70,5');
  await form.getByLabel('Высота, мм').fill('205');
  const a11y = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze();
  expect(a11y.violations.map((item) => item.id)).toEqual([]);
  await form.getByRole('button', { name: 'Найти фотографии', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Артикул 00123', exact: true })).toBeVisible();
  await expect(page.locator('.status-not_found')).toHaveText('Не найдено');
  expect(requests).toHaveLength(1);
  expect(requests[0]).toMatchObject({ sku: '00123', ean: '00012345600012' });
  await expect(page.getByText('70.5 × 205 мм', { exact: false }).first()).toBeVisible();
  await expect(page.getByText('Сохранено в браузере', { exact: false })).toBeVisible();

  await page.getByRole('button', { name: 'Один артикул', exact: true }).click();
  await form.getByLabel('SKU / артикул').fill('SECOND');
  await form.getByLabel('Наименование RO').fill('Produs test');
  await form.getByRole('button', { name: 'Найти фотографии', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Артикул SECOND', exact: true })).toBeVisible();
  await expect(page.locator('.status-not_found')).toHaveText('Не найдено');
  expect(requests).toHaveLength(2);
  expect(requests[1].nameRo).toBe('Produs test');
  await page.getByRole('button', { name: 'Мои партии', exact: false }).click();
  await expect(page.getByRole('heading', { name: 'Артикул 00123', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Артикул SECOND', exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Артикул SECOND', exact: true })).toBeVisible();
  await expect(page.locator('.status-not_found')).toHaveText('Не найдено');
});

test('mobile form reports invalid search input without invoking the API', async ({
  page,
}, testInfo) => {
  let calls = 0;
  await page.route('**/api/search', async (route) => {
    calls++;
    await route.fulfill({ json: { candidates: [], warnings: [] } });
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await page.getByRole('button', { name: 'Один артикул', exact: true }).click();
  const form = page.getByRole('dialog');
  await form.getByLabel('SKU / артикул').fill('SKU-ONLY');
  await form.getByRole('button', { name: 'Найти фотографии', exact: true }).click();
  await expect(form.getByRole('alert')).toContainText('EAN или название');
  await form.getByLabel('EAN / штрихкод').fill('3017620422004');
  await form.getByRole('button', { name: 'Найти фотографии', exact: true }).click();
  await expect(form.getByRole('alert')).toContainText('контрольная');
  expect(calls).toBe(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await page.screenshot({ path: testInfo.outputPath('single-product-mobile.png'), fullPage: true });
});
