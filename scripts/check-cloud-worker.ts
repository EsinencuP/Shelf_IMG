// Run against the isolated branch only; credentials live in a gitignored file.
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
const env = JSON.parse(readFileSync('.runtime/cloud-test.json', 'utf8'));
process.env.DATABASE_URL = env.DATABASE_INTEGRATION_URL;
const { enqueue, getJobs, cancelJob } = await import('../src/lib/server/jobs');
const { database } = await import('../src/lib/server/database');
const url = env.SHELF_WORKER_URL;
const headers = { 'x-secret': process.env.SHELF_WORKER_SECRET! };
assert.equal((await fetch(url + 'health')).status, 401);
assert.equal((await fetch(url + 'health', { headers })).status, 200);
assert.equal(
  (
    await fetch(url + 'cron', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-neon-trigger-invocation-id': 'forged' },
      body: JSON.stringify({
        version: 1,
        invocation_id: 'forged',
        trigger: { type: 'schedule', id: 'fake', name: 'shelf-hourly-recovery' },
        data: { scheduled_at: new Date().toISOString() },
      }),
    })
  ).status,
  401,
);
// Previous migration-test fixture must not trigger real search-provider calls.
await cancelJob('d23e9fb1-3fd4-4f70-b76d-adea0978a421');
const options = { mode: 'moldova' as const, useWeb: false, useCache: true, webQueryLimit: 1 };
const product = {
  ean: '4600699006831',
  nameRu: 'Майонез Слобода Провансаль Семейный 50,5% 850 мл',
  nameRo: '',
  brand: 'Слобода',
  quantity: '850 мл',
};
const jobs = await Promise.all([
  enqueue(product, options, false, randomUUID()),
  enqueue(product, options, false, randomUUID()),
]);
await Promise.all(
  jobs.map(async () =>
    assert.equal((await fetch(url + 'wake', { method: 'POST', headers })).status, 202),
  ),
);
const started = Date.now();
while (Date.now() - started < 180_000) {
  const results = await getJobs(jobs.map((job) => job.id));
  if (results.every((job) => job.status === 'succeeded')) {
    for (const job of results)
      assert.ok(job.result?.candidates.some((candidate) => candidate.gtin?.endsWith(product.ean)));
    console.log(
      JSON.stringify({
        ok: true,
        jobs: results.map((job) => ({
          id: job.id,
          status: job.status,
          outcome: job.result?.outcome,
          candidates: job.result?.candidates.length,
        })),
        seconds: Math.round((Date.now() - started) / 1000),
      }),
    );
    await database().end();
    process.exit(0);
  }
  assert.ok(results.every((job) => job.status !== 'failed'));
  await new Promise((resolve) => setTimeout(resolve, 2000));
}
await database().end();
throw new Error('Cloud queue timeout');
