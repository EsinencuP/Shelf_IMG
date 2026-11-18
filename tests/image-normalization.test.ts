import { afterEach, expect, it, vi } from 'vitest';
import sharp from 'sharp';
import { normalizeSourceImage } from '../src/lib/server/image';
import { POST } from '../src/app/api/image/route';
const input = () =>
  sharp({
    create: {
      width: 60,
      height: 90,
      channels: 4,
      background: { r: 20, g: 70, b: 100, alpha: 0.5 },
    },
  });
afterEach(() => vi.unstubAllEnvs());
it.each(['avif', 'gif', 'tiff'] as const)(
  'normalizes static %s without resizing or removing transparency',
  async (format) => {
    const bytes = await (
      format === 'tiff' ? input().tiff({ compression: 'deflate' }) : input().toFormat(format)
    ).toBuffer();
    const result = await normalizeSourceImage(bytes);
    const metadata = await sharp(result.body).metadata();
    expect(result.converted).toBe(true);
    expect(result.mime).toBe('image/png');
    expect(metadata.width).toBe(60);
    expect(metadata.height).toBe(90);
    expect(metadata.hasAlpha).toBe(true);
  },
);
it('preserves supported image bytes exactly', async () => {
  const bytes = await input().png().toBuffer();
  const normalized = await normalizeSourceImage(bytes);
  expect(normalized.body).toEqual(bytes);
  expect(normalized.converted).toBe(false);
});
it('rejects JPEGs with readable headers and truncated pixels', async () => {
  const jpeg = await input().flatten().jpeg().toBuffer();
  const truncated = jpeg.subarray(0, jpeg.length - 20);
  expect((await sharp(truncated).metadata()).width).toBe(60);
  await expect(normalizeSourceImage(truncated)).rejects.toMatchObject({ status: 422 });
});
it('rejects disguised SVG, truncated formats, oversized files and excessive pixels', async () => {
  await expect(normalizeSourceImage(Buffer.from('<svg/>'))).rejects.toMatchObject({ status: 415 });
  await expect(normalizeSourceImage(Buffer.from('GIF89a'))).rejects.toMatchObject({ status: 422 });
  await expect(normalizeSourceImage(Buffer.alloc(4000001))).rejects.toMatchObject({ status: 413 });
  const large = await sharp({
    create: { width: 5000, height: 5000, channels: 3, background: '#fff' },
  })
    .png()
    .toBuffer();
  await expect(normalizeSourceImage(large)).rejects.toMatchObject({ status: 422 });
});
it('rejects a multiframe GIF instead of silently choosing a frame', async () => {
  const pixels = Buffer.alloc(60 * 180 * 4, 128);
  pixels.fill(255, 60 * 90 * 4);
  const bytes = await sharp(pixels, {
    raw: { width: 60, height: 180, channels: 4, pageHeight: 90 },
  })
    .gif({ delay: [100, 100] })
    .toBuffer();
  expect((await sharp(bytes).metadata()).pages).toBe(2);
  await expect(normalizeSourceImage(bytes)).rejects.toMatchObject({ status: 422 });
});
it('authorizes and validates origin before converting uploads', async () => {
  vi.stubEnv('NODE_ENV', 'production');
  vi.stubEnv('MVP_ACCESS_PASSWORD', 'admin');
  const request = (origin: string, authorized: boolean, type = 'application/octet-stream') =>
    new Request('https://shelf.site/api/image', {
      method: 'POST',
      headers: {
        Origin: origin,
        'Content-Type': type,
        ...(authorized
          ? { Authorization: 'Basic ' + Buffer.from('admin:admin').toString('base64') }
          : {}),
      },
      body: new Uint8Array([1, 2, 3]),
    });
  expect((await POST(request('https://shelf.site', false))).status).toBe(401);
  expect((await POST(request('https://foreign.site', true))).status).toBe(403);
  expect(await POST(request('https://shelf.site', true, 'text/html'))).toHaveProperty(
    'status',
    415,
  );
});
it('converts an authorized AVIF upload on the actual route', async () => {
  vi.stubEnv('NODE_ENV', 'production');
  vi.stubEnv('MVP_ACCESS_PASSWORD', 'admin');
  const bytes = await input().avif().toBuffer();
  const result = await POST(
    new Request('https://shelf.site/api/image', {
      method: 'POST',
      headers: {
        Origin: 'https://shelf.site',
        'Content-Type': 'application/octet-stream',
        Authorization: 'Basic ' + Buffer.from('admin:admin').toString('base64'),
      },
      body: new Uint8Array(bytes),
    }),
  );
  expect(result.status).toBe(200);
  expect(result.headers.get('content-type')).toBe('image/png');
  expect((await sharp(Buffer.from(await result.arrayBuffer())).metadata()).hasAlpha).toBe(true);
});
