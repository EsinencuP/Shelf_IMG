import { afterEach, expect, it, vi } from 'vitest';
import { recordSearchTiming } from '@/lib/server/search-timing';
import { POST } from '@/app/api/search/route';
import { searchProducts } from '@/lib/server/search';
import { ApiError } from '@/lib/server/http';
vi.mock('@/lib/server/search', () => ({ searchProducts: vi.fn() }));
afterEach(() => {
  vi.restoreAllMocks();
  vi.resetAllMocks();
  vi.unstubAllEnvs();
});

it('logs timings and statuses without product attributes or upstream secrets', () => {
  const log = vi.spyOn(console, 'info').mockImplementation(() => {});
  vi.stubEnv('VERCEL_REGION', 'fra1');
  recordSearchTiming('run-id', 19.6, 200, {
    candidates: [],
    warnings: ['secret-token'],
    outcome: 'deferred',
    elapsedMs: 20,
    diagnostics: [
      {
        id: 'metro-md',
        source: 'secret-name',
        status: 'blocked',
        reason: 'secret-url',
        message: 'secret-password',
        count: 0,
        elapsedMs: 18,
        httpStatus: 403,
      },
    ],
  });
  const text = log.mock.calls[0][0] as string;
  expect(text).not.toContain('secret');
  expect(JSON.parse(text)).toMatchObject({
    event: 'shelf.search',
    region: 'fra1',
    elapsedMs: 20,
    requestId: 'run-id',
    sources: [{ id: 'metro-md', elapsedMs: 18, httpStatus: 403 }],
  });
});

const request = () =>
  new Request('https://shelf.example/api/search', {
    method: 'POST',
    headers: { Origin: 'https://shelf.example', 'Content-Type': 'application/json' },
    body: JSON.stringify({ ean: '3017620422003' }),
  });

it('exposes server timing and a log correlation ID in search responses', async () => {
  vi.stubEnv('NODE_ENV', 'development');
  vi.stubEnv('MVP_ACCESS_PASSWORD', '');
  vi.stubEnv('VERCEL_REGION', 'fra1');
  const log = vi.spyOn(console, 'info').mockImplementation(() => {});
  vi.mocked(searchProducts).mockResolvedValue({
    candidates: [],
    warnings: [],
    diagnostics: [],
    outcome: 'not_found',
    elapsedMs: 37,
  });
  const response = await POST(request());
  expect(response.status).toBe(200);
  expect(response.headers.get('server-timing')).toBe('search;dur=37');
  expect(response.headers.get('x-shelf-region')).toBe('fra1');
  expect(JSON.parse(log.mock.calls[0][0] as string).requestId).toBe(
    response.headers.get('x-shelf-request-id'),
  );
  expect((await response.json()).elapsedMs).toBe(37);
});

it('also records failed requests without logging their error text', async () => {
  vi.stubEnv('NODE_ENV', 'development');
  vi.stubEnv('MVP_ACCESS_PASSWORD', '');
  const log = vi.spyOn(console, 'info').mockImplementation(() => {});
  vi.mocked(searchProducts).mockRejectedValue(new ApiError(504, 'secret-upstream'));
  const response = await POST(request());
  expect(response.status).toBe(504);
  const line = JSON.parse(log.mock.calls[0][0] as string);
  expect(line).toMatchObject({ httpStatus: 504, outcome: 'error', sources: [] });
  expect(line.elapsedMs).toBeGreaterThanOrEqual(0);
  expect(JSON.stringify(line)).not.toContain('secret-upstream');
});
