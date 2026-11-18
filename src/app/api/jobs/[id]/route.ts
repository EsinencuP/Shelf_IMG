import { ApiError, guardRequest, errorResponse } from '@/lib/server/http';
import { getJob, cancelJob } from '@/lib/server/jobs';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
type Context = { params: Promise<{ id: string }> };
async function idFrom(context: Context) {
  const { id } = await context.params;
  if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(id))
    throw new ApiError(422, 'Некорректный идентификатор задания.');
  return id;
}
export async function GET(request: Request, context: Context) {
  try {
    guardRequest(request);
    return Response.json(await getJob(await idFrom(context)), {
      headers: { 'Cache-Control': 'no-store' },
    });
  } catch (error) {
    return errorResponse(error);
  }
}
export async function POST(request: Request, context: Context) {
  try {
    guardRequest(request);
    const id = await idFrom(context);
    await cancelJob(id);
    return Response.json(await getJob(id), { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    return errorResponse(error);
  }
}
