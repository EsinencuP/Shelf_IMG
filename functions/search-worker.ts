import { timingSafeEqual } from 'node:crypto';
import { waitUntil } from '@neon/functions';
import { parseTriggerDelivery } from '@neon/functions/triggers';
import { acquireWorker, drainCloudQueue } from '../src/lib/server/cloud-worker';
import { wakeCloudWorker } from '../src/lib/server/cloud-dispatch';
import { handleCloudFetch } from '../src/lib/server/cloud-fetch-handler';

function authorized(request: Request): boolean {
  const secret = process.env.SHELF_WORKER_SECRET;
  const supplied = request.headers.get('x-secret');
  if (!secret || !supplied) return false;
  const expected = Buffer.from(secret);
  const actual = Buffer.from(supplied);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

export default {
  async fetch(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (path === '/cron' && request.method === 'POST') {
      const parsed = await parseTriggerDelivery(request);
      if (
        !parsed.ok ||
        parsed.invocation.type !== 'schedule' ||
        parsed.invocation.trigger.name !== 'shelf-hourly-recovery'
      )
        return new Response('Unauthorized', { status: 401 });
    } else if (!authorized(request)) {
      return new Response('Unauthorized', { status: 401 });
    }
    if (request.method === 'POST' && path === '/fetch') return handleCloudFetch(request);
    if (request.method === 'GET' && path === '/health')
      return Response.json({ ready: !!process.env.DATABASE_URL, executor: 'neon', version: 1 });
    if (request.method !== 'POST' || !['/wake', '/cron'].includes(path))
      return new Response('Not found', { status: 404 });
    try {
      const token = await acquireWorker();
      if (token)
        waitUntil(
          (async () => {
            if (await drainCloudQueue(token)) await wakeCloudWorker();
          })().catch(() => {
            console.error('Shelf executor deferred to recovery trigger.');
          }),
        );
      return Response.json({ accepted: true, busy: !token }, { status: 202 });
    } catch {
      return Response.json({ error: 'Queue temporarily unavailable' }, { status: 503 });
    }
  },
};
