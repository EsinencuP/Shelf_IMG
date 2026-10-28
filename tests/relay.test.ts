import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRelayHandler, readRelayConfig } from '../infra/relay/server';
import { ApiError } from '../src/lib/server/http';
import type { Transport } from '../src/lib/server/public-fetch';

const token = 'unit-test-only-relay-token-1234567890';
const env = {
  RELAY_TOKEN: token,
  RELAY_ALLOWED_DOMAINS: 'metro.zakaz.md,api.metro.zakaz.md',
};
const config = () => readRelayConfig(env);
const fetchRequest = (
  input: unknown = { url: 'https://metro.zakaz.md/ru/' },
  headers: Record<string, string> = {},
) =>
  new Request('http://relay.local/fetch', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(input),
  });
const setup = () => {
  const resolver = vi.fn(async () => [{ address: '93.184.216.34', family: 4 }]);
  const transport = vi.fn<Transport>(async (url) => ({
    status: 200,
    url: url.href,
    headers: { 'content-type': 'text/html; charset=utf-8', 'set-cookie': 'upstream=private' },
    body: Buffer.from('<html>METRO</html>'),
  }));
  return { resolver, transport, handler: createRelayHandler(config(), { resolver, transport }) };
};
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('relay startup configuration', () => {
  it('uses bounded defaults and exact, deduplicated hostnames', () => {
    const result = readRelayConfig({
      ...env,
      RELAY_ALLOWED_DOMAINS: 'METRO.ZAKAZ.MD, metro.zakaz.md',
    });
    expect(result).toMatchObject({
      host: '127.0.0.1',
      port: 8787,
      maxBytes: 4000000,
      timeoutMs: 15000,
    });
    expect([...result.allowedHosts]).toEqual(['metro.zakaz.md']);
  });
  it.each(['', 'short', 'a'.repeat(257), 'a'.repeat(32) + '\n', 'a'.repeat(31) + ' '])(
    'fails closed for invalid tokens',
    (value) => {
      expect(() => readRelayConfig({ ...env, RELAY_TOKEN: value })).toThrow('RELAY_TOKEN');
    },
  );
  it.each([
    '',
    '*',
    '*.zakaz.md',
    'https://metro.zakaz.md',
    'metro.zakaz.md/path',
    'metro.zakaz.md:443',
    'metro.zakaz.md,',
    '127.0.0.1',
    '8.8.8.8',
    'localhost',
    'foo.internal',
    'metro.zakaz.md.',
  ])('rejects invalid allowlist %s', (value) => {
    expect(() => readRelayConfig({ ...env, RELAY_ALLOWED_DOMAINS: value })).toThrow(
      'RELAY_ALLOWED_DOMAINS',
    );
  });
  it.each([
    ['RELAY_HOST', '0.0.0.0'],
    ['RELAY_PORT', '0'],
    ['RELAY_PORT', '65536'],
    ['RELAY_MAX_BYTES', '4000001'],
    ['RELAY_MAX_BYTES', '-1'],
    ['RELAY_TIMEOUT_MS', '0'],
    ['RELAY_TIMEOUT_MS', '30001'],
    ['RELAY_TIMEOUT_MS', 'NaN'],
  ])('rejects invalid %s', (key, value) => {
    expect(() => readRelayConfig({ ...env, [key]: value })).toThrow(key);
  });
});

