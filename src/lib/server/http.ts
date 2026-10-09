import { createHash, timingSafeEqual } from 'node:crypto';

export class ApiError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

export function errorResponse(error: unknown): Response {
  const status = error instanceof ApiError ? error.status : 502;
  const message = error instanceof ApiError ? error.message : 'Внешний сервис временно недоступен. Повторите запрос позже.';
  return Response.json({ error: message }, { status, headers: { 'Cache-Control': 'no-store', ...(status === 401 ? { 'WWW-Authenticate': 'Basic realm="Shelf", charset="UTF-8"' } : {}) } });
}

export function guardRequest(request: Request, allowUnconfigured = false): void {
  const password = process.env.MVP_ACCESS_PASSWORD;
  if (!password && process.env.NODE_ENV === 'production' && !allowUnconfigured) {
    throw new ApiError(503, 'В рабочем окружении задайте MVP_ACCESS_PASSWORD перед использованием API.');
  }
  if (password) {
    const authorization = request.headers.get('authorization') || '';
    let supplied = '';
    if (authorization.startsWith('Basic ') && authorization.length < 4096) {
      const decoded = Buffer.from(authorization.slice(6), 'base64').toString('utf8');
      supplied = decoded.slice(decoded.indexOf(':') + 1);
      if (!decoded.includes(':')) supplied = '';
    }
    const hash = (value: string) => createHash('sha256').update(value).digest();
    if (!timingSafeEqual(hash(password), hash(supplied))) throw new ApiError(401, 'Требуется пароль доступа Shelf.');
  }
  if (request.method === 'POST') {
    const origin = request.headers.get('origin');
    if (!origin || origin !== new URL(request.url).origin) throw new ApiError(403, 'Разрешены только запросы с текущего сайта.');
  }
  if (request.headers.get('sec-fetch-site') === 'cross-site') throw new ApiError(403, 'Межсайтовый запрос запрещён.');
}

export async function readBody(request: Pick<Request, 'headers' | 'body'>, maxBytes: number): Promise<Uint8Array> {
  const declared = Number(request.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) throw new ApiError(413, 'Размер запроса превышает допустимый.');
  if (!request.body) throw new ApiError(400, 'Пустой запрос.');
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > maxBytes) { await reader.cancel(); throw new ApiError(413, 'Размер запроса превышает допустимый.'); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  return Buffer.concat(chunks);
}

export async function readJson(request: Request): Promise<unknown> {
  if (!request.headers.get('content-type')?.includes('application/json')) throw new ApiError(415, 'Ожидается application/json.');
  try { return JSON.parse(Buffer.from(await readBody(request, 16_384)).toString('utf8')); }
  catch (error) { if (error instanceof ApiError) throw error; throw new ApiError(400, 'Некорректный JSON.'); }
}

// This bounds work only inside one Node process. It is deliberately not a daily quota counter.
let active = 0;
export async function boundedWork<T>(job: () => Promise<T>): Promise<T> {
  if (active >= 3) throw new ApiError(429, 'Слишком много одновременных запросов. Повторите позже.');
  active++;
  try { return await job(); } finally { active--; }
}
