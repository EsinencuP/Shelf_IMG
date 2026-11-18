import { ApiError, guardRequest, readJson, errorResponse } from '@/lib/server/http';
import { getJobs } from '@/lib/server/jobs';
import { dispatchJobs } from '@/lib/server/job-dispatch';
export const runtime = 'nodejs';
export const maxDuration = 180;
export async function POST(request: Request) {
  try {
    guardRequest(request);
    const body = (await readJson(request)) as { ids?: unknown };
    const ids = body?.ids;
    if (
      !Array.isArray(ids) ||
      !ids.length ||
      ids.length > 100 ||
      ids.some(
        (id) =>
          typeof id !== 'string' || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(id),
      )
    )
      throw new ApiError(422, 'Укажите от 1 до 100 идентификаторов заданий.');
    const jobs = await getJobs(ids);
    const pending = jobs.filter((job) => ['queued', 'retry', 'running'].includes(job.status));
    if (pending.length) await dispatchJobs(pending.map((job) => job.id));
    return Response.json({ jobs }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    return errorResponse(error);
  }
}