describe('relay authentication and request contract', () => {
  it.each(['/health', '/fetch', '/unknown'])(
    'rejects anonymous %s before DNS or body parsing',
    async (path) => {
      const { handler, resolver, transport } = setup();
      const response = await handler(
        new Request(`http://relay.local${path}`, { method: 'POST', body: 'invalid' }),
      );
      expect(response.status).toBe(401);
      expect(response.headers.get('www-authenticate')).toBe('Bearer realm="Shelf relay"');
      expect(resolver).not.toHaveBeenCalled();
      expect(transport).not.toHaveBeenCalled();
    },
  );
  it.each([`Basic ${token}`, 'Bearer wrong', `Bearer ${token} extra`])(
    'rejects malformed or incorrect credentials',
    async (authorization) => {
      const { handler } = setup();
      expect((await handler(fetchRequest(undefined, { authorization }))).status).toBe(401);
    },
  );
  it('reports authenticated health without contacting sources or disclosing configuration', async () => {
    const { handler, resolver } = setup();
    const response = await handler(
      new Request('http://relay.local/health', { headers: { Authorization: `bearer ${token}` } }),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, service: 'shelf-relay' });
    expect(resolver).not.toHaveBeenCalled();
  });
  it('returns route and method errors with an Allow header', async () => {
    const { handler } = setup();
    const response = await handler(
      new Request('http://relay.local/fetch', { headers: { Authorization: `Bearer ${token}` } }),
    );
    expect(response.status).toBe(405);
    expect(response.headers.get('allow')).toBe('POST');
    expect(
      (
        await handler(
          new Request('http://relay.local/other', {
            headers: { Authorization: `Bearer ${token}` },
          }),
        )
      ).status,
    ).toBe(404);
  });
  it.each([
    null,
    [],
    {},
    { url: 1 },
    { url: 'https://metro.zakaz.md/', method: 'POST' },
    { url: 'https://metro.zakaz.md/', headers: { Authorization: token } },
    { url: 'https://metro.zakaz.md/', maxBytes: 99999999 },
  ])('rejects malformed input or unsupported options', async (input) => {
    const { handler, transport } = setup();
    expect((await handler(fetchRequest(input))).status).toBe(422);
    expect(transport).not.toHaveBeenCalled();
  });
  it('rejects wrong content type, broken JSON and oversized bodies', async () => {
    const { handler, transport } = setup();
    expect((await handler(fetchRequest(undefined, { 'Content-Type': 'text/plain' }))).status).toBe(
      415,
    );
    expect(
      (
        await handler(
          new Request('http://relay.local/fetch', {
            method: 'POST',
            headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
            body: '{',
          }),
        )
      ).status,
    ).toBe(400);
    expect((await handler(fetchRequest({ url: 'x'.repeat(17000) }))).status).toBe(413);
    expect(transport).not.toHaveBeenCalled();
  });
});

