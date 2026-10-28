import { request as httpsRequest } from 'node:https';
import { ApiError, readBody } from './http';
import { outboundFetch } from './outbound-fetch';
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
  referer?: string;
  signal?: AbortSignal;
  /** Exact hostnames, checked before DNS on every redirect hop. */
  allowedHosts?: ReadonlySet<string>;
  relay?: boolean;
  /** Disable secondary egress when this process is itself a relay. */
  cloudFallback?: boolean;
}
export type Transport = (
  url: URL,
  address: Address,
  options: GetOptions,
) => Promise<PublicResponse>;

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
        if (headers['content-encoding'] && headers['content-encoding'] !== 'identity') {
          res.destroy();
          req.destroy();
          fail(new ApiError(415, 'Сжатый сетевой ответ не поддерживается.'));
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
            settled = true;
            resolve({
              status: res.statusCode || 502,
              headers,
              body: Buffer.concat(chunks),
              url: url.href,
            });
          }
        });
      },
    );
    req.on('error', fail);
    req.end(options.body);
  });

export async function publicGet(
  value: string,
  options: GetOptions = {},
  dependencies: { resolver?: Resolver; transport?: Transport } = {},
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
    const result = await outboundFetch(
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
