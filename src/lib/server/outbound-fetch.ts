export const USER_AGENT = 'ShelfProductImages/0.1 (+https://shelf-img.vercel.app)';
export const OUTBOUND_TIMEOUT_MS = 12_000;

export interface OutboundFetchOptions extends RequestInit {
  timeoutMs?: number;
  userAgent?: string;
  /** Send only the page origin, never its query, credentials or path. */
  referer?: string;
}

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
): Promise<T>;
/** Shared policy for native fetch and the DNS-pinned public HTTPS transport. */
export async function outboundFetch(
  url: string | URL,
  options: OutboundFetchOptions = {},
  transport?: OutboundTransport<unknown>,
): Promise<unknown> {
  const {
    timeoutMs = OUTBOUND_TIMEOUT_MS,
    userAgent = USER_AGENT,
    referer,
    signal,
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
