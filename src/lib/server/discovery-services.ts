import { ApiError, readBody } from './http';
import { obj } from './catalog-utils';
import { publicGet, validatePublicUrl } from './public-fetch';
import { outboundFetch } from './outbound-fetch';
import { sourceFailure } from './source-policy';

/** Backend addresses are deployment settings, never client input. */
export function serviceEndpoint(base: string, path: string): URL {
  let url: URL;
  try {
    url = new URL(base);
  } catch {
    throw new ApiError(503, 'Некорректный адрес поискового сервиса.');
  }
  if (url.username || url.password || url.search || url.hash)
    throw new ApiError(503, 'Адрес сервиса не должен содержать пароль или параметры.');
  const local =
    process.env.NODE_ENV !== 'production' &&
    url.protocol === 'http:' &&
    ['127.0.0.1', '[::1]'].includes(url.hostname);
  if (!local) validatePublicUrl(url.href);
  return new URL(`${url.href.replace(/\/$/, '')}/${path.replace(/^\//, '')}`);
}

export async function serviceJson(
  url: URL,
  token?: string,
  body?: unknown,
  timeoutMs = 12_000,
  maxBytes = 1_500_000,
  authHeader: 'Bearer' | 'X-Subscription-Token' = 'Bearer',
): Promise<Record<string, unknown>> {
  const headers: Record<string, string> = {
    ...(token
      ? authHeader === 'X-Subscription-Token'
        ? { 'X-Subscription-Token': token }
        : { Authorization: `Bearer ${token}` }
      : {}),
    ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
  };
  let status: number, data: Uint8Array;
  let responseHeaders: Record<string, string> = {};
  if (
    url.protocol === 'http:' &&
    process.env.NODE_ENV !== 'production' &&
    ['127.0.0.1', '[::1]'].includes(url.hostname)
  ) {
    const response = await outboundFetch(url, {
      method: body === undefined ? 'GET' : 'POST',
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      cache: 'no-store',
      redirect: 'error',
      timeoutMs,
    });
    status = response.status;
    responseHeaders = Object.fromEntries(response.headers);
    data = await readBody(response, maxBytes);
  } else {
    const response = await publicGet(url.href, {
      method: body === undefined ? 'GET' : 'POST',
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      timeoutMs,
      maxBytes,
      accept: 'application/json',
      followRedirects: false,
    });
    status = response.status;
    responseHeaders = response.headers;
    data = response.body;
  }
  if ([432, 433].includes(status)) throw new ApiError(429, 'Лимит бесплатного поиска исчерпан.');
  if (status !== 200)
    throw await sourceFailure(
      url.href,
      { status, headers: responseHeaders },
      status === 429
        ? 'Лимит бесплатного поиска исчерпан.'
        : `Сервис поиска ответил HTTP ${status}.`,
    );
  try {
    const parsed: unknown = JSON.parse(Buffer.from(data).toString('utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error();
    return obj(parsed);
  } catch {
    throw new ApiError(502, 'Сервис поиска вернул некорректный JSON.');
  }
}
