import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ after: vi.fn(), wake: vi.fn(), run: vi.fn() }));
vi.mock('next/server', () => ({ after: mocks.after }));
vi.mock('../src/lib/server/cloud-dispatch', () => ({
  cloudWorkerConfigured: () => !!process.env.SHELF_WORKER_URL,
  wakeCloudWorker: mocks.wake,
}));
vi.mock('../src/lib/server/cloud-worker', () => ({ runQueuedJob: mocks.run }));
import { dispatchJobs } from '../src/lib/server/job-dispatch';
beforeEach(() => vi.resetAllMocks());
afterEach(() => vi.unstubAllEnvs());
it('keeps Neon execution when it acknowledges the wake', async () => {
  vi.stubEnv('SHELF_WORKER_URL', 'https://worker.neon.tech');
  mocks.wake.mockResolvedValue(true);
  expect(await dispatchJobs(['job'])).toBe(true);
  expect(mocks.after).not.toHaveBeenCalled();
});
it.each([false, undefined])(
  'executes persisted jobs on Vercel when the worker is unavailable (%s)',
  async (url) => {
    vi.stubEnv('SHELF_WORKER_URL', url === false ? 'https://worker.neon.tech' : '');
    mocks.wake.mockResolvedValue(false);
    expect(await dispatchJobs(['a', 'b', 'c', 'd'])).toBe(false);
    await mocks.after.mock.calls[0][0]();
    expect(mocks.run.mock.calls.map(([id]) => id)).toEqual(['a', 'b', 'c']);
  },
);
