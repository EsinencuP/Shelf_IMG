import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  claimJob: vi.fn(),
  finishJob: vi.fn(),
  renewJob: vi.fn(),
  searchProducts: vi.fn(),
  waitUntil: vi.fn(),
  parseTriggerDelivery: vi.fn(),
}));
vi.mock('../src/lib/server/database', () => ({ database: () => ({ query: mocks.query }) }));
vi.mock('../src/lib/server/jobs', () => mocks);
vi.mock('../src/lib/server/search', () => ({ searchProducts: mocks.searchProducts }));
vi.mock('@neon/functions', () => ({ waitUntil: mocks.waitUntil }));
vi.mock('@neon/functions/triggers', () => ({ parseTriggerDelivery: mocks.parseTriggerDelivery }));
import handler from '../functions/search-worker';
import { drainCloudQueue, acquireWorker, runQueuedJob } from '../src/lib/server/cloud-worker';
import { wakeCloudWorker } from '../src/lib/server/cloud-dispatch';

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv('SHELF_WORKER_SECRET', 'test-secret');
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});
describe('cloud execution boundaries', () => {
  it('rejects anonymous calls before touching the database', async () => {
    expect(
      (await handler.fetch(new Request('https://worker.neon.tech/wake', { method: 'POST' })))
        .status,
    ).toBe(401);
    expect(mocks.query).not.toHaveBeenCalled();
  });
  it('rejects anonymous relay requests before parsing their body', async () => {
    expect(
      (
        await handler.fetch(
          new Request('https://worker.neon.tech/fetch', { method: 'POST', body: 'invalid' }),
        )
      ).status,
    ).toBe(401);
  });
  it('rejects private URLs on authenticated cloud fetches', async () => {
    const response = await handler.fetch(
      new Request('https://worker.neon.tech/fetch', {
        method: 'POST',
        headers: { 'x-secret': 'test-secret', 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: 'https://127.0.0.1/', maxBytes: 1000, timeoutMs: 1000 }),
      }),
    );
    expect(response.status).toBe(422);
    expect(mocks.query).not.toHaveBeenCalled();
  });
  it('rejects oversized and unbounded relay requests', async () => {
    const response = await handler.fetch(
      new Request('https://worker.neon.tech/fetch', {
        method: 'POST',
        headers: { 'x-secret': 'test-secret', 'Content-Type': 'application/json' },
        body: JSON.stringify({
          url: 'https://shop.md/photo.jpg',
          maxBytes: 4000001,
          timeoutMs: 1000,
        }),
      }),
    );
    expect(response.status).toBe(422);
  });
  it('fails closed with no configured secret', async () => {
    vi.stubEnv('SHELF_WORKER_SECRET', '');
    expect(
      (
        await handler.fetch(
          new Request('https://worker.neon.tech/health', {
            headers: { 'x-secret': 'test-secret' },
          }),
        )
      ).status,
    ).toBe(401);
  });
  it('rejects fabricated cron provenance', async () => {
    mocks.parseTriggerDelivery.mockResolvedValue({ ok: false, error: 'missing_header' });
    expect(
      (await handler.fetch(new Request('https://worker.neon.tech/cron', { method: 'POST' })))
        .status,
    ).toBe(401);
    expect(mocks.query).not.toHaveBeenCalled();
  });
  it('reports busy without spawning another executor', async () => {
    mocks.query.mockResolvedValue({ rows: [] });
    const response = await handler.fetch(
      new Request('https://worker.neon.tech/wake', {
        method: 'POST',
        headers: { 'x-secret': 'test-secret' },
      }),
    );
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ accepted: true, busy: true });
    expect(mocks.waitUntil).not.toHaveBeenCalled();
  });
  it('releases its lease immediately when the queue is empty', async () => {
    mocks.claimJob.mockResolvedValue(undefined);
    mocks.query.mockResolvedValue({ rows: [{ delay: null }], rowCount: 1 });
    expect(await drainCloudQueue('owner')).toBe(false);
    expect(
      mocks.query.mock.calls.some(
        ([sql, params]) => sql.includes('lease_until=now() WHERE') && params[0] === 'owner',
      ),
    ).toBe(true);
    expect(mocks.searchProducts).not.toHaveBeenCalled();
  });
  it('claims only the selected fallback job and persists its search result', async () => {
    const job = { id: 'a', product: { ean: 'x' }, options: {}, refresh: false };
    mocks.claimJob.mockResolvedValue(job);
    mocks.searchProducts.mockResolvedValue({ candidates: [], outcome: 'not_found' });
    await runQueuedJob('a');
    expect(mocks.claimJob).toHaveBeenCalledWith('a');
    expect(mocks.finishJob).toHaveBeenCalledWith(job, { candidates: [], outcome: 'not_found' });
  });
  it('cancels active source work when the job lease has been revoked', async () => {
    vi.useFakeTimers();
    const job = { id: 'a', product: {}, options: {}, refresh: false };
    mocks.claimJob.mockResolvedValue(job);
    mocks.renewJob.mockResolvedValue(false);
    mocks.searchProducts.mockImplementation(
      (_product, _options, _refresh, signal: AbortSignal) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(signal.reason), { once: true });
        }),
    );
    const attempt = runQueuedJob('a');
    await vi.advanceTimersByTimeAsync(15_000);
    await attempt;
    expect(mocks.renewJob).toHaveBeenCalledWith(job);
    expect(mocks.finishJob).not.toHaveBeenCalled();
  });
  it('persists search failure for a durable retry and releases the lock', async () => {
    const job = { id: 'job', product: {}, options: {}, refresh: false };
    mocks.claimJob.mockResolvedValueOnce(job).mockResolvedValue(undefined);
    mocks.searchProducts.mockRejectedValue(new Error('network'));
    mocks.query.mockResolvedValue({ rows: [{ delay: null }], rowCount: 1 });
    await drainCloudQueue('owner');
    expect(mocks.finishJob).toHaveBeenCalledWith(
      job,
      undefined,
      expect.stringContaining('тремя попытками'),
    );
  });
  it('acquires a shared expiring lease instead of an in-memory flag', async () => {
    mocks.query.mockResolvedValue({ rows: [] });
    expect(await acquireWorker()).toBeUndefined();
    expect(mocks.query.mock.calls[0][0]).toContain('shelf_worker_lease.lease_until<now()');
  });
  it('sends the secret only to a fixed HTTPS Neon URL and rejects redirects', async () => {
    vi.stubEnv('SHELF_WORKER_URL', 'https://worker.compute.neon.tech/');
    const fetch = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', fetch);
    expect(await wakeCloudWorker()).toBe(true);
    expect(fetch).toHaveBeenCalledWith(
      new URL('https://worker.compute.neon.tech/wake'),
      expect.objectContaining({ redirect: 'manual', headers: { 'x-secret': 'test-secret' } }),
    );
    vi.stubEnv('SHELF_WORKER_URL', 'https://attacker.test/');
    expect(await wakeCloudWorker()).toBe(false);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('leaves persisted work recoverable when dispatch fails', async () => {
    vi.stubEnv('SHELF_WORKER_URL', 'https://worker.compute.neon.tech/');
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));
    expect(await wakeCloudWorker()).toBe(false);
  });
});
