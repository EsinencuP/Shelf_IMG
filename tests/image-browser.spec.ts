import { test, expect } from '@playwright/test';
import sharp from 'sharp';

// Technical fixture, not a product photograph or a sample for the user catalog.
// Opaque colored background forces real segmentation instead of the alpha shortcut.
const bottleSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="800" height="1200">
  <rect width="800" height="1200" fill="#dce4e9"/>
  <rect x="330" y="270" width="140" height="150" rx="20" fill="#15567d"/>
  <path d="M330 335 Q260 345 260 420 V920 Q260 990 325 990 H475 Q540 990 540 920 V420 Q540 345 470 335 Z" fill="#15567d"/>
  <rect x="310" y="170" width="180" height="120" rx="15" fill="#f17424"/>
  <path d="M328 190 V270 M346 190 V270 M364 190 V270 M382 190 V270 M400 190 V270 M418 190 V270 M436 190 V270 M454 190 V270 M472 190 V270" stroke="#ad4717" stroke-width="4"/>
  <rect x="280" y="475" width="240" height="260" rx="8" fill="#fff"/>
  <rect x="310" y="510" width="180" height="50" fill="#b62b43"/>
  <text x="400" y="548" fill="#fff" font-family="Arial" font-size="30" font-weight="bold" text-anchor="middle">TEST SKU</text>
  <text x="400" y="612" fill="#172938" font-family="Arial" font-size="40" text-anchor="middle">500 ml</text>
  <path d="M310 650 V704 M322 650 V704 M342 650 V704 M356 650 V704 M382 650 V704 M390 650 V704 M408 650 V704 M432 650 V704 M440 650 V704 M462 650 V704 M478 650 V704" stroke="#172938" stroke-width="5"/>
