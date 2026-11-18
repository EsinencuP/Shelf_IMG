import { ApiError, guardRequest, readJson, errorResponse } from '@/lib/server/http';
import { cancelJobs } from '@/lib/server/jobs';
import { MAX_JOB_SUBMISSION } from '@/lib/types';

export const runtime = 'nodejs';

export async function POST(request: Request) {
  try {
    guardRequest(request);
    const body = (await readJson(request, 48_000)) as { ids?: unknown };
    const ids = body?.ids;
    if (
      !Array.isArray(ids) ||
      !ids.length ||
      ids.length > MAX_JOB_SUBMISSION ||
      ids.some(
        (id) =>
          typeof id !== 'string' || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(id),
      )
    )
      throw new ApiError(422, 'Передайте список идентификаторов заданий.');
    return Response.json(
      { ids: await cancelJobs(ids) },
      { headers: { 'Cache-Control': 'no-store' } },
    );
  } catch (error) {
    return errorResponse(error);
  }
}
