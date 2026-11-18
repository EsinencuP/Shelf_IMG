import { randomUUID } from 'node:crypto';
import { database } from './database';
import type { SearchOptions, SearchResponse } from '../types';
import type { SearchProduct } from './validation';
import { ApiError } from './http';

export interface SearchJob {
  id: string;
  status: 'queued' | 'running' | 'retry' | 'succeeded' | 'failed' | 'cancelled';
  attempts: number;
  result?: SearchResponse;
  error?: string;
  available_at: string;
}
export interface ClaimedJob extends SearchJob {
  product: SearchProduct;
  options: SearchOptions;
  refresh: boolean;
  lease_token: string;
}
const columns = 'id,status,attempts,result,error,available_at';
export type JobSubmission = {
  product: SearchProduct;
  options: SearchOptions;
  refresh: boolean;
  requestKey: string;
};

export async function enqueueMany(items: JobSubmission[]) {
  const client = await database().connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query<{ id: string; request_key: string }>(
      `INSERT INTO shelf_jobs(id,request_key,product,options,refresh)
       SELECT id,request_key,product,options,refresh FROM jsonb_to_recordset($1::jsonb)
         AS input(id uuid,request_key uuid,product jsonb,options jsonb,refresh boolean)
       ORDER BY request_key
       ON CONFLICT(request_key) DO UPDATE SET request_key=excluded.request_key
       WHERE shelf_jobs.product=excluded.product AND shelf_jobs.options=excluded.options
         AND shelf_jobs.refresh=excluded.refresh
       RETURNING id, request_key`,
      [
        JSON.stringify(
          items.map(({ requestKey, ...item }) => ({
            ...item,
            request_key: requestKey,
            id: randomUUID(),
          })),
        ),
      ],
    );
    if (rows.length !== items.length)
      throw new ApiError(
        409,
        'Идентификатор уже использован для другого запроса. Повторите поиск.',
      );
    await client.query('COMMIT');
    return rows;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}
export async function enqueue(
  product: SearchProduct,
  options: SearchOptions,
  refresh: boolean,
  requestKey: string,
): Promise<SearchJob> {
  // Idempotency keys are browser-generated per submission, persisted with the row.
  const { rows } = await database().query<SearchJob>(
    `INSERT INTO shelf_jobs(id,request_key,product,options,refresh)
    VALUES($1,$2,$3,$4,$5) ON CONFLICT(request_key) DO UPDATE SET request_key=excluded.request_key
    WHERE shelf_jobs.product=excluded.product AND shelf_jobs.options=excluded.options AND shelf_jobs.refresh=excluded.refresh
    RETURNING ${columns}`,
    [randomUUID(), requestKey, product, options, refresh],
  );
  if (!rows[0])
    throw new ApiError(409, 'Идентификатор уже использован для другого запроса. Повторите поиск.');
  return rows[0];
}
export async function getJob(id: string): Promise<SearchJob> {
  const { rows } = await database().query<SearchJob>(
    `SELECT ${columns} FROM shelf_jobs WHERE id=$1`,
    [id],
  );
  if (!rows[0]) throw new ApiError(404, 'Задание не найдено.');
  return rows[0];
}
export async function getJobs(ids: string[]): Promise<SearchJob[]> {
  const { rows } = await database().query<SearchJob>(
    `SELECT ${columns} FROM shelf_jobs WHERE id=ANY($1::uuid[])`,
    [ids],
  );
  return rows;
}
export async function cancelJob(id: string): Promise<void> {
  await database().query(
    "UPDATE shelf_jobs SET status='cancelled',lease_token=NULL,lease_until=NULL,updated_at=now() WHERE id=$1 AND status IN ('queued','running','retry')",
    [id],
  );
}
export async function cancelJobs(ids: string[]): Promise<string[]> {
  const { rows } = await database().query<{ id: string }>(
    `UPDATE shelf_jobs SET status='cancelled',lease_token=NULL,lease_until=NULL,updated_at=now()
     WHERE id=ANY($1::uuid[]) AND status IN ('queued','running','retry','cancelled') RETURNING id`,
    [ids],
  );
  return rows.map((row) => row.id);
}
export async function claimJob(onlyId?: string): Promise<ClaimedJob | undefined> {
  const token = randomUUID();
  const { rows } = await database().query<ClaimedJob>(
    `UPDATE shelf_jobs SET status='running',attempts=attempts+1,
    lease_token=$1,lease_until=now()+interval '2 minutes',updated_at=now()
    WHERE id=(SELECT id FROM shelf_jobs WHERE attempts<3 AND ($2::uuid IS NULL OR id=$2) AND
      ((status IN ('queued','retry') AND available_at<=now()) OR (status='running' AND lease_until<now()))
      ORDER BY available_at,created_at FOR UPDATE SKIP LOCKED LIMIT 1)
    RETURNING *`,
    [token, onlyId ?? null],
  );
  await database().query(
    "UPDATE shelf_jobs SET status='failed',error='Исполнитель прервался три раза. Повторите поиск.',updated_at=now() WHERE status='running' AND attempts>=3 AND lease_until<now()",
  );
  return rows[0];
}
export async function renewJob(job: ClaimedJob): Promise<void> {
  await database().query(
    "UPDATE shelf_jobs SET lease_until=now()+interval '2 minutes' WHERE id=$1 AND lease_token=$2 AND status='running'",
    [job.id, job.lease_token],
  );
}
export async function finishJob(
  job: ClaimedJob,
  result?: SearchResponse,
  error?: string,
): Promise<void> {
  const retry =
    job.attempts < 3 && (!!error || (result?.outcome === 'deferred' && result.retryable !== false));
  const status = retry ? 'retry' : error ? 'failed' : 'succeeded';
  const delay = retry
    ? Math.max(
        60 * job.attempts + Math.floor(Math.random() * 10),
        ...(result?.diagnostics?.map((item) => Math.ceil((item.retryAfterMs ?? 0) / 1000)) ?? []),
      )
    : 0;
  await database().query(
    `UPDATE shelf_jobs SET status=$3,result=$4,error=$5,lease_token=NULL,lease_until=NULL,
    available_at=now()+$6*interval '1 second',updated_at=now()
    WHERE id=$1 AND lease_token=$2 AND status='running'`,
    [job.id, job.lease_token, status, result ?? null, error ?? null, delay],
  );
}