</svg>`;

test('real local U2NetP prepares a cropped white JPEG and preserves packaging detail', async ({
  page,
}, testInfo) => {
  test.setTimeout(120_000);
  const requests: string[] = [];
  const failures: string[] = [];
  page.on('request', (request) => requests.push(request.url()));
  page.on('pageerror', (error) => failures.push(error.message));
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Подготовка фотографий' })).toBeVisible();

  await page.getByRole('button', { name: 'Настройки', exact: true }).click();
  const settings = page.getByRole('dialog');
  await settings.getByLabel('Обработка фона').selectOption('ai');
  await settings.getByRole('button', { name: 'Готово', exact: true }).click();

  const csv = Buffer.from(
    'SKU,Наименование RU,Ширина мм,Высота мм,Глубина мм\nONNX-TEST,Технический тест обработки,70,205,70\n',
    'utf8',
  );
  await page
    .getByLabel('Загрузить Excel или CSV')
    .setInputFiles({ name: 'onnx-browser-test.csv', mimeType: 'text/csv', buffer: csv });
  const mapping = page.getByRole('dialog');
  await mapping.getByLabel('SKU / артикул').selectOption('0');
  await mapping.getByLabel('Наименование RU').selectOption('1');
  await mapping.getByRole('button', { name: 'Импортировать 1 SKU' }).click();
  await page.getByRole('button', { name: 'Открыть ONNX-TEST', exact: true }).click();

  const review = page.locator('aside.review-pane');
  const fixture = Buffer.from(await sharp(Buffer.from(bottleSvg)).png().toBuffer());
  await review.locator('input[type="file"]').setInputFiles({
    name: 'technical-fixture-bottle.png',
    mimeType: 'image/png',
    buffer: fixture,
  });
  const processingStartedAt = Date.now();
  await review.getByRole('button', { name: 'Подготовить JPG', exact: true }).click();
  const output = review.getByAltText('Подготовленный JPG на белом фоне');
  await expect(output, failures.join('\n')).toBeVisible({ timeout: 90_000 });
  await expect(review.getByRole('button', { name: 'Обработать снова', exact: true })).toBeEnabled();
  const processingMilliseconds = Date.now() - processingStartedAt;

  const result = await output.evaluate(async (image) => {
    const response = await fetch((image as HTMLImageElement).src);
    const blob = await response.blob();
    return { type: blob.type, bytes: Array.from(new Uint8Array(await blob.arrayBuffer())) };
  });
  const jpeg = Buffer.from(result.bytes);
  const metadata = await sharp(jpeg).metadata();
  expect(result.type).toBe('image/jpeg');
  expect(metadata.format).toBe('jpeg');
  expect(metadata.hasAlpha).toBe(false);
  expect(metadata.width).toBeGreaterThan(240);
  expect(metadata.width).toBeLessThan(400);
  expect(metadata.height).toBeGreaterThan(760);
  expect(metadata.height).toBeLessThan(950);
  expect(metadata.width! / metadata.height!).toBeLessThan(0.5);
  const { data, info } = await sharp(jpeg)
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const whitePixel = (x: number, y: number) => {
    const position = (y * info.width + x) * info.channels;
    return data[position] > 245 && data[position + 1] > 245 && data[position + 2] > 245;
  };
  // Bottle corners are outside the contour yet inside the opaque rectangular image.
  expect(whitePixel(3, 3)).toBe(true);
  expect(whitePixel(info.width - 4, 3)).toBe(true);
  expect(whitePixel(3, info.height - 4)).toBe(true);
  expect(whitePixel(info.width - 4, info.height - 4)).toBe(true);

  let orangeCap = 0,
    blueBody = 0,
    redLabel = 0,
    darkLabel = 0;
  for (let y = 0; y < info.height; y++)
    for (let x = 0; x < info.width; x++) {
      const p = (y * info.width + x) * info.channels;
      const r = data[p],
        g = data[p + 1],
        b = data[p + 2];
      if (r > 210 && g > 70 && g < 160 && b < 80) orangeCap++;
      if (r < 45 && g > 60 && g < 115 && b > 90 && b < 155) blueBody++;
      if (r > 140 && r < 220 && g < 70 && b > 40 && b < 105) redLabel++;
      if (y > info.height * 0.52 && y < info.height * 0.68 && r < 55 && g < 65 && b < 85)
        darkLabel++;
    }
  // Dominant interiors retain the original colors. Existing fine label bars remain visible.
  expect(orangeCap).toBeGreaterThan(15_000);
  expect(blueBody).toBeGreaterThan(90_000);
  expect(redLabel).toBeGreaterThan(5_000);
  expect(darkLabel).toBeGreaterThan(500);

  await expect
    .poll(
      () =>
        page.evaluate(
          () =>
            new Promise<string>((resolve, reject) => {
              const request = indexedDB.open('shelf-product-images', 1);
              request.onerror = () => reject(request.error);
              request.onsuccess = () => {
                const database = request.result;
                const transaction = database.transaction('batches', 'readonly');
                const rows = transaction.objectStore('batches').getAll();
                rows.onsuccess = () => {
                  const batch = rows.result.find(
                    (value: { name: string }) => value.name === 'onnx-browser-test',
                  );
                  resolve(batch?.rows?.[0]?.processingMethod ?? '');
                };
                rows.onerror = () => reject(rows.error);
                transaction.oncomplete = () => database.close();
              };
            }),
        ),
      { timeout: 10_000 },
    )
    .toBe('u2netp');

  expect(requests.some((url) => new URL(url).pathname === '/models/u2netp.onnx')).toBe(true);
  expect(requests.some((url) => url.includes('/onnx/') && url.includes('.wasm'))).toBe(true);
  await testInfo.attach('technical-fixture-input.png', { body: fixture, contentType: 'image/png' });
  await testInfo.attach('local-onnx-output.jpg', { body: jpeg, contentType: 'image/jpeg' });
  await testInfo.attach('local-onnx-pixel-check.json', {
    body: Buffer.from(
      JSON.stringify(
        {
          width: metadata.width,
          height: metadata.height,
          hasAlpha: metadata.hasAlpha,
          orangeCap,
          blueBody,
          redLabel,
          darkLabel,
          processingMilliseconds,
        },
        null,
        2,
      ),
    ),
    contentType: 'application/json',
  });
  const external = requests.filter(
    (url) =>
      url.startsWith('http') &&
      !['localhost', '127.0.0.1', '[::1]'].includes(new URL(url).hostname),
  );
  expect(external).toEqual([]);
  expect(failures).toEqual([]);
});

test('missing local model reports an error; white mode runs only after explicit selection', async ({
  page,
}) => {
  await page.route('**/models/u2netp.onnx', (route) =>
    route.fulfill({ status: 404, body: 'Model deliberately unavailable for this test.' }),
  );
  await page.goto('/');
  await page.getByLabel('Загрузить Excel или CSV').setInputFiles({
    name: 'explicit-fallback-test.csv',
    mimeType: 'text/csv',
    buffer: Buffer.from(
      'SKU,Наименование RU\nFALLBACK-TEST,Технический тест явного fallback\n',
      'utf8',
    ),
  });
  const mapping = page.getByRole('dialog');
  await mapping.getByLabel('SKU / артикул').selectOption('0');
  await mapping.getByLabel('Наименование RU').selectOption('1');
  await mapping.getByRole('button', { name: 'Импортировать 1 SKU' }).click();
  await page.getByRole('button', { name: 'Открыть FALLBACK-TEST', exact: true }).click();
  const review = page.locator('aside.review-pane');
  const fixture = Buffer.from(
    await sharp(Buffer.from(bottleSvg.replace('#dce4e9', '#ffffff')))
      .png()
      .toBuffer(),
  );
  await review
    .locator('input[type="file"]')
    .setInputFiles({ name: 'technical-white-bottle.png', mimeType: 'image/png', buffer: fixture });
  await review.getByRole('button', { name: 'Подготовить JPG', exact: true }).click();
  await expect(review.locator('.notice-inline.danger')).toContainText(
    'Нейросеть не выполнила обработку',
  );
  await expect(review.locator('.notice-inline.danger')).toContainText('Можно явно выбрать');
  await expect(review.getByAltText('Подготовленный JPG на белом фоне')).toHaveCount(0);
  await expect(review.getByRole('button', { name: 'Подготовить JPG', exact: true })).toBeEnabled();

  await page.getByRole('button', { name: 'Настройки', exact: true }).click();
  const settings = page.getByRole('dialog');
  await settings.getByLabel('Обработка фона').selectOption('white');
  await settings.getByRole('button', { name: 'Готово', exact: true }).click();
  await review.getByRole('button', { name: 'Подготовить JPG', exact: true }).click();
  await expect(review.getByAltText('Подготовленный JPG на белом фоне')).toBeVisible();
  await expect(review.locator('.notice-inline.danger')).toHaveCount(0);
  await expect(
    review.getByRole('button', { name: 'Подтвердить для экспорта', exact: true }),
  ).toBeDisabled();
});
