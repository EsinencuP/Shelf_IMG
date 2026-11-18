import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { retryAfterMs, sourceFailure } from '../src/lib/server/source-policy';
import { cooldownSource, reserveSource } from '../src/lib/server/database';
import { ApiError, errorResponse } from '../src/lib/server/http';
const { query } = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock('pg', () => ({
  Pool: class {
    query = query;
    on() {}
  },
}));
vi.mock('../src/lib/server/database', async (original) => ({
  ...(await original<typeof import('../src/lib/server/database')>()),
  cooldownSource: vi.fn(),
}));
beforeEach(() => vi.mocked(cooldownSource).mockResolvedValue(undefined));
afterEach(() => {
  vi.resetAllMocks();
  vi.unstubAllEnvs();
});
it('reads delta seconds and HTTP dates, including zero, invalid values and bounded large durations', () => {
  const now = Date.UTC(2026, 9, 12, 20, 0, 0);
  expect(retryAfterMs('120', now)).toBe(120000);
  expect(retryAfterMs('Mon, 12 Oct 2026 20:02:00 GMT', now)).toBe(120000);
  expect(retryAfterMs('0', now)).toBe(1000);
  expect(retryAfterMs('999999999', now)).toBe(86400000);
  expect(retryAfterMs('-1', now)).toBe(60000);
  expect(retryAfterMs('garbage', now)).toBe(60000);
});
it('records source cooldown without leaking credentials and exposes retry timing on an API error', async () => {
  const error = await sourceFailure(
    'https://shop.md/item',
    { status: 429, headers: { 'retry-after': '120' } },
    'Source limited',
  );
  expect(cooldownSource).toHaveBeenCalledWith('shop.md', 120000);
  expect(error).toMatchObject({ status: 429, retryAfterMs: 120000 });
  expect(errorResponse(error).headers.get('Retry-After')).toBe('120');
});
it('does not mark another product or the whole source as blocked after 404 or 401', async () => {
  for (const status of [404, 401])
    await sourceFailure('https://shop.md/item', { status, headers: {} }, 'Unavailable');
  expect(cooldownSource).not.toHaveBeenCalled();
});
it('keeps the actual upstream failure when the cooldown database is unavailable', async () => {
  vi.mocked(cooldownSource).mockRejectedValue(new Error('DB offline'));
  expect(
    await sourceFailure('https://shop.md/item', { status: 403, headers: {} }, 'HTTP 403'),
  ).toMatchObject({ status: 502, message: 'HTTP 403', retryAfterMs: 60000 });
});
it('refuses a shared cooldown immediately rather than sleeping in a Vercel function', async () => {
  vi.stubEnv('DATABASE_URL', 'postgres://configured');
  query.mockResolvedValue({ rows: [{ wait: 0, cooldown: 120000 }] });
  await expect(reserveSource('shop.md', 700)).rejects.toMatchObject({
    status: 429,
    retryAfterMs: 120000,
  });
  expect(errorResponse(new ApiError(503, 'Wait', 1001)).headers.get('Retry-After')).toBe('2');
});
