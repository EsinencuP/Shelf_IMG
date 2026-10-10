import { afterEach, describe, expect, it, vi } from 'vitest';
import { publicGet } from '@/lib/server/public-fetch';
import { serviceJson } from '@/lib/server/discovery-services';

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});
describe('service transport boundaries', () => {
  it('refuses redirects for authenticated API requests before leaking the token', async () => {
    const transport = vi.fn(async (url: URL) => ({
      status: 302,
      headers: { location: 'https://other.org/' },
      body: Buffer.from(''),
      url: url.href,
    }));
    await expect(
      publicGet(
        'https://search.org/search',
        { headers: { Authorization: 'Bearer secret' } },
        { resolver: async () => [{ address: '93.184.216.34', family: 4 }], transport },
      ),
    ).rejects.toThrow('Перенаправление');
    expect(transport).toHaveBeenCalledTimes(1);
  });
  it('bounds loopback service bodies and never follows service redirects', async () => {
    vi.stubEnv('NODE_ENV', 'development');
    const fetcher = vi.fn(async () => Response.json({ results: [] }));
    vi.stubGlobal('fetch', fetcher);
    expect(
      await serviceJson(new URL('http://127.0.0.1:8080/search'), 'secret', { query: 'Nutella' }),
    ).toEqual({ results: [] });
    expect(fetcher.mock.calls[0]).toEqual([
      new URL('http://127.0.0.1:8080/search'),
      expect.objectContaining({
        method: 'POST',
        redirect: 'error',
        headers: { Authorization: 'Bearer secret', 'Content-Type': 'application/json' },
      }),
    ]);
    fetcher.mockResolvedValue(
      new Response('x'.repeat(100), { headers: { 'Content-Length': '100' } }),
    );
    await expect(
      serviceJson(new URL('http://127.0.0.1:8080/search'), undefined, undefined, 1000, 10),
    ).rejects.toMatchObject({ status: 413 });
  });
  it('does not expose provider errors containing secrets', async () => {
    vi.stubEnv('NODE_ENV', 'development');
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('{"error":"secret"}', { status: 401 })),
    );
    await expect(serviceJson(new URL('http://127.0.0.1:8080/search'), 'secret')).rejects.toThrow(
      'HTTP 401',
    );
  });
});
