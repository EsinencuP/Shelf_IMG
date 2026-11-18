import { afterEach, describe, expect, it, vi } from 'vitest';
import { brotliCompressSync, deflateSync, gzipSync } from 'node:zlib';
import { ApiError } from '../src/lib/server/http';
import {
  cloudGet,
  decodeResponseBody,
  publicGet,
  type GetOptions,
  type PublicResponse,
} from '../src/lib/server/public-fetch';

const url = 'https://images.shop.md/front.jpg';
const response = (status: number): PublicResponse => ({
  status,
  url,
  headers: { 'content-type': 'image/jpeg' },
  body: Buffer.from('image'),
});
const resolver = vi.fn(async () => [{ address: '93.184.216.34', family: 4 }]);
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('bounded decompression', () => {
  it.each([
    ['gzip', gzipSync],
    ['br', brotliCompressSync],
    ['deflate', deflateSync],
  ] as const)('reads %s while bounding decoded bytes', (encoding, compress) => {
    const original = Buffer.from('catalog response '.repeat(100));
    const bytes = compress(original);
    expect(decodeResponseBody(bytes, encoding, 2000)).toEqual(original);
    expect(() => decodeResponseBody(bytes, encoding, 100)).toThrow(/превышает/);
  });
  it('rejects corrupted and unknown encodings', () => {
    expect(() => decodeResponseBody(Buffer.from('bad'), 'gzip', 100)).toThrow(/повреждённый/);
    expect(() => decodeResponseBody(Buffer.from('bad'), 'zip', 100)).toThrow(/Неизвестное/);
  });
});

describe('secondary cloud egress', () => {
  it.each([403, 406, 500, 502, 503, 504])(
    'recovers public GET HTTP %s through the cloud',
    async (status) => {
      const cloud = vi.fn(async () => response(200));
      const result = await publicGet(
        url,
        {},
        { resolver, transport: vi.fn(async () => response(status)), cloud },
      );
      expect(result.status).toBe(200);
      expect(cloud).toHaveBeenCalledOnce();
    },
  );
  it.each([401, 404, 429])(
    'preserves authorization, missing resources and quotas (%s)',
    async (status) => {
      const cloud = vi.fn();
      expect(
        (
          await publicGet(
            url,
            {},
            { resolver, transport: vi.fn(async () => response(status)), cloud },
          )
        ).status,
      ).toBe(status);
      expect(cloud).not.toHaveBeenCalled();
    },
  );
  it.each([
    { method: 'POST', body: '{}' },
    { headers: { Authorization: 'secret' } },
    { cloudFallback: false },
    { followRedirects: false },
  ] as GetOptions[])(
    'does not relay service credentials or disabled calls (%j)',
    async (options) => {
      const cloud = vi.fn();
      await publicGet(url, options, {
        resolver,
        transport: vi.fn(async () => response(403)),
        cloud,
      });
      expect(cloud).not.toHaveBeenCalled();
    },
  );
  it('checks private DNS before contacting either egress', async () => {
    const transport = vi.fn(),
      cloud = vi.fn();
    await expect(
      publicGet(
        url,
        {},
        { resolver: async () => [{ address: '127.0.0.1', family: 4 }], transport, cloud },
      ),
    ).rejects.toMatchObject({ status: 422 });
    expect(transport).not.toHaveBeenCalled();
    expect(cloud).not.toHaveBeenCalled();
  });
  it('recovers a socket failure but preserves the original failure if fallback fails', async () => {
    const transport = vi.fn(async () => {
      throw new ApiError(504, 'timeout');
    });
    expect(
      (await publicGet(url, {}, { resolver, transport, cloud: vi.fn(async () => response(200)) }))
        .status,
    ).toBe(200);
    await expect(
      publicGet(
        url,
        {},
        {
          resolver,
          transport,
          cloud: vi.fn(async () => {
            throw new Error('unavailable');
          }),
        },
      ),
    ).rejects.toMatchObject({ status: 504 });
  });
  it('keeps upstream denial if the second egress is unavailable', async () => {
    const result = await publicGet(
      url,
      {},
      {
        resolver,
        transport: vi.fn(async () => response(403)),
        cloud: vi.fn(async () => response(403)),
      },
    );
    expect(result.status).toBe(403);
  });
  it('sends only source fetch parameters to the configured authenticated Function', async () => {
    vi.stubEnv('VERCEL', '1');
    vi.stubEnv('SHELF_WORKER_URL', 'https://worker.neon.tech/');
    vi.stubEnv('SHELF_WORKER_SECRET', 'origin-secret');
    const fetcher = vi.fn<typeof fetch>(
      async () =>
        new Response('photo', {
          headers: {
            'x-shelf-upstream-status': '200',
            'x-shelf-upstream-url': url,
            'content-type': 'image/jpeg',
          },
        }),
    );
    vi.stubGlobal('fetch', fetcher);
    const result = await cloudGet(url, { maxBytes: 100, timeoutMs: 8000 });
    expect(result?.body.toString()).toBe('photo');
    expect(String(fetcher.mock.calls[0][0])).toBe('https://worker.neon.tech/fetch');
    const options = fetcher.mock.calls[0][1] as RequestInit;
    expect(options.redirect).toBe('manual');
    expect(JSON.parse(options.body as string)).toEqual({ url, maxBytes: 100, timeoutMs: 8000 });
    expect(options.headers).toMatchObject({ 'x-secret': 'origin-secret' });
  });
});
