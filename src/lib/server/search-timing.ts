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
      httpStatus,
      elapsedMs: Math.max(0, Math.round(elapsedMs)),
      outcome: result?.outcome ?? (httpStatus >= 400 ? 'error' : 'unknown'),
      sources: (result?.diagnostics ?? []).map(({ id, status, count, elapsedMs, httpStatus }) => ({
        id,
        status,
        count,
        elapsedMs,
        ...(httpStatus === undefined ? {} : { httpStatus }),
      })),
    }),
  );
}
