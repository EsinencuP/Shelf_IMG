import { test, expect } from '@playwright/test';
import sharp from 'sharp';

test('AVIF, static GIF and TIFF uploads use the cloud converter and produce a cropped opaque JPEG', async ({
  page,
}) => {
  const converterRequests: string[] = [];
  page.on('request', (request) => {
    if (request.method() === 'POST' && new URL(request.url()).pathname === '/api/image')
      converterRequests.push(request.headers()['content-type']);
  });
  await page.goto('/');
  await page.getByLabel('Загрузить Excel или CSV').setInputFiles({
    name: 'formats.csv',
    mimeType: 'text/csv',
    buffer: Buffer.from('SKU,Наименование RU\nFORMATS,Техническая упаковка\n'),
  });
  await page.getByRole('dialog').getByRole('button', { name: 'Импортировать 1 SKU' }).click();
  await page.getByRole('button', { name: 'Открыть FORMATS', exact: true }).click();
  const review = page.locator('aside.review-pane');
  const fixture = Buffer.from(
    '<svg xmlns="http://www.w3.org/2000/svg" width="300" height="500"><rect x="70" y="70" width="160" height="360" rx="12" fill="#235a8f"/><rect x="100" y="160" width="100" height="100" fill="#fff"/></svg>',
  );
  for (const format of ['avif', 'gif', 'tiff'] as const) {
    const source = sharp(fixture);
    const bytes = await (
      format === 'tiff' ? source.tiff({ compression: 'deflate' }) : source.toFormat(format)
    ).toBuffer();
    await review
      .locator('input[type=file]')
      .setInputFiles({ name: 'technical.' + format, mimeType: 'image/' + format, buffer: bytes });
    await expect(review.getByAltText('Исходная фотография товара')).toBeVisible();
    await review.getByRole('button', { name: 'Подготовить JPG', exact: true }).click();
    const output = review.getByAltText('Подготовленный JPG на белом фоне');
    await expect(output).toBeVisible();
    const result = await output.evaluate(async (element) =>
      Array.from(
        new Uint8Array(await (await fetch((element as HTMLImageElement).src)).arrayBuffer()),
      ),
    );
    const metadata = await sharp(Buffer.from(result)).metadata();
    expect(metadata.format).toBe('jpeg');
    expect(metadata.hasAlpha).toBe(false);
    expect(metadata.width).toBeLessThan(200);
    expect(metadata.height).toBeLessThan(420);
    expect(metadata.height).toBeGreaterThan(300);
    await review.getByRole('button', { name: 'Выбрать другую фотографию', exact: true }).click();
  }
  expect(converterRequests).toEqual(Array(3).fill('application/octet-stream'));
});
