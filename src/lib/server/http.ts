import { createHash, timingSafeEqual } from 'node:crypto';
import { abortable, currentSearchSignal } from './search-signal';

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public retryAfterMs?: number,
  ) {
    super(message);
  }
}

export function errorResponse(error: unknown): Response {
  const status = error instanceof ApiError ? error.status : 502;
  const message =
    error instanceof ApiError
      ? error.message
      : 'Внешний сервис временно недоступен. Повторите запрос позже.';
  return Response.json(
    { error: message },
    {
      status,
      headers: {
        'Cache-Control': 'no-store',
        ...(error instanceof ApiError && error.retryAfterMs !== undefined
          ? { 'Retry-After': String(Math.ceil(error.retryAfterMs / 1000)) }
          : {}),
        ...(status === 401 ? { 'WWW-Authenticate': 'Basic realm="Shelf", charset="UTF-8"' } : {}),
      },
    },
  );
}

function browserOrigin(request: Request): string {
  const internal = new URL(request.url);
  // Vercel supplies Host as accessed by the client and its own forwarded protocol.
  // Outside that known proxy environment, forwarded headers are untrusted.
  const onVercel = process.env.VERCEL === '1';
  const forwardedProtocol = onVercel ? request.headers.get('x-forwarded-proto') : null;
  if (forwardedProtocol && forwardedProtocol !== 'https' && forwardedProtocol !== 'http')
    throw new ApiError(403, 'Некорректный протокол запроса.');
  const protocol = forwardedProtocol ? `${forwardedProtocol}:` : internal.protocol;
  const host = request.headers.get('host') || internal.host;
  // Never use X-Forwarded-Host. Reject authority syntax that can become URL paths/credentials.
  if (host.length > 300 || !/^(?:[a-z0-9.-]+|\[[a-f0-9:]+\])(?::\d{1,5})?$/i.test(host))
    throw new ApiError(403, 'Некорректный Host запроса.');
  let external: URL;
  try {
    external = new URL(`${protocol}//${host}`);
  } catch {
    throw new ApiError(403, 'Некорректный Host запроса.');
  }
  const loopback = (hostname: string) => ['localhost', '127.0.0.1', '[::1]'].includes(hostname);
  if (!onVercel && loopback(internal.hostname) && !loopback(external.hostname))
    throw new ApiError(403, 'Локальный сервер принимает только локальный Host.');
  return external.origin;
}

export function guardRequest(request: Request, allowUnconfigured = false): void {
  const password = process.env.MVP_ACCESS_PASSWORD;
  if (!password && process.env.NODE_ENV === 'production' && !allowUnconfigured) {
    throw new ApiError(
      503,
      'В рабочем окружении задайте MVP_ACCESS_PASSWORD перед использованием API.',
    );
  }
  if (password) {
    const authorization = request.headers.get('authorization') || '';
    let supplied = '';
    if (authorization.startsWith('Basic ') && authorization.length < 4096) {
      const decoded = Buffer.from(authorization.slice(6), 'base64').toString('utf8');
      supplied = decoded.slice(decoded.indexOf(':') + 1);
      if (!decoded.includes(':') || decoded.slice(0, decoded.indexOf(':')) !== 'admin')
        supplied = '';
    }
    const hash = (value: string) => createHash('sha256').update(value).digest();
    if (!timingSafeEqual(hash(password), hash(supplied)))
      throw new ApiError(401, 'Требуется пароль доступа Shelf.');
  }
  if (request.method === 'POST') {
    const origin = request.headers.get('origin');
    if (!origin || origin !== browserOrigin(request))
      throw new ApiError(403, 'Разрешены только запросы с текущего сайта.');
  }
  if (request.headers.get('sec-fetch-site') === 'cross-site')
    throw new ApiError(403, 'Межсайтовый запрос запрещён.');
}

export async function readBody(
  request: Pick<Request, 'headers' | 'body'>,
  maxBytes: number,
): Promise<Uint8Array> {
  const signal = currentSearchSignal();
  signal?.throwIfAborted();
  const declared = Number(request.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes)
    throw new ApiError(413, 'Размер запроса превышает допустимый.');
  if (!request.body) throw new ApiError(400, 'Пустой запрос.');
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await abortable(reader.read(), signal);
      if (done) break;
      total += value.length;
      if (total > maxBytes) {
        await reader.cancel();
        throw new ApiError(413, 'Размер запроса превышает допустимый.');
      }
      chunks.push(value);
    }
  } finally {
    if (signal?.aborted) void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  return Buffer.concat(chunks);
}

export async function readJson(request: Request, maxBytes = 16_384): Promise<unknown> {
  if (!request.headers.get('content-type')?.includes('application/json'))
    throw new ApiError(415, 'Ожидается application/json.');
  try {
    return JSON.parse(Buffer.from(await readBody(request, maxBytes)).toString('utf8'));
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(400, 'Некорректный JSON.');
  }
}

// This bounds work only inside one Node process. It is deliberately not a daily quota counter.
let active = 0;
export async function boundedWork<T>(job: () => Promise<T>): Promise<T> {
  if (active >= 3)
    throw new ApiError(429, 'Слишком много одновременных запросов. Повторите позже.');
  active++;
  try {
    return await job();
  } finally {
    active--;
  }
}
