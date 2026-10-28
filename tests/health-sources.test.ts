import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GET, HEAD, maxDuration, runtime } from '@/app/api/health/sources/route';
import { probeSources } from '@/lib/server/probe-sources';

vi.mock('@/lib/server/probe-sources', () => ({ probeSources: vi.fn() }));
const request = (credentials?: string, headers: Record<string, string> = {}) =>
  new Request('https://shelf.example/api/health/sources', {
    headers: {
      ...(credentials
        ? { Authorization: `Basic ${Buffer.from(credentials).toString('base64')}` }
        : {}),
      ...headers,
    },
  });

beforeEach(() => {
  vi.stubEnv('MVP_ACCESS_PASSWORD', 'probe-password');
});
afterEach(() => {
  vi.resetAllMocks();
  vi.unstubAllEnvs();
});

describe('protected source health endpoint', () => {
  it.each([undefined, 'admin:wrong', 'other:probe-password', 'probe-password'])(
    'rejects missing or invalid credentials (%s) before probing',
    async (credentials) => {
      const response = await GET(request(credentials));
      expect(response.status).toBe(401);
      expect(response.headers.get('www-authenticate')).toContain('Basic realm="Shelf"');
      expect(response.headers.get('cache-control')).toBe('no-store');
      expect(probeSources).not.toHaveBeenCalled();
    },
  );

  it.each(['development', 'production'] as const)(
    'fails closed without a password in %s',
    async (mode) => {
      vi.stubEnv('NODE_ENV', mode);
      vi.stubEnv('MVP_ACCESS_PASSWORD', '');
      expect((await GET(request())).status).toBe(503);
      expect(probeSources).not.toHaveBeenCalled();
    },
  );

  it('returns the shared report unchanged, including individual HTTP 403s', async () => {
    const report: Awaited<ReturnType<typeof probeSources>> = {
      elapsedMs: 120,
      generatedAt: '2026-10-28T12:00:00.000Z',
      referenceEans: ['4840053004404'],
      results: [
        {
          source: 'METRO Moldova',
          ean: '4840053004404',
          httpStatus: 403,
          elapsedMs: 82,
          imageCount: null,
          status: 'blocked' as const,
        },
        {
          source: 'Open Food Facts',
          ean: '4840053004404',
          httpStatus: 200,
          elapsedMs: 100,
          imageCount: 1,
          status: 'ok' as const,
        },
      ],
    };
    vi.mocked(probeSources).mockResolvedValue(report);
    const response = await GET(request('admin:probe-password'));
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('content-type')).toContain('application/json');
    expect(await response.json()).toEqual(report);
    expect(probeSources).toHaveBeenCalledExactlyOnceWith();
    expect(runtime).toBe('nodejs');
    expect(maxDuration).toBe(300);
  });

  it('rejects cross-site calls and does not accept a password from the URL', async () => {
    expect(
      (await GET(request('admin:probe-password', { 'sec-fetch-site': 'cross-site' }))).status,
    ).toBe(403);
    expect(
      (await GET(new Request('https://shelf.example/api/health/sources?password=probe-password')))
        .status,
    ).toBe(401);
    expect(probeSources).not.toHaveBeenCalled();
  });

  it('sanitizes unexpected errors without exposing secrets', async () => {
    vi.mocked(probeSources).mockRejectedValue(new Error('secret-key-with-connection-url'));
    const response = await GET(request('admin:probe-password'));
    expect(response.status).toBe(502);
    expect(await response.text()).not.toContain('secret-key');
    expect(response.headers.get('cache-control')).toBe('no-store');
  });

  it('bounds concurrent runs and releases capacity after completion', async () => {
    let finish!: (report: Awaited<ReturnType<typeof probeSources>>) => void;
    vi.mocked(probeSources).mockReturnValue(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    const pending = Array.from({ length: 3 }, () => GET(request('admin:probe-password')));
    expect((await GET(request('admin:probe-password'))).status).toBe(429);
    finish({ generatedAt: '', referenceEans: [], results: [], elapsedMs: 0 });
    expect((await Promise.all(pending)).every((response) => response.status === 200)).toBe(true);
    expect((await GET(request('admin:probe-password'))).status).toBe(200);
  });

  it('authenticates HEAD without running the probe or returning a body', async () => {
    const denied = await HEAD(request());
    expect(denied.status).toBe(401);
    expect(denied.headers.get('www-authenticate')).toContain('Basic');
    expect(await denied.text()).toBe('');
    const allowed = await HEAD(request('admin:probe-password'));
    expect(allowed.status).toBe(200);
    expect(allowed.headers.get('cache-control')).toBe('no-store');
    expect(await allowed.text()).toBe('');
    expect(probeSources).not.toHaveBeenCalled();
  });
});
