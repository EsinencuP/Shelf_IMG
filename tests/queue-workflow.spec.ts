import { test, expect } from '@playwright/test';
const id = '35a66c9f-cf92-4333-ae91-78291c5b6983';
test('first fast submission waits for server configuration and uses the durable queue', async ({
  page,
}) => {
  let release: () => void = () => {};
  const ready = new Promise<void>((resolve) => {
    release = resolve;
  });
  let queued = 0,
    legacy = 0;
  await page.route('**/api/config', async (route) => {
    await ready;
    await route.fulfill({
      json: {
        databaseConfigured: true,
        cloudWorkerConfigured: true,
        accessProtected: false,
        geminiConfigured: false,
        braveConfigured: false,
      },
    });
  });
  await page.route('**/api/jobs', (route) => {
    queued++;
    return route.fulfill({ status: 202, json: { id, status: 'queued', attempts: 0 } });
  });
  await page.route('**/api/search', (route) => {
    legacy++;
    return route.fulfill({ json: { candidates: [], warnings: [] } });
  });
  await page.route('**/api/jobs/status', (route) =>
    route.fulfill({ json: { jobs: [{ id, status: 'queued', attempts: 0 }] } }),
  );
  await page.goto('/');
  await page.getByRole('button', { name: 'Один артикул', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('SKU / артикул').fill('FIRST');
  await dialog.getByLabel('EAN / штрихкод').fill('4600699006831');
  await dialog.getByRole('button', { name: 'Найти фотографии', exact: true }).click();
  await expect(page.getByText('Проверяем подключение поиска…')).toBeVisible();
  expect(queued).toBe(0);
  expect(legacy).toBe(0);
  release();
  await expect(page.locator('.status-searching')).toHaveCount(1);
  await expect.poll(() => queued).toBe(1);
  await expect(
    page.getByText(
      'Поиск работает в облаке. Можно закрыть вкладку и вернуться к результатам позже.',
    ),
  ).toBeVisible();
  expect(legacy).toBe(0);
});
test('shared jobs survive a reload, resolve as deferred, and can be cancelled', async ({
  page,
}) => {
  let status = 'queued';
  let submissions = 0;
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
  await page.route('**/api/jobs', (route) => {
    submissions++;
    return route.fulfill({ status: 202, json: { id, status: 'queued', attempts: 0 } });
  });
  await page.route('**/api/jobs/' + id, (route) => {
    if (route.request().method() === 'POST') status = 'cancelled';
    return route.fulfill({
      json: {
        id,
        status,
        attempts: 1,
        result:
          status === 'succeeded'
            ? { candidates: [], warnings: ['Источник временно недоступен'], outcome: 'deferred' }
            : undefined,
      },
    });
  });
  await page.route('**/api/jobs/status', (route) =>
    route.fulfill({
      json: {
        jobs: [
          {
            id,
            status,
            attempts: 1,
            result:
              status === 'succeeded'
                ? {
                    candidates: [],
                    warnings: ['Источник временно недоступен'],
                    outcome: 'deferred',
                  }
                : undefined,
          },
        ],
      },
    }),
  );
  await page.goto('/');
  await page.getByLabel('Загрузить Excel или CSV').setInputFiles({
    name: 'queue.csv',
    mimeType: 'text/csv',
    buffer: Buffer.from('SKU,Наименование RU\nQUEUE,Слобода 850 мл\n'),
  });
  await page.getByRole('button', { name: 'Импортировать 1 SKU', exact: true }).click();
  await page.getByRole('button', { name: 'Найти изображения', exact: true }).click();
  await expect(page.locator('.status-searching')).toHaveCount(1);
  await page.reload();
  await expect(page.locator('.status-searching')).toHaveCount(1);
  status = 'succeeded';
  await expect(page.locator('.status-deferred')).toHaveCount(1);
  expect(submissions).toBe(1);
  status = 'queued';
  await page.getByRole('button', { name: 'Найти изображения', exact: true }).click();
  await expect(page.locator('.status-searching')).toHaveCount(1);
  await page.getByRole('button', { name: 'Отменить поиск', exact: true }).click();
  await expect(page.locator('.status-pending')).toHaveCount(1);
});
test('recovers 1,000 independently tracked GTIN rows after closing the workspace', async ({
  page,
}) => {
  await page.route('**/api/config', (route) =>
    route.fulfill({
      json: { databaseConfigured: true, cloudWorkerConfigured: true, accessProtected: false },
    }),
  );
  let submitted = 0;
  let finished = false;
  await page.route('**/api/jobs', (route) => {
    const { jobs } = route.request().postDataJSON() as {
      jobs: { requestKey: string; ean: string }[];
    };
    submitted++;
    expect(jobs).toHaveLength(1000);
    expect(jobs[0].ean).toBe('00012345600012');
    return route.fulfill({
      status: 202,
      json: { jobs: jobs.map(({ requestKey }) => ({ id: requestKey, request_key: requestKey })) },
    });
  });
  await page.route('**/api/jobs/status', (route) => {
    const { ids } = route.request().postDataJSON() as { ids: string[] };
    expect(ids.length).toBeLessThanOrEqual(100);
    return route.fulfill({
      json: {
        jobs: ids.map((id) => ({
          id,
          status: finished ? 'succeeded' : 'queued',
          result: finished ? { candidates: [], warnings: [], outcome: 'not_found' } : undefined,
        })),
      },
    });
  });
  await page.goto('/');
  await page.getByLabel('Загрузить Excel или CSV').setInputFiles({
    name: 'large.csv',
    mimeType: 'text/csv',
    buffer: Buffer.from(
      'SKU,GTIN\n' +
        Array.from({ length: 1000 }, (_, index) => `SKU-${index},00012345600012\n`).join(''),
    ),
  });
  await page.getByRole('button', { name: 'Импортировать 1000 SKU', exact: true }).click();
  await page.getByRole('button', { name: 'Найти изображения', exact: true }).click();
  await expect.poll(() => submitted).toBe(1);
  await expect(page.locator('.operation-bar')).toHaveCount(0);
  await page.reload();
  await expect(page.locator('.status-searching')).toHaveCount(1000);
  finished = true;
  await expect(page.locator('.status-not_found')).toHaveCount(1000);
  await expect(page.getByText(/Сохранено в браузере/).first()).toBeVisible();
  expect(submitted).toBe(1);
});
