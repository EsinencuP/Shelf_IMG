import { request as httpsRequest } from 'node:https';
import { brotliDecompressSync, gunzipSync, inflateSync } from 'node:zlib';
import { ApiError, readBody } from './http';
import { outboundFetch, isRelayConfigured } from './outbound-fetch';
import { resolvePublicUrl, validatePublicUrl, type Address, type Resolver } from './public-url';
export {
  isPublicAddress,
  resolvePublicUrl,
  validatePublicUrl,
  type Address,
  type Resolver,
} from './public-url';

export const MAX_IMAGE_BYTES = 4_000_000;
export { USER_AGENT } from './outbound-fetch';
export interface PublicResponse {
  status: number;
  headers: Record<string, string>;
  body: Buffer;
  url: string;
}
export interface GetOptions {
  maxBytes?: number;
  timeoutMs?: number;
  accept?: string;
  userAgent?: string;
  method?: 'GET' | 'POST';
  body?: string;
  headers?: Record<string, string>;
  followRedirects?: boolean;
  cloudFallback?: boolean;
  referer?: string;
  signal?: AbortSignal;
  /** Exact hostnames, checked before DNS on every redirect hop. */
  allowedHosts?: ReadonlySet<string>;
  relay?: boolean;
}
export type Transport = (
  url: URL,
  address: Address,
  options: GetOptions,
) => Promise<PublicResponse>;

/** Limit both the wire payload and the expanded payload. */
export function decodeResponseBody(body: Buffer, encoding: string, maxBytes: number): Buffer {
  try {
    const options = { maxOutputLength: maxBytes };
    switch (encoding.trim().toLowerCase()) {
      case '':
      case 'identity':
        if (body.length > maxBytes) throw new ApiError(413, 'Ответ превышает допустимый размер.');
        return body;
      case 'gzip':
        return gunzipSync(body, options);
      case 'br':
        return brotliDecompressSync(body, options);
      case 'deflate':
        return inflateSync(body, options);
      default:
        throw new ApiError(415, 'Неизвестное сжатие сетевого ответа.');
    }
  } catch (error) {
    if (error instanceof ApiError) throw error;
    if ((error as NodeJS.ErrnoException).code === 'ERR_BUFFER_TOO_LARGE')
      throw new ApiError(413, 'Распакованный ответ превышает допустимый размер.');
    throw new ApiError(502, 'Источник вернул повреждённый сжатый ответ.');
  }
}

const transport: Transport = (url, address, options) =>
  new Promise((resolve, reject) => {
    const maxBytes = options.maxBytes ?? MAX_IMAGE_BYTES;
    let settled = false;
    const fail = (error: Error) => {
      if (!settled) {
        settled = true;
        reject(error);
      }
    };
    const req = httpsRequest(
      url,
      {
        method: options.method || 'GET',
        agent: false,
        headers: options.headers,
        signal: options.signal,
        // Pin the socket to the address validated above, preserving hostname and TLS verification.
        lookup: (_hostname, lookupOptions, callback) => {
          if (lookupOptions.all)
            callback(null, [{ address: address.address, family: address.family }]);
          else callback(null, address.address, address.family);
        },
      },
      (res) => {
        const headers: Record<string, string> = {};
        for (const [key, value] of Object.entries(res.headers))
          if (value !== undefined) headers[key] = Array.isArray(value) ? value.join(', ') : value;
        if (Number(headers['content-length']) > maxBytes) {
          res.destroy();
          req.destroy();
          fail(new ApiError(413, 'Файл превышает допустимый размер.'));
          return;
        }
        const chunks: Buffer[] = [];
        let total = 0;
        res.on('data', (chunk: Buffer) => {
          total += chunk.length;
          if (total > maxBytes) {
            res.destroy();
            req.destroy();
            fail(new ApiError(413, 'Файл превышает допустимый размер.'));
            return;
          }
          chunks.push(chunk);
        });
        res.on('error', fail);
        res.on('aborted', () => fail(new ApiError(502, 'Источник прервал загрузку.')));
        res.on('end', () => {
          if (!settled) {
            let body: Buffer;
            try {
              body = decodeResponseBody(
                Buffer.concat(chunks),
                headers['content-encoding'] || '',
                maxBytes,
              );
            } catch (error) {
              fail(error as Error);
              return;
            }
            delete headers['content-encoding'];
            headers['content-length'] = String(body.length);
            settled = true;
            resolve({
              status: res.statusCode || 502,
              headers,
              body,
              url: url.href,
            });
          }
        });
      },
    );
    req.on('error', fail);
    req.end(options.body);
  });

