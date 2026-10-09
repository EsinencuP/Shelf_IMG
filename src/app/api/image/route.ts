import { ApiError, boundedWork, errorResponse, guardRequest } from '@/lib/server/http';
import { inspectImage } from '@/lib/server/image';
import { MAX_IMAGE_BYTES, publicGet } from '@/lib/server/public-fetch';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;
export async function GET(request: Request): Promise<Response> {
  try {
    guardRequest(request);
    const url = new URL(request.url).searchParams.get('url');
    if (!url) throw new ApiError(422, 'Не указан URL изображения.');
    return await boundedWork(async () => {
      const result = await publicGet(url, { maxBytes: MAX_IMAGE_BYTES });
      if (result.status !== 200) throw new ApiError(result.status === 404 ? 404 : 502, 'Источник не предоставил изображение.');
      const { mime } = await inspectImage(result.body);
      return new Response(new Uint8Array(result.body), { headers: { 'Content-Type': mime, 'Content-Length': String(result.body.length), 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff', 'Content-Disposition': 'inline' } });
    });
  } catch (error) { return errorResponse(error); }
}
