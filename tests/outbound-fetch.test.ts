import { afterEach, describe, expect, it, vi } from 'vitest';
import { outboundFetch, OUTBOUND_TIMEOUT_MS, USER_AGENT } from '../src/lib/server/outbound-fetch';
import { publicGet, type PublicResponse } from '../src/lib/server/public-fetch';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('outbound request policy', () => {
  it('applies defaults and preserves HTTP failures for source diagnostics', async () => {
    const timeout = vi.spyOn(AbortSignal, 'timeout');
    const response = new Response('blocked', { status: 403 });
    const fetcher = vi.fn(async () => response);
    vi.stubGlobal('fetch', fetcher);
    expect(await outboundFetch('https://shop.md/search?q=secret')).toBe(response);
    expect(timeout).toHaveBeenCalledWith(OUTBOUND_TIMEOUT_MS);
    expect(fetcher).toHaveBeenCalledWith('https://shop.md/search?q=secret', {
      cache: 'no-store',
      redirect: 'error',
      headers: { 'user-agent': USER_AGENT, referer: 'https://shop.md/' },
      signal: expect.any(AbortSignal),
    });
  });

  it('accepts case insensitive header overrides and sends only the page origin as Referer', async () => {
    const fetcher = vi.fn(async () => new Response('ok'));
    vi.stubGlobal('fetch', fetcher);
    await outboundFetch(new URL('https://cdn.shop.md/image.jpg'), {
      method: 'POST',
      body: '{}',
      timeoutMs: 250,
      userAgent: 'ignored by explicit header',
      referer: 'https://fallback.md/',
      headers: new Headers({
        'User-Agent': 'SourceSpecific/1',
        Referer: 'https://user:password@shop.md/product?token=private#section',
        Authorization: 'Bearer key',
        'Content-Type': 'application/json',
      }),
    });
    expect(fetcher.mock.calls[0]).toEqual([
      new URL('https://cdn.shop.md/image.jpg'),
      expect.objectContaining({
        method: 'POST',
        body: '{}',
        headers: {
          'user-agent': 'SourceSpecific/1',
          referer: 'https://shop.md/',
          authorization: 'Bearer key',
          'content-type': 'application/json',
        },
      }),
    ]);
  });

  it('times out an unresponsive transport even if it ignores cancellation', async () => {
    const transport = vi.fn(() => new Promise<Response>(() => {}));
    await expect(
      outboundFetch('https://shop.md/', { timeoutMs: 10 }, transport),
    ).rejects.toMatchObject({ name: 'TimeoutError' });
    expect(transport.mock.calls).toHaveLength(1);
  });

  it('combines caller cancellation with the timeout and preserves the abort reason', async () => {
    const controller = new AbortController();
    const reason = new Error('Search cancelled');
    let received: AbortSignal | undefined;
    const request = outboundFetch(
      'https://shop.md/',
      { signal: controller.signal, timeoutMs: 1000 },
      async (_url, options) => {
        received = options.signal;
        controller.abort(reason);
        return new Promise<Response>(() => {});
      },
    );
    await expect(request).rejects.toBe(reason);
    expect(received?.aborted).toBe(true);
  });

  it('does not dispatch an already cancelled request', async () => {
    const transport = vi.fn(async () => new Response());
    const reason = new DOMException('Cancelled', 'AbortError');
    await expect(
      outboundFetch('https://shop.md/', { signal: AbortSignal.abort(reason) }, transport),
    ).rejects.toBe(reason);
    expect(transport).not.toHaveBeenCalled();
  });

  it('keeps the deadline active while a fetch response body is being read', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async (_url, options) =>
          new Response(
            new ReadableStream({
              start(controller) {
                options.signal.addEventListener(
                  'abort',
                  () => controller.error(options.signal.reason),
                  { once: true },
                );
              },
            }),
          ),
      ),
    );
    const response = await outboundFetch('https://shop.md/', { timeoutMs: 10 });
    await expect(response.text()).rejects.toMatchObject({ name: 'TimeoutError' });
  });

  it('removes its abort listener when transport fails', async () => {
    const reason = new Error('Socket failure');
    let signal: AbortSignal | undefined;
    const remove = vi.spyOn(AbortSignal.prototype, 'removeEventListener');
    await expect(
      outboundFetch('https://shop.md/', {}, async (_url, options) => {
        signal = options.signal;
        throw reason;
      }),
    ).rejects.toBe(reason);
    expect(remove).toHaveBeenCalledWith('abort', expect.any(Function));
    expect(signal?.aborted).toBe(false);
  });

  it.each([0, -1, NaN, Infinity, 1.5])(
    'rejects invalid timeout %s before dispatch',
    async (timeoutMs) => {
      const transport = vi.fn(async () => new Response());
      await expect(
        outboundFetch('https://shop.md/', { timeoutMs }, transport),
      ).rejects.toBeInstanceOf(RangeError);
      expect(transport).not.toHaveBeenCalled();
    },
  );
});

describe('public URL transport uses outbound policy', () => {
  const resolver = async () => [{ address: '8.8.8.8', family: 4 }];
  const result: PublicResponse = {
    status: 200,
    headers: {},
    body: Buffer.from('image'),
    url: 'https://cdn.shop.md/image.jpg',
  };
  it('retains DNS pinning and passes common headers and signal to the transport', async () => {
    const transport = vi.fn(async () => result);
    await publicGet(
      result.url,
      { referer: 'https://shop.md/product?q=private', userAgent: 'Images/1' },
      { resolver, transport },
    );
    expect(transport).toHaveBeenCalledWith(
      new URL(result.url),
      { address: '8.8.8.8', family: 4 },
      expect.objectContaining({
        headers: {
          accept: 'image/jpeg,image/png,image/webp',
          'accept-encoding': 'identity',
          'user-agent': 'Images/1',
          referer: 'https://shop.md/',
        },
        signal: expect.any(AbortSignal),
      }),
    );
  });

  it('cancels a pending DNS lookup before any network transport is used', async () => {
    const controller = new AbortController();
    const transport = vi.fn(async () => result);
    const reason = new Error('Cancelled during DNS');
    const pending = publicGet(
      result.url,
      { signal: controller.signal },
      {
        resolver: () => new Promise(() => {}),
        transport,
      },
    );
    controller.abort(reason);
    await expect(pending).rejects.toBe(reason);
    expect(transport).not.toHaveBeenCalled();
  });

  it('passes cancellation to an active image request', async () => {
    const controller = new AbortController();
    const reason = new Error('Cancelled image');
    const pending = publicGet(
      result.url,
      { signal: controller.signal },
      {
        resolver,
        transport: async (_url, _address, options) => {
          controller.abort(reason);
          expect(options.signal?.aborted).toBe(true);
          return new Promise(() => {});
        },
      },
    );
    await expect(pending).rejects.toBe(reason);
  });

  it('checks credentials case insensitively before following a public redirect', async () => {
    const transport = vi.fn(async () => ({
      ...result,
      status: 302,
      headers: { location: 'https://other.md/' },
    }));
    await expect(
      publicGet(
        result.url,
        { headers: { authorization: 'Bearer secret' } },
        { resolver, transport },
      ),
    ).rejects.toThrow('Перенаправление');
    expect(transport).toHaveBeenCalledTimes(1);
  });
});
