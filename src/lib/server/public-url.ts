import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { ApiError } from './http';

export interface Address {
  address: string;
  family: number;
}
export type Resolver = (hostname: string) => Promise<Address[]>;
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
  signal?: AbortSignal,
): Promise<{ url: URL; address: Address }> {
  signal?.throwIfAborted();
  const url = validatePublicUrl(value);
  const host = url.hostname.replace(/^\[|\]$/g, '');
  let timer: ReturnType<typeof setTimeout> | undefined;
  let addresses: Address[];
  let onAbort: (() => void) | undefined;
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
            if (signal) {
              onAbort = () => reject(signal.reason);
              signal.addEventListener('abort', onAbort, { once: true });
              if (signal.aborted) onAbort();
            }
          }),
        ]);
  } finally {
    if (timer) clearTimeout(timer);
    if (onAbort) signal?.removeEventListener('abort', onAbort);
  }
  if (!addresses.length || addresses.some((item) => !isPublicAddress(item.address)))
    throw new ApiError(422, 'DNS указывает на внутренний или служебный адрес.');
  return { url, address: addresses.find((item) => item.family === 4) || addresses[0] };
}
