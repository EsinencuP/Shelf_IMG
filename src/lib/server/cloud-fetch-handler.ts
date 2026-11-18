import { ApiError, errorResponse, readJson } from './http';
import { MAX_IMAGE_BYTES, publicGet } from './public-fetch';

/** Called only after the Function's server secret has been checked. */
export async function handleCloudFetch(request: Request): Promise<Response> {
  try {
    const input = await readJson(request);
    if (!input || typeof input !== 'object' || Array.isArray(input))
      throw new ApiError(422, 'Некорректный запрос.');
    const { url, maxBytes, timeoutMs, accept, referer } = input as Record<string, unknown>;
    if (
      typeof url !== 'string' ||
      !Number.isInteger(maxBytes) ||
      (maxBytes as number) < 1 ||
      (maxBytes as number) > MAX_IMAGE_BYTES ||
      !Number.isInteger(timeoutMs) ||
      (timeoutMs as number) < 1 ||
      (timeoutMs as number) > 15000 ||
      (accept !== undefined &&
        (typeof accept !== 'string' || accept.length > 200 || /[\r\n]/.test(accept))) ||
      (referer !== undefined && typeof referer !== 'string')
    )
      throw new ApiError(422, 'Некорректные пределы загрузки.');
    const result = await publicGet(url, {
      maxBytes: maxBytes as number,
      timeoutMs: timeoutMs as number,
      accept: accept as string | undefined,
      cloudFallback: false,
      referer: referer as string | undefined,
    });
    return new Response(new Uint8Array(result.body), {
      headers: {
        'Content-Type': result.headers['content-type'] || 'application/octet-stream',
        'Content-Length': String(result.body.length),
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
        'X-Shelf-Upstream-Status': String(result.status),
        'X-Shelf-Upstream-Url': result.url,
      },
    });
  } catch (error) {
    return errorResponse(error);
  }
}
