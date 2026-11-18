import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import sharp from 'sharp';
const mocks = vi.hoisted(() => ({
  enqueue: vi.fn(),
  enqueueMany: vi.fn(),
  getJob: vi.fn(),
  getJobs: vi.fn(),
  cancelJob: vi.fn(),
  saveApproved: vi.fn(),
}));
vi.mock('../src/lib/server/jobs', () => mocks);
vi.mock('../src/lib/server/library', () => ({ saveApproved: mocks.saveApproved }));
vi.mock('next/server', () => ({ after: vi.fn() }));
import { POST as submit } from '../src/app/api/jobs/route';
import { GET as poll, POST as cancel } from '../src/app/api/jobs/[id]/route';
import { POST as approve } from '../src/app/api/library/route';
import { POST as batchStatus } from '../src/app/api/jobs/status/route';
const id = '35a66c9f-cf92-4333-ae91-78291c5b6983';
const product = {
  ean: '4600699006831',
  nameRu: 'Слобода 850 мл',
  nameRo: '',
  brand: 'Слобода',
  quantity: '850 мл',
};
function request(path: string, body: unknown, authorized = true) {
  return new Request('https://shelf.test' + path, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Origin: 'https://shelf.test',
      ...(authorized
        ? { Authorization: 'Basic ' + Buffer.from('admin:secret').toString('base64') }
        : {}),
    },
    body: JSON.stringify(body),
  });
}
beforeEach(() => {
  vi.stubEnv('NODE_ENV', 'production');
  vi.stubEnv('MVP_ACCESS_PASSWORD', 'secret');
  vi.clearAllMocks();
});
afterEach(() => vi.unstubAllEnvs());
describe('durable workflow API boundaries', () => {
  it('batches status reads and rejects malformed or oversized lists', async () => {
    mocks.getJobs.mockResolvedValue([{ id, status: 'queued' }]);
    expect((await batchStatus(request('/api/jobs/status', { ids: [id] }, false))).status).toBe(401);
    expect((await batchStatus(request('/api/jobs/status', { ids: [id] }))).status).toBe(200);
    expect(mocks.getJobs).toHaveBeenCalledWith([id]);
    expect(
      (await batchStatus(request('/api/jobs/status', { ids: Array(101).fill(id) }))).status,
    ).toBe(422);
    expect((await batchStatus(request('/api/jobs/status', { ids: ['bad'] }))).status).toBe(422);
  });
  it('requires access before submitting, polling or cancelling jobs', async () => {
    expect((await submit(request('/api/jobs', product, false))).status).toBe(401);
    expect(
      (
        await poll(new Request('https://shelf.test/api/jobs/' + id), {
          params: Promise.resolve({ id }),
        })
      ).status,
    ).toBe(401);
    expect(
      (await cancel(request('/api/jobs/' + id, {}, false), { params: Promise.resolve({ id }) }))
        .status,
    ).toBe(401);
    expect(mocks.enqueue).not.toHaveBeenCalled();
    expect(mocks.getJob).not.toHaveBeenCalled();
    expect(mocks.cancelJob).not.toHaveBeenCalled();
  });
  it('validates jobs and preserves the submission idempotency key', async () => {
    mocks.enqueue.mockResolvedValue({ id, status: 'queued', attempts: 0 });
    const response = await submit(
      request('/api/jobs', { ...product, requestKey: id, refresh: true }),
    );
    expect(response.status).toBe(202);
    expect(mocks.enqueue).toHaveBeenCalledWith(
      product,
      expect.objectContaining({ mode: 'expanded' }),
      true,
      id,
    );
    expect((await submit(request('/api/jobs', { ...product, requestKey: 'bad' }))).status).toBe(
      422,
    );
    expect((await submit(request('/api/jobs', { ...product, ean: '4600699006830' }))).status).toBe(
      422,
    );
  });
  it('accepts 1,000 jobs in one request and validates the full submission first', async () => {
    const jobs = Array.from({ length: 1_000 }, (_, index) => ({
      ...product,
      requestKey: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
    }));
    mocks.enqueueMany.mockResolvedValue(
      jobs.map(({ requestKey }) => ({ id, request_key: requestKey })),
    );
    expect((await submit(request('/api/jobs', { jobs: [...jobs, jobs[0]] }))).status).toBe(422);
    expect((await submit(request('/api/jobs', { jobs: [jobs[0], jobs[0]] }))).status).toBe(422);
    expect(mocks.enqueueMany).not.toHaveBeenCalled();
    const response = await submit(request('/api/jobs', { jobs }));
    expect(response.status).toBe(202);
    expect((await response.json()).jobs).toHaveLength(1_000);
    expect(mocks.enqueueMany).toHaveBeenCalledOnce();
  });
  it('rejects library uploads without explicit identity and rights confirmation', async () => {
    expect(
      (await approve(request('/api/library', { product, confirmed: true, rightsConfirmed: false })))
        .status,
    ).toBe(422);
    expect(mocks.saveApproved).not.toHaveBeenCalled();
  });
  it('stores a validated white JPEG bound to the manually confirmed product', async () => {
    const image = await sharp({
      create: { width: 40, height: 60, channels: 4, background: '#ff000080' },
    })
      .png()
      .toBuffer();
    mocks.saveApproved.mockResolvedValue(id);
    const response = await approve(
      request('/api/library', {
        product,
        confirmed: true,
        rightsConfirmed: true,
        image: image.toString('base64'),
        candidate: {
          title: 'Source',
          source: 'Shop',
          rights: 'unknown',
          pageUrl: 'https://shop.test/product',
        },
      }),
    );
    expect(response.status).toBe(201);
    const args = mocks.saveApproved.mock.calls[0];
    expect(args[1]).toMatchObject({ gtin: product.ean, quantity: '850 мл' });
    expect((await sharp(args[2]).metadata()).format).toBe('jpeg');
  });
});
