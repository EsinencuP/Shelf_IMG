import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  outboundFetch,
  RelayOfflineError,
  type OutboundFetchOptions,
} from '../src/lib/server/outbound-fetch';
import { publicGet, type Transport } from '../src/lib/server/public-fetch';
import { sourceFailureDetails } from '../src/lib/source-status';
import { ApiError } from '../src/lib/server/http';
import { createRelayHandler, readRelayConfig } from '../infra/relay/server';
import { probeSources } from '../src/lib/server/probe-sources';

const token = 'unit-test-only-relay-token-1234567890';
const target = 'https://metro.zakaz.md/ru/';
const endpoint = 'https://home.tailnet.ts.net/fetch';
const resolver = async () => [{ address: '93.184.216.34', family: 4 }];
const reply = (status = 200, body = '<html>METRO</html>') =>
  new Response(body, {
    status,
    headers: {
      'Content-Type': 'text/html',
      'X-Shelf-Relay': '1',
      'X-Shelf-Upstream-Status': String(status),
      'X-Shelf-Upstream-Url': target,
    },
  });
beforeEach(() => {
  vi.stubEnv('RELAY_URL', 'https://home.tailnet.ts.net');
  vi.stubEnv('RELAY_TOKEN', token);
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('outboundFetch home relay retry', () => {
  it.each([403, 406, 408, 429, 451, 502, 503, 504])(
    'recovers HTTP %s with exactly one authenticated relay POST',
    async (status) => {
      const fetcher = vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(new Response('blocked', { status }))
        .mockResolvedValueOnce(reply());
      vi.stubGlobal('fetch', fetcher);
      const result = await outboundFetch(target);
      expect(result.status).toBe(200);
      expect(await result.text()).toBe('<html>METRO</html>');
      expect(fetcher).toHaveBeenCalledTimes(2);
      const [url, init] = fetcher.mock.calls[1];
      expect(String(url)).toBe(endpoint);
      expect(init).toMatchObject({ method: 'POST', redirect: 'error', cache: 'no-store' });
      expect(new Headers(init?.headers).get('authorization')).toBe(`Bearer ${token}`);
      expect(JSON.parse(init?.body as string)).toEqual({ url: target });
      expect(new Headers(fetcher.mock.calls[0][1]?.headers).has('authorization')).toBe(false);
    },
  );

  it.each([200, 401, 404, 413, 500])('preserves ordinary HTTP %s without retry', async (status) => {
    const direct = new Response('direct', { status });
    const fetcher = vi.fn(async () => direct);
    vi.stubGlobal('fetch', fetcher);
    expect(await outboundFetch(target)).toBe(direct);
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it('recovers a direct timeout with a fresh, bounded relay attempt', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockImplementationOnce(() => new Promise(() => {}))
      .mockResolvedValueOnce(reply());
    vi.stubGlobal('fetch', fetcher);
    expect((await outboundFetch(target, { timeoutMs: 10 })).status).toBe(200);
    const direct = fetcher.mock.calls[0][1]?.signal;
    const relay = fetcher.mock.calls[1][1]?.signal;
    expect(direct?.aborted).toBe(true);
    expect(relay).not.toBe(direct);
    expect(relay?.aborted).toBe(false);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('recovers a socket block reported as a fetch failure cause', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockRejectedValueOnce(new TypeError('fetch failed', { cause: { code: 'ECONNRESET' } }))
      .mockResolvedValueOnce(reply());
    vi.stubGlobal('fetch', fetcher);
    expect((await outboundFetch(target)).status).toBe(200);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it.each<OutboundFetchOptions>([
    { relay: false },
    { method: 'POST', body: '{}' },
    { method: 'HEAD' },
    { headers: { Authorization: 'Bearer source-secret' } },
    { headers: { Cookie: 'source=secret' } },
    { headers: { 'X-Subscription-Token': 'source-secret' } },
    { headers: { 'X-Secret': 'source-secret' } },
  ])('does not replay disabled, non-GET or credentialled requests (%j)', async (options) => {
    const fetcher = vi.fn(async () => new Response('blocked', { status: 403 }));
    vi.stubGlobal('fetch', fetcher);
    expect((await outboundFetch(target, options)).status).toBe(403);
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it.each(['https://127.0.0.1/', 'http://127.0.0.1:8080/', 'https://localhost/'])(
    'does not relay internal source URL %s',
    async (url) => {
      const fetcher = vi.fn(async () => new Response('blocked', { status: 403 }));
      vi.stubGlobal('fetch', fetcher);
      expect((await outboundFetch(url)).status).toBe(403);
      expect(fetcher).toHaveBeenCalledOnce();
    },
  );

  it.each(['RELAY_URL', 'RELAY_TOKEN'])('keeps the original result without %s', async (key) => {
    vi.stubEnv(key, '');
    const fetcher = vi.fn(async () => new Response('blocked', { status: 403 }));
    vi.stubGlobal('fetch', fetcher);
    expect((await outboundFetch(target)).status).toBe(403);
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it('preserves a caller cancellation without attempting relay', async () => {
    const controller = new AbortController();
    const error = new Error('caller cancelled');
    const fetcher = vi.fn(async () => {
      controller.abort(error);
      throw error;
    });
    vi.stubGlobal('fetch', fetcher);
    await expect(outboundFetch(target, { signal: controller.signal })).rejects.toBe(error);
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it.each([403, 429, 503])(
    'returns relay upstream HTTP %s without a second retry',
    async (status) => {
      const fetcher = vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(new Response('blocked', { status: 403 }))
        .mockResolvedValueOnce(reply(status, 'upstream denial'));
      vi.stubGlobal('fetch', fetcher);
      expect((await outboundFetch(target)).status).toBe(status);
      expect(fetcher).toHaveBeenCalledTimes(2);
    },
  );
});

describe('relay unavailable diagnostics and deadlines', () => {
  it.each(['connection refused', 'no response', 'body stalled', 'bad token', 'bad protocol'])(
    'reports relay_offline for %s without waiting indefinitely',
    async (failure) => {
      const fetcher = vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(new Response('blocked', { status: 403 }));
      if (failure === 'connection refused')
        fetcher.mockRejectedValueOnce(new Error('socket ' + token));
      else if (failure === 'no response')
        fetcher.mockImplementationOnce(() => new Promise(() => {}));
      else if (failure === 'body stalled')
        fetcher.mockResolvedValueOnce(
          new Response(new ReadableStream({ start() {} }), {
            headers: { 'X-Shelf-Upstream-Status': '200', 'X-Shelf-Upstream-Url': target },
          }),
        );
      else if (failure === 'bad token')
        fetcher.mockResolvedValueOnce(new Response('secret ' + token, { status: 401 }));
      else fetcher.mockResolvedValueOnce(new Response('<html>tunnel login</html>'));
      vi.stubGlobal('fetch', fetcher);
      const error = await outboundFetch(target, { timeoutMs: 10 }).catch((error: unknown) => error);
      expect(error).toBeInstanceOf(RelayOfflineError);
      expect(sourceFailureDetails(error)).toMatchObject({ status: 'relay_offline' });
      expect(JSON.stringify(sourceFailureDetails(error))).not.toContain(token);
      expect(fetcher).toHaveBeenCalledTimes(2);
    },
    1000,
  );

  it.each([
    'http://unsafe.md',
    'https://user:secret@home.ts.net',
    'https://home.ts.net/?token=secret',
    'not a URL',
  ])('fails safely for invalid RELAY_URL %s', async (url) => {
    vi.stubEnv('RELAY_URL', url);
    const fetcher = vi.fn(async () => new Response('blocked', { status: 403 }));
    vi.stubGlobal('fetch', fetcher);
    await expect(outboundFetch(target)).rejects.toBeInstanceOf(RelayOfflineError);
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it('allows loopback relay locally but rejects it on Vercel', async () => {
    vi.stubEnv('RELAY_URL', 'http://127.0.0.1:8787');
    vi.stubEnv('VERCEL', '');
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response('blocked', { status: 403 }))
      .mockResolvedValueOnce(reply());
    vi.stubGlobal('fetch', fetcher);
    expect((await outboundFetch(target)).status).toBe(200);
    expect(String(fetcher.mock.calls[1][0])).toBe('http://127.0.0.1:8787/fetch');
    vi.stubEnv('VERCEL', '1');
    fetcher.mockResolvedValueOnce(new Response('blocked', { status: 403 }));
    await expect(outboundFetch(target)).rejects.toBeInstanceOf(RelayOfflineError);
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it('bounds relay payloads by the caller byte limit', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response('blocked', { status: 403 }))
      .mockResolvedValueOnce(reply(200, 'x'.repeat(101)));
    vi.stubGlobal('fetch', fetcher);
    await expect(outboundFetch(target, { maxBytes: 100 })).rejects.toMatchObject({ status: 413 });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it.each([
    { status: 302, url: target },
    { status: 200, url: 'https://127.0.0.1/' },
  ])('rejects unsafe or redirecting relay metadata (%j)', async ({ status, url }) => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response('blocked', { status: 403 }))
      .mockResolvedValueOnce(
        new Response('invalid', {
          status,
          headers: {
            'X-Shelf-Upstream-Status': String(status),
            'X-Shelf-Upstream-Url': url,
          },
        }),
      );
    vi.stubGlobal('fetch', fetcher);
    await expect(outboundFetch(target)).rejects.toBeInstanceOf(RelayOfflineError);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it.each([403, 413, 422, 429, 504])(
    'keeps the relay application error HTTP %s distinct from offline',
    async (status) => {
      const fetcher = vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(new Response('blocked', { status: 403 }))
        .mockResolvedValueOnce(
          new Response('policy rejection', { status, headers: { 'X-Shelf-Relay': '1' } }),
        );
      vi.stubGlobal('fetch', fetcher);
      const error = await outboundFetch(target).catch((error: unknown) => error);
      expect(error).toBeInstanceOf(ApiError);
      expect(error).not.toBeInstanceOf(RelayOfflineError);
      expect(sourceFailureDetails(error).status).not.toBe('relay_offline');
    },
  );
});

describe('relay wiring', () => {
  it('preserves a bodyless upstream response for publicGet', async () => {
    const fetcher = vi.fn(
      async () =>
        new Response(null, {
          status: 204,
          headers: {
            'X-Shelf-Upstream-Status': '204',
            'X-Shelf-Upstream-Url': target,
          },
        }),
    );
    vi.stubGlobal('fetch', fetcher);
    const transport = vi.fn<Transport>(async () => ({
      status: 403,
      headers: {},
      body: Buffer.alloc(0),
      url: target,
    }));
    const result = await publicGet(target, {}, { resolver, transport });
    expect(result.status).toBe(204);
    expect(result.body.length).toBe(0);
    expect(fetcher).toHaveBeenCalledOnce();
  });
  it('round-trips the actual relay handler contract without network calls', async () => {
    const config = readRelayConfig({ RELAY_TOKEN: token, RELAY_ALLOWED_DOMAINS: 'metro.zakaz.md' });
    const upstream = vi.fn<Transport>(async () => ({
      status: 200,
      url: target,
      headers: { 'content-type': 'text/html' },
      body: Buffer.from('<html>home</html>'),
    }));
    const handler = createRelayHandler(config, { resolver, transport: upstream });
    const fetcher = vi.fn<typeof fetch>(async (url, init) => {
      expect(String(url)).toBe(endpoint);
      return handler(new Request(url, init));
    });
    vi.stubGlobal('fetch', fetcher);
    const result = await outboundFetch(
      target,
      {},
      async () => new Response('blocked', { status: 403 }),
    );
    expect(result.status).toBe(200);
    expect(await result.text()).toBe('<html>home</html>');
    expect(fetcher).toHaveBeenCalledOnce();
    expect(upstream).toHaveBeenCalledOnce();
  });

  it('returns PublicResponse bytes and original source URL for catalog/image callers', async () => {
    const fetcher = vi.fn(async () => reply());
    vi.stubGlobal('fetch', fetcher);
    const transport = vi.fn<Transport>(async () => ({
      status: 403,
      headers: {},
      body: Buffer.alloc(0),
      url: target,
    }));
    const result = await publicGet(target, { maxBytes: 1000 }, { resolver, transport });
    expect(result).toMatchObject({ status: 200, url: target });
    expect(result.body.toString()).toBe('<html>METRO</html>');
    expect(transport).toHaveBeenCalledOnce();
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it('preserves relay_offline for publicGet diagnostics', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('offline ' + token);
      }),
    );
    const transport = vi.fn<Transport>(async () => ({
      status: 403,
      headers: {},
      body: Buffer.alloc(0),
      url: target,
    }));
    const error = await publicGet(target, {}, { resolver, transport }).catch(
      (error: unknown) => error,
    );
    expect(sourceFailureDetails(error)).toMatchObject({ status: 'relay_offline' });
    expect(transport).toHaveBeenCalledOnce();
  });

  it('does not add the legacy cloud fallback after the home relay', async () => {
    vi.stubEnv('VERCEL', '1');
    vi.stubEnv('SHELF_WORKER_URL', 'https://worker.neon.tech/');
    vi.stubEnv('SHELF_WORKER_SECRET', 'unit-test-cloud-secret');
    const fetcher = vi.fn<typeof fetch>(async () => reply(403));
    vi.stubGlobal('fetch', fetcher);
    const transport = vi.fn<Transport>(async () => ({
      status: 403,
      headers: {},
      body: Buffer.alloc(0),
      url: target,
    }));
    expect((await publicGet(target, {}, { resolver, transport })).status).toBe(403);
    expect(fetcher).toHaveBeenCalledOnce();
    expect(String(fetcher.mock.calls[0]?.[0])).toBe(endpoint);
    expect(transport).toHaveBeenCalledOnce();
  });

  it('does not recurse when the home relay itself has relay env settings', async () => {
    const native = vi.fn<typeof fetch>();
    vi.stubGlobal('fetch', native);
    const config = readRelayConfig({ RELAY_TOKEN: token, RELAY_ALLOWED_DOMAINS: 'metro.zakaz.md' });
    const transport = vi.fn<Transport>(async () => ({
      status: 403,
      headers: {},
      body: Buffer.alloc(0),
      url: target,
    }));
    const handler = createRelayHandler(config, { resolver, transport });
    const response = await handler(
      new Request(endpoint, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: target }),
      }),
    );
    expect(response.status).toBe(403);
    expect(response.headers.get('x-shelf-relay')).toBe('1');
    expect(native).not.toHaveBeenCalled();
  });

  it('keeps probe direct even with configured relay', async () => {
    const native = vi.fn<typeof fetch>();
    vi.stubGlobal('fetch', native);
    const direct = vi.fn<typeof fetch>(async () => new Response('blocked', { status: 403 }));
    const report = await probeSources({ env: {}, fetch: direct, sleep: async () => {} });
    expect(report.results.some((row) => row.status === 'blocked')).toBe(true);
    expect(native).not.toHaveBeenCalled();
    expect(direct.mock.calls.every(([url]) => String(url) !== endpoint)).toBe(true);
  });
});
