import { afterEach, expect, it, vi } from 'vitest';
import sharp from 'sharp';
import { GET } from '../src/app/api/image/route';
import { publicGet } from '../src/lib/server/public-fetch';
vi.mock('../src/lib/server/public-fetch', async (original) => ({
  ...(await original<typeof import('../src/lib/server/public-fetch')>()),
  publicGet: vi.fn(),
}));
afterEach(() => {
  vi.resetAllMocks();
  vi.unstubAllEnvs();
});
const small = 'https://img1.zakaz.md/98f3eea0d4f44065b0fda29bd5cf5a39/1753674045-s350x350.jpg';
const full = small.replace('350x350', '1350x1350');
function request(url = small) {
  vi.stubEnv('MVP_ACCESS_PASSWORD', 'admin');
  return new Request(
    'https://shelf.site/api/image?url=' +
      encodeURIComponent(url) +
      '&page=' +
      encodeURIComponent('https://metro.zakaz.md/ro/products/test'),
    { headers: { Authorization: 'Basic ' + Buffer.from('admin:admin').toString('base64') } },
  );
}
async function photo(width = 350) {
  return sharp({ create: { width, height: width, channels: 3, background: '#fff' } })
    .jpeg()
    .toBuffer();
}
it('downloads the existing full rendition of the same Zakaz asset without fetching the thumbnail', async () => {
  const body = await photo(1350);
  vi.mocked(publicGet).mockResolvedValue({ status: 200, body, url: full, headers: {} });
  const response = await GET(request());
  expect(response.status).toBe(200);
  expect(response.headers.get('X-Shelf-Image-Upgraded')).toBe('true');
  expect(await response.arrayBuffer()).toEqual(
    body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength),
  );
  expect(publicGet).toHaveBeenCalledOnce();
  expect(publicGet).toHaveBeenCalledWith(
    full,
    expect.objectContaining({
      maxBytes: 4000000,
      referer: 'https://metro.zakaz.md/ro/products/test',
    }),
  );
});
it.each(['missing', 'corrupt', 'blocked'] as const)(
  'retains a usable thumbnail when the full rendition is %s',
  async (failure) => {
    if (failure === 'blocked') vi.mocked(publicGet).mockRejectedValueOnce(new Error('HTTP 403'));
    else
      vi.mocked(publicGet).mockResolvedValueOnce({
        status: failure === 'missing' ? 404 : 200,
        body: Buffer.from('invalid'),
        url: full,
        headers: {},
      });
    const body = await photo();
    vi.mocked(publicGet).mockResolvedValueOnce({ status: 200, body, url: small, headers: {} });
    const response = await GET(request());
    expect(response.status).toBe(200);
    expect(response.headers.get('X-Shelf-Image-Upgraded')).toBeNull();
    expect((await sharp(Buffer.from(await response.arrayBuffer())).metadata()).width).toBe(350);
    expect(vi.mocked(publicGet).mock.calls.map((args) => args[0])).toEqual([full, small]);
  },
);
it('does not rewrite signed URLs or similar paths on another host', async () => {
  for (const url of [small + '?signature=test', small.replace('img1.zakaz.md', 'images.shop.md')]) {
    vi.mocked(publicGet).mockResolvedValueOnce({
      status: 200,
      body: await photo(),
      url,
      headers: {},
    });
    await GET(request(url));
  }
  expect(vi.mocked(publicGet).mock.calls.map((args) => args[0])).toEqual([
    small + '?signature=test',
    small.replace('img1.zakaz.md', 'images.shop.md'),
  ]);
});
it('honors a rate limit on the full rendition without immediately retrying the thumbnail', async () => {
  vi.mocked(publicGet).mockResolvedValue({
    status: 429,
    body: Buffer.from('Limited'),
    url: full,
    headers: { 'retry-after': '120' },
  });
  const response = await GET(request());
  expect(response.status).toBe(429);
  expect(response.headers.get('Retry-After')).toBe('120');
  expect(publicGet).toHaveBeenCalledOnce();
});