/** A second cloud egress; credentials and request headers are never forwarded to the source. */
export async function cloudGet(
  value: string,
  options: GetOptions,
): Promise<PublicResponse | undefined> {
  if (
    process.env.VERCEL !== '1' ||
    !process.env.SHELF_WORKER_URL ||
    !process.env.SHELF_WORKER_SECRET
  )
    return undefined;
  const worker = validatePublicUrl(process.env.SHELF_WORKER_URL);
  if (!worker.hostname.endsWith('.neon.tech') || worker.search || worker.hash) return undefined;
  const maxBytes = options.maxBytes ?? MAX_IMAGE_BYTES;
  const response = await outboundFetch(new URL('fetch', worker), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-secret': process.env.SHELF_WORKER_SECRET },
    body: JSON.stringify({
      url: value,
      maxBytes,
      timeoutMs: options.timeoutMs ?? 12000,
      accept: options.accept,
      referer: options.referer,
    }),
    redirect: 'manual',
    cache: 'no-store',
    relay: false,
    timeoutMs: (options.timeoutMs ?? 12000) + 10000,
    signal: options.signal,
  });
  if (!response.ok) return undefined;
  const status = Number(response.headers.get('x-shelf-upstream-status'));
  const url = response.headers.get('x-shelf-upstream-url');
  if (!Number.isInteger(status) || status < 200 || status > 599 || !url) return undefined;
  validatePublicUrl(url);
  return {
    status,
    url,
    headers: { 'content-type': response.headers.get('content-type') || 'application/octet-stream' },
    body: Buffer.from(await readBody(response, maxBytes)),
  };
}

export async function publicGet(
  value: string,
  options: GetOptions = {},
  dependencies: { resolver?: Resolver; transport?: Transport; cloud?: typeof cloudGet } = {},
): Promise<PublicResponse> {
  let current = value;
  for (let hop = 0; hop <= 3; hop++) {
    const target = validatePublicUrl(current);
    if (
      options.allowedHosts &&
      !options.allowedHosts.has(target.hostname.toLowerCase().replace(/\.$/, ''))
    )
      throw new ApiError(403, 'Домен источника не разрешён.');
    const { url, address } = await resolvePublicUrl(current, dependencies.resolver, options.signal);
    // Validate DNS before either egress. Do not replay auth, POSTs, quotas or invalid input.
    const canRelay =
      !isRelayConfigured() &&
      options.cloudFallback !== false &&
      (!options.method || options.method === 'GET') &&
      !options.body &&
      !Object.keys(options.headers || {}).length &&
      options.followRedirects !== false;
    let result: PublicResponse;
    try {
      result = await outboundFetch(
        url,
        {
          timeoutMs: options.timeoutMs,
          userAgent: options.userAgent,
          referer: options.referer ? validatePublicUrl(options.referer).href : undefined,
          signal: options.signal,
          relay: options.cloudFallback === false ? false : options.relay,
          maxBytes: options.maxBytes,
          method: options.method,
          body: options.body,
          headers: {
            Accept: options.accept || 'image/jpeg,image/png,image/webp',
            'Accept-Encoding': 'identity',
            ...options.headers,
          },
        },
        (_url, init) =>
          (dependencies.transport || transport)(url, address, {
            ...options,
            headers: init.headers,
            signal: init.signal,
          }),
        async (response) => ({
          status: response.status,
          headers: Object.fromEntries(response.headers),
          body: response.body
            ? Buffer.from(await readBody(response, options.maxBytes ?? MAX_IMAGE_BYTES))
            : Buffer.alloc(0),
          url: validatePublicUrl(response.headers.get('x-shelf-upstream-url') || url.href).href,
        }),
      );
    } catch (error) {
      if (options.signal?.aborted) throw options.signal.reason;
      if (canRelay && (!(error instanceof ApiError) || [502, 504].includes(error.status))) {
        const fallback = await (dependencies.cloud || cloudGet)(url.href, options).catch(
          () => undefined,
        );
        options.signal?.throwIfAborted();
        if (fallback?.status === 200) return fallback;
      }
      throw error;
    }
    if (canRelay && [403, 406, 500, 502, 503, 504].includes(result.status)) {
      const fallback = await (dependencies.cloud || cloudGet)(url.href, options).catch(
        () => undefined,
      );
      options.signal?.throwIfAborted();
      if (fallback?.status === 200) return fallback;
    }
    if ([301, 302, 303, 307, 308].includes(result.status)) {
      if (
        options.followRedirects === false ||
        options.method === 'POST' ||
        ['authorization', 'x-subscription-token', 'cookie', 'x-goog-api-key', 'x-secret'].some(
          (name) => new Headers(options.headers).has(name),
        )
      )
        throw new ApiError(502, 'Перенаправление сервисного API запрещено.');
      if (!result.headers.location || hop === 3)
        throw new ApiError(502, 'Слишком много перенаправлений источника.');
      current = new URL(result.headers.location, url).href;
      continue;
    }
    return result;
  }
  throw new ApiError(502, 'Ошибка загрузки источника.');
}
