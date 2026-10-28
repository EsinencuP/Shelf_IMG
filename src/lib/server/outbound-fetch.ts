import { ApiError, readBody } from './http';
import { validatePublicUrl } from './public-url';

export const USER_AGENT = 'ShelfProductImages/0.1 (+https://shelf-img.vercel.app)';
export const OUTBOUND_TIMEOUT_MS = 12_000;

export interface OutboundFetchOptions extends RequestInit {
  timeoutMs?: number;
  userAgent?: string;
  /** Send only the page origin, never its query, credentials or path. */
  referer?: string;
  /** Probe, relay servers and internal service calls must never recurse. */
  relay?: boolean;
  maxBytes?: number;
}

export class RelayOfflineError extends ApiError {
  readonly sourceStatus = 'relay_offline';
  constructor() {
    super(503, 'Настроенный relay недоступен. Проверьте сервер, адрес и токен relay.');
    this.name = 'RelayOfflineError';
  }
}

export const isRelayConfigured = () => !!(process.env.RELAY_URL?.trim() && process.env.RELAY_TOKEN);

export type OutboundRequest = RequestInit & {
  headers: Record<string, string>;
  signal: AbortSignal;
};
export type OutboundTransport<T> = (url: string | URL, options: OutboundRequest) => Promise<T>;

export function outboundFetch(
  url: string | URL,
  options?: OutboundFetchOptions,
  transport?: OutboundTransport<Response>,
): Promise<Response>;
export function outboundFetch<T>(
  url: string | URL,
  options: OutboundFetchOptions,
  transport: OutboundTransport<T>,
  fromRelay: (response: Response) => Promise<T>,
): Promise<T>;
/** Shared policy for native fetch and the DNS-pinned public HTTPS transport. */
export async function outboundFetch(
  url: string | URL,
  options: OutboundFetchOptions = {},
  transport?: OutboundTransport<unknown>,
  fromRelay?: (response: Response) => Promise<unknown>,
): Promise<unknown> {
  let result: unknown;
  try {
    result = await send(url, options, transport);
  } catch (error) {
    if (!canRetry(url, options) || !retryableFailure(error)) throw error;
    return throughRelay(url, options, fromRelay);
  }
  const status =
    result && typeof result === 'object' && 'status' in result ? result.status : undefined;
  if (!canRetry(url, options) || !retryableStatus(status)) return result;
  // Release a rejected native response before opening the single fallback request.
  if (result instanceof Response) void result.body?.cancel().catch(() => {});
  return throughRelay(url, options, fromRelay);
}

function retryableStatus(status: unknown): boolean {
  return typeof status === 'number' && [403, 406, 408, 429, 451, 502, 503, 504].includes(status);
}

function retryableFailure(error: unknown): boolean {
  if (error instanceof RelayOfflineError) return false;
  if (!error || typeof error !== 'object') return false;
  const value = error as {
    name?: string;
    status?: number;
    code?: string;
    cause?: { code?: string };
  };
  return (
    ['TimeoutError', 'AbortError'].includes(value.name || '') ||
    retryableStatus(value.status) ||
    [
      'ECONNRESET',
      'ECONNREFUSED',
      'ETIMEDOUT',
      'EHOSTUNREACH',
      'ENETUNREACH',
      'UND_ERR_CONNECT_TIMEOUT',
      'UND_ERR_SOCKET',
    ].includes(value.code || value.cause?.code || '')
  );
}

function canRetry(url: string | URL, options: OutboundFetchOptions): boolean {
  if (
    options.relay === false ||
    options.signal?.aborted ||
    !isRelayConfigured() ||
    (options.method || 'GET').toUpperCase() !== 'GET' ||
    options.body != null
  )
    return false;
  // Never replay credentials or source-specific headers to a different egress.
  if (
    [...new Headers(options.headers).keys()].some(
      (name) => !['accept', 'accept-encoding', 'user-agent', 'referer'].includes(name),
    )
  )
    return false;
  try {
    validatePublicUrl(String(url));
    return true;
  } catch {
    return false;
  }
}

