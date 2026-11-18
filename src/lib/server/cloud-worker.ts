import { randomUUID } from 'node:crypto';
import { database } from './database';
import { claimJob, finishJob, renewJob } from './jobs';
import type { ClaimedJob } from './jobs';
import { searchProducts } from './search';
import { boundedWork } from './http';
import { recordSearchTiming } from './search-timing';

export async function runClaimedSearch(
  job: ClaimedJob,
  retryMessage: string,
  workerSignal?: AbortSignal,
) {
  const lease = new AbortController();
  const started = performance.now();
  const signal = workerSignal ? AbortSignal.any([workerSignal, lease.signal]) : lease.signal;
  let renewing = false;
  const heartbeat = setInterval(async () => {
    if (renewing) return;
    renewing = true;
    try {
      if (!(await renewJob(job))) lease.abort();
    } catch {
      // A temporary database error is not proof that the lease was lost.
    } finally {
      renewing = false;
    }
  }, 15_000);
  try {
    signal.throwIfAborted();
    const result = await searchProducts(job.product, job.options, job.refresh, signal);
    if (!signal.aborted) {
      await finishJob(job, result);
      recordSearchTiming(job.id, result.elapsedMs ?? performance.now() - started, 200, result);
    }
  } catch {
    if (!signal.aborted) {
      await finishJob(job, undefined, retryMessage);
      recordSearchTiming(job.id, performance.now() - started, 503);
    }
  } finally {
    clearInterval(heartbeat);
  }
}

/** Short Vercel fallback. The same durable job lease prevents double execution. */
export async function runQueuedJob(id: string): Promise<void> {
  await boundedWork(async () => {
    const job = await claimJob(id);
    if (!job) return;
    await runClaimedSearch(
      job,
      'Облачный поиск временно недоступен; задание сохранено для повтора.',
    );
  }).catch(() => {
    /* Busy or interrupted: the persisted job remains recoverable. */
  });
}

export async function acquireWorker(): Promise<string | undefined> {
  const token = randomUUID();
  const { rows } = await database().query<{ token: string }>(
    `INSERT INTO shelf_worker_lease(name,token,lease_until) VALUES('search',$1,now()+interval '2 minutes')
     ON CONFLICT(name) DO UPDATE SET token=excluded.token,lease_until=excluded.lease_until
     WHERE shelf_worker_lease.lease_until<now() RETURNING token`,
    [token],
  );
  return rows[0]?.token;
}

export async function pendingDelay(): Promise<number | undefined> {
  const { rows } = await database().query<{ delay: number | null }>(
    `SELECT extract(epoch FROM (min(CASE WHEN status='running' THEN lease_until ELSE available_at END)-now()))::float8 AS delay
     FROM shelf_jobs WHERE status IN ('queued','retry','running')`,
  );
  return rows[0]?.delay == null ? undefined : Math.max(0, rows[0].delay);
}

// One shared executor protects upstream quotas. Each invocation is bounded;
// durable rows and leases survive eviction. No database polling while idle.
export async function drainCloudQueue(token: string): Promise<boolean> {
  const deadline = Date.now() + 8 * 60_000;
  const lease = new AbortController();
  const heartbeat = setInterval(() => {
    void database()
      .query(
        "UPDATE shelf_worker_lease SET lease_until=now()+interval '2 minutes' WHERE name='search' AND token=$1 AND lease_until>now()",
        [token],
      )
      .then((result) => {
        if (!result.rowCount) lease.abort();
      })
      .catch(() => {
        lease.abort();
      });
  }, 30_000);
  try {
    while (!lease.signal.aborted && Date.now() < deadline) {
      const job = await claimJob();
      if (!job) {
        const delay = await pendingDelay();
        if (delay === undefined) break;
        // Leave enough time for another search before the 15-minute runtime cap.
        if (Date.now() + Math.max(1000, delay * 1000) + 120_000 > deadline) break;
        await new Promise((resolve) => setTimeout(resolve, Math.max(1000, delay * 1000)));
        continue;
      }
      await runClaimedSearch(
        job,
        'Поиск временно недоступен. Автоматический повтор ограничен тремя попытками.',
        lease.signal,
      );
      console.log('Shelf cloud job completed:', job.id);
    }
  } catch {
    console.error('Shelf cloud executor interrupted; durable queue retained.');
  } finally {
    clearInterval(heartbeat);
    await database().query(
      "UPDATE shelf_worker_lease SET lease_until=now() WHERE name='search' AND token=$1",
      [token],
    );
  }
  return !lease.signal.aborted && (await pendingDelay()) !== undefined;
}
