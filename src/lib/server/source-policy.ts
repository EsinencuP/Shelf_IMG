import { cooldownSource } from './database';
import { ApiError } from './http';
import { abortable, currentSearchSignal } from './search-signal';

/** Retry-After supports delta seconds and HTTP-date, as in urllib3's retry policy. */
export function retryAfterMs(value?: string, now = Date.now()): number {
  let delay = 60000;
  const text = value?.trim();
  if (text && /^\d+$/.test(text)) delay = Number(text) * 1000;
  else if (text && /GMT$/i.test(text)) {
    const time = Date.parse(text);
    if (Number.isFinite(time)) delay = time - now;
  }
  return Number.isFinite(delay) ? Math.max(1000, Math.min(86400000, delay)) : 60000;
}

export async function sourceFailure(
  url: string,
  response: { status: number; headers: Record<string, string>; url?: string },
  message: string,
): Promise<ApiError> {
  const delay = [403, 406, 429, 503].includes(response.status)
    ? retryAfterMs(response.headers['retry-after'])
    : undefined;
  if (delay !== undefined) {
    // A database outage must not hide the original upstream failure.
    await abortable(
      cooldownSource(new URL(response.url || url).hostname, delay),
      currentSearchSignal(),
    ).catch(() => {});
  }
  return new ApiError(
    response.status === 429 ? 429 : response.status === 404 ? 404 : 502,
    message,
    delay,
  );
}