function relayEndpoint(): URL {
  try {
    const base = new URL(process.env.RELAY_URL!.trim());
    if (base.username || base.password || base.search || base.hash) throw new RelayOfflineError();
    const local =
      process.env.VERCEL !== '1' &&
      base.protocol === 'http:' &&
      ['localhost', '127.0.0.1', '[::1]'].includes(base.hostname);
    if (!local) validatePublicUrl(base.href);
    return new URL('fetch', base.href.replace(/\/?$/, '/'));
  } catch {
    throw new RelayOfflineError();
  }
}

async function throughRelay(
  url: string | URL,
  options: OutboundFetchOptions,
  fromRelay?: (response: Response) => Promise<unknown>,
): Promise<unknown> {
  try {
    const endpoint = relayEndpoint();
    const maxBytes = options.maxBytes ?? 4_000_000;
    const response = (await send(
      endpoint,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${process.env.RELAY_TOKEN}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ url: String(url) }),
        redirect: 'error',
        timeoutMs: options.timeoutMs,
        signal: options.signal,
        relay: false,
      },
      async (target, init) => {
        const reply = await fetch(target, init);
        const upstreamStatus = Number(reply.headers.get('x-shelf-upstream-status'));
        const upstreamUrl = reply.headers.get('x-shelf-upstream-url');
        if (
          !upstreamUrl ||
          !Number.isInteger(upstreamStatus) ||
          upstreamStatus !== reply.status ||
          [301, 302, 303, 307, 308].includes(reply.status)
        ) {
          void reply.body?.cancel().catch(() => {});
          if (
            reply.headers.get('x-shelf-relay') === '1' &&
            [403, 413, 422, 429, 504].includes(reply.status)
          )
            throw new ApiError(reply.status, `Relay не выполнил загрузку (HTTP ${reply.status}).`);
          throw new RelayOfflineError();
        }
        try {
          validatePublicUrl(upstreamUrl);
        } catch {
          void reply.body?.cancel().catch(() => {});
          throw new RelayOfflineError();
        }
        const body = reply.body ? await readBody(reply, maxBytes) : Buffer.alloc(0);
        const headers = new Headers(reply.headers);
        headers.delete('content-encoding');
        headers.set('content-length', String(body.length));
        return new Response([204, 205, 304].includes(reply.status) ? null : new Uint8Array(body), {
          status: reply.status,
          headers,
        });
      },
    )) as Response;
    return fromRelay ? await fromRelay(response) : response;
  } catch (error) {
    if (options.signal?.aborted) throw options.signal.reason;
    if (error instanceof ApiError) throw error;
    throw new RelayOfflineError();
  }
}

async function send(
  url: string | URL,
  options: OutboundFetchOptions,
  transport?: OutboundTransport<unknown>,
): Promise<unknown> {
  const {
    timeoutMs = OUTBOUND_TIMEOUT_MS,
    userAgent = USER_AGENT,
    referer,
    signal,
    relay: _relay,
    maxBytes: _maxBytes,
    ...init
  } = options;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0)
    throw new RangeError('timeoutMs must be a positive integer');
  const headers = new Headers(init.headers);
  if (!headers.has('user-agent')) headers.set('user-agent', userAgent);
  headers.set('referer', new URL(headers.get('referer') ?? referer ?? url).origin + '/');
  const deadline = AbortSignal.timeout(timeoutMs);
  const combined = signal ? AbortSignal.any([signal, deadline]) : deadline;
  combined.throwIfAborted();
  const request: OutboundRequest = {
    cache: 'no-store',
    redirect: 'error',
    ...init,
    headers: Object.fromEntries(headers),
    signal: combined,
  };
  let onAbort: () => void;
  try {
    return await new Promise((resolve, reject) => {
      onAbort = () => reject(combined.reason);
      combined.addEventListener('abort', onAbort, { once: true });
      Promise.resolve()
        .then(() => {
          combined.throwIfAborted();
          return transport ? transport(url, request) : fetch(url, request);
        })
        .then(resolve, reject);
    });
  } finally {
    combined.removeEventListener('abort', onAbort!);
  }
}
