import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { request as httpsRequest } from 'node:https';
import { ApiError } from './http';

export const MAX_IMAGE_BYTES = 4_000_000;
export const USER_AGENT =
  'ShelfProductImages/0.1 (local planogram preparation; https://openfoodfacts.org)';
export interface Address {
  address: string;
  family: number;
}
export type Resolver = (hostname: string) => Promise<Address[]>;
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
}
export type Transport = (
  url: URL,
  address: Address,
  options: GetOptions,
) => Promise<PublicResponse>;

export function isPublicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) {
    const [a, b, c] = address.split('.').map(Number);
    return !(
      a === 0 ||
      a === 10 ||
      a === 127 ||
      a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 192 && b === 0) ||
      (a === 192 && b === 88 && c === 99) ||
      (a === 198 && (b === 18 || b === 19)) ||
      (a === 198 && b === 51 && c === 100) ||
      (a === 203 && b === 0 && c === 113)
    );
  }
  if (family === 6) {
    // Permit global unicast only; mapped IPv4, NAT64, ULA, multicast and link-local are excluded.
    const first = parseInt(address.split(':')[0], 16);
    const second = parseInt(address.split(':')[1] || '0', 16);
    return (
      first >= 0x2000 &&
      first <= 0x3fff &&
      first !== 0x2002 &&
      first !== 0x3fff &&
      !(first === 0x2001 && (second <= 0x1ff || second === 0xdb8))
    );
  }
  return false;
}

export function validatePublicUrl(value: string): URL {
  if (typeof value !== 'string' || value.length > 4096)
    throw new ApiError(422, 'Некорректный URL.');
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ApiError(422, 'Некорректный URL.');
  }
  if (url.protocol !== 'https:' || (url.port && url.port !== '443') || url.username || url.password)
    throw new ApiError(
      422,
      'Допускается только публичный HTTPS URL без авторизации и нестандартного порта.',
    );
  const hostname = url.hostname
    .replace(/^\[|\]$/g, '')
    .toLowerCase()
    .replace(/\.$/, '');
  if (isIP(hostname)) {
    if (!isPublicAddress(hostname))
      throw new ApiError(422, 'Внутренние и служебные IP-адреса запрещены.');
  } else if (
    !hostname.includes('.') ||
    /(^|\.)(localhost|local|internal|home|lan|test|invalid|example)$/.test(hostname) ||
    !/^[a-z0-9.-]+$/.test(hostname)
  ) {
    throw new ApiError(422, 'Внутренние и служебные домены запрещены.');
  }
  return url;
}

export async function resolvePublicUrl(
  value: string,
  resolver: Resolver = async (host) => lookup(host, { all: true, verbatim: true }),
): Promise<{ url: URL; address: Address }> {
  const url = validatePublicUrl(value);
  const host = url.hostname.replace(/^\[|\]$/g, '');
  let timer: ReturnType<typeof setTimeout> | undefined;
  let addresses: Address[];
  try {
    addresses = isIP(host)
      ? [{ address: host, family: isIP(host) }]
      : await Promise.race([
          resolver(host),
          new Promise<never>((_resolve, reject) => {
            timer = setTimeout(
              () => reject(new ApiError(504, 'DNS источника не ответил вовремя.')),
              8_000,
            );
            timer.unref();
          }),
        ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
  if (!addresses.length || addresses.some((item) => !isPublicAddress(item.address)))
    throw new ApiError(422, 'DNS указывает на внутренний или служебный адрес.');
  return { url, address: addresses.find((item) => item.family === 4) || addresses[0] };
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
        method: 'GET',
        agent: false,
        headers: {
          'User-Agent': options.userAgent || USER_AGENT,
          Accept: options.accept || 'image/jpeg,image/png,image/webp',
          'Accept-Encoding': 'identity',
        },
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
    const timer = setTimeout(() => {
      req.destroy();
      fail(new ApiError(504, 'Источник не ответил вовремя.'));
    }, options.timeoutMs ?? 12_000);
    timer.unref();
    req.on('close', () => clearTimeout(timer));
    req.on('error', fail);
    req.end();
  });

export async function publicGet(
  value: string,
  options: GetOptions = {},
  dependencies: { resolver?: Resolver; transport?: Transport } = {},
): Promise<PublicResponse> {
  let current = value;
  for (let hop = 0; hop <= 3; hop++) {
    const { url, address } = await resolvePublicUrl(current, dependencies.resolver);
    const result = await (dependencies.transport || transport)(url, address, options);
    if ([301, 302, 303, 307, 308].includes(result.status)) {
      if (!result.headers.location || hop === 3)
        throw new ApiError(502, 'Слишком много перенаправлений источника.');
      current = new URL(result.headers.location, url).href;
      continue;
    }
    return result;
  }
  throw new ApiError(502, 'Ошибка загрузки источника.');
}
