import { randomUUID } from 'node:crypto';
import { ApiError, guardRequest, readJson, errorResponse } from '@/lib/server/http';
import { validateProduct, validateSearchOptions } from '@/lib/server/validation';
import { enqueue, enqueueMany } from '@/lib/server/jobs';
import { dispatchJobs } from '@/lib/server/job-dispatch';
import { MAX_JOB_SUBMISSION } from '@/lib/types';
export const runtime = 'nodejs';
export const maxDuration = 180;

const accepted = { status: 202, headers: { 'Cache-Control': 'no-store' } };

function validateSubmission(input: unknown, requireKey = false) {
  const product = validateProduct(input);
  const body = input as Record<string, unknown>;
  const options = validateSearchOptions(body.searchOptions);
  const key = body.requestKey ?? (requireKey ? undefined : randomUUID());
  if (typeof key !== 'string' || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(key))
    throw new ApiError(422, 'Некорректный идентификатор задания.');
  if (body.refresh !== undefined && typeof body.refresh !== 'boolean')
    throw new ApiError(422, 'Некорректный параметр обновления.');
  return { product, options, refresh: body.refresh === true, requestKey: key.toLowerCase() };
}

export async function POST(request: Request) {
  try {
    guardRequest(request);
    const body = (await readJson(request, 4_000_000)) as Record<string, unknown> | null;
    if (body?.jobs !== undefined) {
      if (!Array.isArray(body.jobs) || !body.jobs.length || body.jobs.length > MAX_JOB_SUBMISSION)
        throw new ApiError(422, `Укажите от 1 до ${MAX_JOB_SUBMISSION} заданий.`);
      const items = body.jobs.map((item) => validateSubmission(item, true));
      if (new Set(items.map((item) => item.requestKey)).size !== items.length)
        throw new ApiError(422, 'Идентификаторы заданий должны быть уникальными.');
      const jobs = await enqueueMany(items);
      const workerAwake = await dispatchJobs(jobs.map((job) => job.id));
      return Response.json({ jobs, workerAwake }, accepted);
    }
    const { product, options, refresh, requestKey } = validateSubmission(body);
    const job = await enqueue(product, options, refresh, requestKey);
    const workerAwake = await dispatchJobs([job.id]);
    return Response.json({ ...job, workerAwake }, accepted);
  } catch (error) {
    return errorResponse(error);
  }
}
