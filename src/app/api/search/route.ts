import { ApiError, boundedWork, errorResponse, guardRequest, readJson } from '@/lib/server/http';
import { searchProducts } from '@/lib/server/search';
import { validateProduct, validateSearchOptions } from '@/lib/server/validation';
import { randomUUID } from 'node:crypto';
import { recordSearchTiming } from '@/lib/server/search-timing';

export const runtime = 'nodejs';
export const maxDuration = 180;
export async function POST(request: Request): Promise<Response> {
  const started = performance.now();
  const requestId = randomUUID();
  try {
    guardRequest(request);
    const body = await readJson(request);
    const product = validateProduct(body);
    const options = validateSearchOptions((body as Record<string, unknown>).searchOptions);
    const refresh = (body as Record<string, unknown>).refresh ?? false;
    if (typeof refresh !== 'boolean') throw new ApiError(422, 'Некорректный параметр обновления.');
    return await boundedWork(async () => {
      const result = await searchProducts(product, options, refresh, request.signal);
      const elapsedMs = result.elapsedMs ?? Math.max(0, Math.round(performance.now() - started));
      recordSearchTiming(requestId, elapsedMs, 200, result);
      return Response.json(result, {
        headers: {
          'Cache-Control': 'no-store',
          'Server-Timing': `search;dur=${elapsedMs}`,
          'X-Shelf-Request-Id': requestId,
          'X-Shelf-Region': process.env.VERCEL_REGION || 'local',
        },
      });
    });
  } catch (error) {
    const response = errorResponse(
      request.signal.aborted ? new ApiError(499, 'Запрос поиска отменён.') : error,
    );
    recordSearchTiming(requestId, performance.now() - started, response.status);
    response.headers.set('X-Shelf-Request-Id', requestId);
    response.headers.set('X-Shelf-Region', process.env.VERCEL_REGION || 'local');
    return response;
  }
}
