import type { SearchResponse } from '../types';

/** Structured operational evidence only: no product attributes, URLs, reasons, keys or request bodies. */
export function recordSearchTiming(
  requestId: string,
  elapsedMs: number,
  httpStatus: number,
  result?: SearchResponse,
) {
  console.info(
    JSON.stringify({
      event: 'shelf.search',
      requestId,
      region: process.env.VERCEL_REGION || 'local',
      commit: process.env.SHELF_BUILD_COMMIT || null,
      fingerprint: process.env.SHELF_BUILD_FINGERPRINT || null,
      httpStatus,
      elapsedMs: Math.max(0, Math.round(elapsedMs)),
      firstUsablePhotoMs: result?.firstUsablePhotoMs ?? null,
      outcome: result?.outcome ?? (httpStatus >= 400 ? 'error' : 'unknown'),
      coverage: result?.coverage ?? null,
      sources: (result?.diagnostics ?? []).map(
        ({ id, status, count, elapsedMs, httpStatus, requests }) => ({
          id,
          status,
          count,
          elapsedMs,
          ...(httpStatus === undefined ? {} : { httpStatus }),
          ...(requests === undefined ? {} : { requests }),
        }),
      ),
    }),
  );
}