describe('relay egress boundary', () => {
  it('returns HTML and upstream metadata, pins DNS and never forwards client credentials', async () => {
    const { handler, transport } = setup();
    const response = await handler(
      fetchRequest(undefined, { Cookie: 'private=cookie', 'X-Secret': token }),
    );
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('<html>METRO</html>');
    expect(response.headers.get('content-type')).toContain('text/html');
    expect(response.headers.get('x-shelf-upstream-status')).toBe('200');
    expect(response.headers.get('x-shelf-upstream-url')).toBe('https://metro.zakaz.md/ru/');
    expect(response.headers.get('set-cookie')).toBeNull();
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('content-security-policy')).toContain('sandbox');
    const [url, address, options] = transport.mock.calls[0];
    expect(url.href).toBe('https://metro.zakaz.md/ru/');
    expect(address).toEqual({ address: '93.184.216.34', family: 4 });
    expect(options).toMatchObject({
      method: 'GET',
      cloudFallback: false,
      maxBytes: 4000000,
      timeoutMs: 15000,
      signal: expect.any(AbortSignal),
    });
    expect(JSON.stringify(options.headers)).not.toContain(token);
    expect(new Headers(options.headers).has('cookie')).toBe(false);
  });
  it.each(['https://evil.md/', 'https://metro.zakaz.md.evil.md/', 'https://sub.metro.zakaz.md/'])(
    'denies domains outside exact allowlist before DNS: %s',
    async (url) => {
      const { handler, resolver, transport } = setup();
      expect((await handler(fetchRequest({ url }))).status).toBe(403);
      expect(resolver).not.toHaveBeenCalled();
      expect(transport).not.toHaveBeenCalled();
    },
  );
  it.each([
    'https://127.0.0.1/',
    'https://2130706433/',
    'https://0x7f000001/',
    'https://[::1]/',
    'https://169.254.169.254/',
    'https://10.0.0.1/',
    'http://metro.zakaz.md/',
    'https://metro.zakaz.md:8443/',
    'https://user:pass@metro.zakaz.md/',
    'file:///etc/passwd',
  ])('rejects unsafe URL %s', async (url) => {
    const { handler, transport } = setup();
    expect((await handler(fetchRequest({ url }))).status).toBe(422);
    expect(transport).not.toHaveBeenCalled();
  });
  it.each([
    [{ address: '127.0.0.1', family: 4 }],
    [{ address: '10.20.30.40', family: 4 }],
    [{ address: '169.254.169.254', family: 4 }],
    [
      { address: '93.184.216.34', family: 4 },
      { address: '10.0.0.1', family: 4 },
    ],
  ])('rejects private and mixed DNS responses', async (...addresses) => {
    const resolver = vi.fn(async () => addresses);
    const transport = vi.fn<Transport>();
    const handler = createRelayHandler(config(), { resolver, transport });
    expect((await handler(fetchRequest())).status).toBe(422);
    expect(transport).not.toHaveBeenCalled();
  });
  it.each([
    ['https://evil.md/', 403],
    ['https://127.0.0.1/', 422],
  ])('checks allowlist and SSRF policy on redirect to %s', async (location, status) => {
    const { resolver, transport } = setup();
    transport.mockResolvedValue({
      status: 302,
      headers: { location },
      body: Buffer.alloc(0),
      url: 'https://metro.zakaz.md/',
    });
    const handler = createRelayHandler(config(), { resolver, transport });
    expect((await handler(fetchRequest())).status).toBe(status);
    expect(resolver).toHaveBeenCalledTimes(1);
    expect(transport).toHaveBeenCalledTimes(1);
  });
  it('allows a redirect to another listed host and rechecks its DNS', async () => {
    const { handler, resolver, transport } = setup();
    transport.mockResolvedValueOnce({
      status: 302,
      headers: { location: 'https://api.metro.zakaz.md/product' },
      body: Buffer.alloc(0),
      url: 'https://metro.zakaz.md/ru/',
    });
    const response = await handler(fetchRequest());
    expect(response.status).toBe(200);
    expect(response.headers.get('x-shelf-upstream-url')).toBe('https://api.metro.zakaz.md/product');
    expect(resolver).toHaveBeenCalledTimes(2);
    expect(transport).toHaveBeenCalledTimes(2);
  });
  it.each([301, 302, 303, 307, 308])(
    'follows relative HTTP %s redirects using GET within the allowlist',
    async (status) => {
      const { handler, resolver, transport } = setup();
      transport.mockResolvedValueOnce({
        status,
        headers: { location: '/ru/products/next' },
        body: Buffer.alloc(0),
        url: 'https://metro.zakaz.md/ru/',
      });
      const response = await handler(fetchRequest());
      expect(response.status).toBe(200);
      expect(response.headers.get('x-shelf-upstream-url')).toBe(
        'https://metro.zakaz.md/ru/products/next',
      );
      expect(resolver).toHaveBeenCalledTimes(2);
      expect(transport).toHaveBeenCalledTimes(2);
      expect(transport.mock.calls.every(([, , options]) => options.method === 'GET')).toBe(true);
    },
  );
  it('stops redirect loops after three hops', async () => {
    const { handler, resolver, transport } = setup();
    transport.mockResolvedValue({
      status: 302,
      headers: { location: '/ru/' },
      body: Buffer.alloc(0),
      url: 'https://metro.zakaz.md/ru/',
    });
    expect((await handler(fetchRequest())).status).toBe(502);
    expect(resolver).toHaveBeenCalledTimes(4);
    expect(transport).toHaveBeenCalledTimes(4);
  });
  it('rejects redirects without a Location header', async () => {
    const { handler, transport } = setup();
    transport.mockResolvedValueOnce({
      status: 302,
      headers: {},
      body: Buffer.alloc(0),
      url: 'https://metro.zakaz.md/ru/',
    });
    expect((await handler(fetchRequest())).status).toBe(502);
    expect(transport).toHaveBeenCalledTimes(1);
  });
  it('enforces response size and preserves upstream 403/429', async () => {
    const { handler, transport } = setup();
    transport.mockResolvedValueOnce({
      status: 200,
      headers: {},
      body: Buffer.alloc(4000001),
      url: 'https://metro.zakaz.md/',
    });
    expect((await handler(fetchRequest())).status).toBe(413);
    for (const status of [403, 429]) {
      transport.mockResolvedValueOnce({
        status,
        headers: {},
        body: Buffer.from('denied'),
        url: 'https://metro.zakaz.md/',
      });
      const response = await handler(fetchRequest());
      expect(response.status).toBe(status);
      expect(response.headers.get('x-shelf-upstream-status')).toBe(String(status));
    }
  });
  it('bounds unresponsive DNS and transport with the total deadline', async () => {
    const short = readRelayConfig({ ...env, RELAY_TIMEOUT_MS: '10' });
    const transport = vi.fn<Transport>(() => new Promise(() => {}));
    const dnsTimeout = createRelayHandler(short, {
      resolver: () => new Promise(() => {}),
      transport,
    });
    expect((await dnsTimeout(fetchRequest())).status).toBe(504);
    expect(transport).not.toHaveBeenCalled();
    const fetchTimeout = createRelayHandler(short, { resolver: setup().resolver, transport });
    expect((await fetchTimeout(fetchRequest())).status).toBe(504);
  });
  it('redacts unexpected transport errors', async () => {
    const { resolver, transport } = setup();
    transport.mockRejectedValueOnce(new Error('socket details ' + token));
    const response = await createRelayHandler(config(), { resolver, transport })(fetchRequest());
    expect(response.status).toBe(502);
    expect(await response.text()).not.toContain(token);
    transport.mockRejectedValueOnce(new ApiError(413, 'Ответ превышает допустимый размер.'));
    expect(
      (await createRelayHandler(config(), { resolver, transport })(fetchRequest())).status,
    ).toBe(413);
  });
});
