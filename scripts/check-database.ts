import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { enqueue, claimJob, finishJob, cancelJob, getJob } from '../src/lib/server/jobs';
import { database } from '../src/lib/server/database';
import { findApproved, saveApproved } from '../src/lib/server/library';
import { DEFAULT_SEARCH_OPTIONS } from '../src/lib/types';
import { POST as approvePhoto } from '../src/app/api/library/route';
import { GET as loadPhoto } from '../src/app/api/library/[id]/image/route';
import { searchProducts } from '../src/lib/server/search';
// Run ONLY against the isolated workflow-migration-check branch.
if (!process.env.DATABASE_INTEGRATION_URL)
  throw new Error('Set DATABASE_INTEGRATION_URL for an isolated test branch');
process.env.DATABASE_URL = process.env.DATABASE_INTEGRATION_URL;
const key = randomUUID();
const product = {
  ean: '',
  nameRu: 'Database fixture ' + key,
  nameRo: '',
  brand: 'Fixture',
  quantity: '500 ml',
};
try {
  const first = await enqueue(product, DEFAULT_SEARCH_OPTIONS, false, key);
  assert.equal((await enqueue(product, DEFAULT_SEARCH_OPTIONS, false, key)).id, first.id);
  await assert.rejects(
    enqueue({ ...product, quantity: '1 l' }, DEFAULT_SEARCH_OPTIONS, false, key),
    { status: 409 },
  );
  const claims = await Promise.all([claimJob(first.id), claimJob(first.id)]);
  const job = claims.find((item) => item?.id === first.id);
  assert.ok(job);
  assert.equal(claims.filter((item) => item?.id === first.id).length, 1);
  await cancelJob(job.id);
  await finishJob(job, { candidates: [], warnings: [], outcome: 'not_found' });
  assert.equal((await getJob(job.id)).status, 'cancelled');
  const second = await enqueue(product, DEFAULT_SEARCH_OPTIONS, false, randomUUID());
  const expired = await claimJob(second.id);
  assert.equal(expired?.id, second.id);
  assert.ok(expired);
  await database().query(
    "UPDATE shelf_jobs SET lease_until=now()-interval '1 second' WHERE id=$1",
    [expired.id],
  );
  const recovered = await claimJob(second.id);
  assert.ok(recovered);
  assert.equal(recovered.id, second.id);
  assert.equal(recovered.attempts, 2);
  await finishJob(expired, { candidates: [], warnings: [], outcome: 'not_found' });
  assert.equal((await getJob(second.id)).status, 'running');
  await finishJob(recovered, { candidates: [], warnings: [], outcome: 'deferred' });
  assert.equal((await getJob(second.id)).status, 'retry');
  await cancelJob(second.id);
  const image = await sharp({
    create: { width: 40, height: 60, channels: 3, background: '#ffffff' },
  })
    .jpeg()
    .toBuffer();
  const candidate = {
    id: 'fixture',
    title: product.nameRu,
    quantity: product.quantity,
    brand: product.brand,
    imageUrl: '',
    pageUrl: '',
    source: 'Fixture',
    rights: 'user_owned' as const,
    gtinExact: false,
    warnings: [],
  };
  const saved = await saveApproved(product, candidate, image);
  assert.equal(await saveApproved(product, candidate, image), saved);
  assert.equal((await findApproved(product))[0].id, saved);
  assert.equal((await findApproved({ ...product, quantity: '750 ml' })).length, 0);
  process.env.MVP_ACCESS_PASSWORD = 'database-fixture-only';
  const authorization = 'Basic ' + Buffer.from('test:database-fixture-only').toString('base64');
  const upload = () =>
    new Request('https://shelf.test/api/library', {
      method: 'POST',
      headers: {
        Origin: 'https://shelf.test',
        'Content-Type': 'application/json',
        Authorization: authorization,
      },
      body: JSON.stringify({
        product,
        candidate,
        image: image.toString('base64'),
        confirmed: true,
        rightsConfirmed: true,
      }),
    });
  const approved = await approvePhoto(upload());
  assert.equal(approved.status, 201);
  const { id } = await approved.json();
  assert.equal((await (await approvePhoto(upload())).json()).id, id);
  const photo = await loadPhoto(
    new Request('https://shelf.test/api/library/' + id + '/image', {
      headers: { Authorization: authorization },
    }),
    { params: Promise.resolve({ id }) },
  );
  assert.equal(photo.status, 200);
  assert.equal(photo.headers.get('content-type'), 'image/jpeg');
  assert.equal((await sharp(Buffer.from(await photo.arrayBuffer())).metadata()).format, 'jpeg');
  assert.equal(
    (
      await loadPhoto(new Request('https://shelf.test/api/library/' + id + '/image'), {
        params: Promise.resolve({ id }),
      })
    ).status,
    401,
  );
  const reused = await searchProducts(product);
  assert.equal(reused.diagnostics?.[0].id, 'library');
  console.log(
    'PASS: idempotency, concurrent claims, cancellation, expired lease, stale worker fencing, retries, approved library',
  );
} finally {
  await database().end();
}
