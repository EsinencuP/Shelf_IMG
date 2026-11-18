import { Pool } from 'pg';
import { attachDatabasePool } from '@vercel/functions';
import { ApiError } from './http';
import { abortable, currentSearchSignal, waitForSource } from './search-signal';

let pool: Pool | undefined;
// This QA branch never shares application or provider-throttle state.
export const databaseConfigured = () => !!process.env.DATABASE_URL && process.env.VERCEL_GIT_COMMIT_REF !== 'codex/shelf-source-qa';
export function database(): Pool {
  if (!databaseConfigured()) throw new ApiError(503, 'Общая база пока не подключена.');
  if (!pool) {
    const url = new URL(process.env.DATABASE_URL!);
    if (url.hostname.endsWith('.neon.tech')) url.searchParams.set('sslmode', 'verify-full');
    pool = new Pool({
      connectionString: url.href,
      max: 2,
      idleTimeoutMillis: 5000,
      connectionTimeoutMillis: 12000,
      statement_timeout: 15000,
      query_timeout: 18000,
    });
    pool.on('error', () => {
      /* A disconnected idle client is replaced by pg. */
    });
    if (process.env.VERCEL === '1') attachDatabasePool(pool);
  }
  return pool;
}

// Reserve one shared request slot atomically across workers and serverless instances.
export async function reserveSource(host: string, intervalMs: number): Promise<void> {
  const signal = currentSearchSignal();
  signal?.throwIfAborted();
  if (!databaseConfigured()) return;
  const { rows } = await abortable(
    database().query<{ wait: number; cooldown: number }>(
      `
    INSERT INTO shelf_source_slots(host,next_at) VALUES($1,now()+$2*interval '1 millisecond')
    ON CONFLICT(host) DO UPDATE SET next_at=CASE
      WHEN shelf_source_slots.cooldown_until>now() THEN shelf_source_slots.next_at
      ELSE greatest(shelf_source_slots.next_at,now())+$2*interval '1 millisecond' END
    RETURNING greatest(0,extract(epoch from (next_at-now()))*1000-$2)::float8 AS wait,
      greatest(0,extract(epoch from (cooldown_until-now()))*1000)::float8 AS cooldown`,
      [host, intervalMs],
    ),
    signal,
  );
  if (rows[0].cooldown > 0)
    throw new ApiError(
      429,
      `Источник попросил паузу; повтор доступен через ${Math.ceil(rows[0].cooldown / 1000)} сек.`,
      rows[0].cooldown,
    );
  if (rows[0].wait > 60000)
    throw new ApiError(429, 'Источник занят общей очередью; запрос будет повторён позже.');
  await waitForSource(rows[0].wait, signal);
}

/** Shared between cold Vercel instances and the Neon executor. */
export async function cooldownSource(host: string, delayMs: number): Promise<void> {
  if (!databaseConfigured()) return;
  if (!Number.isFinite(delayMs) || delayMs < 1000 || delayMs > 86400000) return;
  await database().query(
    `INSERT INTO shelf_source_slots(host,next_at,cooldown_until)
     VALUES($1,now(),now()+$2*interval '1 millisecond')
     ON CONFLICT(host) DO UPDATE SET cooldown_until=greatest(
       shelf_source_slots.cooldown_until,excluded.cooldown_until)`,
    [host, Math.ceil(delayMs)],
  );
}
