import { ApiError, boundedWork, errorResponse, guardRequest, readBody } from '@/lib/server/http';
import { normalizeSourceImage } from '@/lib/server/image';
import { MAX_IMAGE_BYTES, publicGet, validatePublicUrl } from '@/lib/server/public-fetch';
import { reserveSource } from '@/lib/server/database';
import { sourceFailure } from '@/lib/server/source-policy';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;
function imageResponse(image: Awaited<ReturnType<typeof normalizeSourceImage>>): Response {
  return new Response(new Uint8Array(image.body), {
    headers: {
      'Content-Type': image.mime,
      'Content-Length': String(image.body.length),
      'Cache-Control': 'private, no-store',
      'X-Content-Type-Options': 'nosniff',
      'Content-Disposition': 'inline',
      'X-Shelf-Image-Converted': String(image.converted),
    },
  });
}
export async function GET(request: Request): Promise<Response> {
  try {
    guardRequest(request);
    const url = new URL(request.url).searchParams.get('url');
    const page = new URL(request.url).searchParams.get('page');
    if (page) validatePublicUrl(page);
    if (!url) throw new ApiError(422, 'Не указан URL изображения.');
    return await boundedWork(async () => {
      const source = validatePublicUrl(url);
      await reserveSource(source.hostname, 250);
      const options = {
        maxBytes: MAX_IMAGE_BYTES,
        referer: page || undefined,
        accept: 'image/avif,image/webp,image/png,image/jpeg,image/gif,image/tiff',
      };
      // Zakaz's indexed thumbnails and full image use the same immutable asset
      // directory and timestamp. Prefer that existing source rendition; do not upscale.
      if (
        /^img\d+\.zakaz\.(?:md|ua)$/.test(source.hostname) &&
        !source.search &&
        /^\/[a-f0-9]{32}\/\d+-s(?:150|350)x(?:150|350)\.jpg$/.test(source.pathname)
      ) {
        const full = new URL(source);
        full.pathname = full.pathname.replace(/-s\d+x\d+\.jpg$/, '-s1350x1350.jpg');
        try {
          const preferred = await publicGet(full.href, { ...options, timeoutMs: 8000 });
          if ([429, 503].includes(preferred.status))
            throw await sourceFailure(
              full.href,
              preferred,
              `Источник попросил паузу (HTTP ${preferred.status}). Повторите загрузку позже.`,
            );
          if (preferred.status === 200) {
            const response = imageResponse(await normalizeSourceImage(preferred.body));
            response.headers.set('X-Shelf-Image-Upgraded', 'true');
            return response;
          }
        } catch (error) {
          if (error instanceof ApiError && error.retryAfterMs !== undefined) throw error;
          // An absent, blocked, oversized or corrupt rendition must not hide a usable photo.
        }
      }
      const result = await publicGet(source.href, options);
      if (result.status !== 200)
        throw await sourceFailure(
          source.href,
          result,
          `Источник не предоставил изображение (HTTP ${result.status}). Выберите другое фото или загрузите свой файл.`,
        );
      return imageResponse(await normalizeSourceImage(result.body));
    });
  } catch (error) {
    return errorResponse(error);
  }
}
export async function POST(request: Request): Promise<Response> {
  try {
    guardRequest(request);
    if (request.headers.get('content-type') !== 'application/octet-stream')
      throw new ApiError(415, 'Ожидается файл изображения.');
    return await boundedWork(async () =>
      imageResponse(await normalizeSourceImage(await readBody(request, MAX_IMAGE_BYTES))),
    );
  } catch (error) {
    return errorResponse(error);
  }
}
