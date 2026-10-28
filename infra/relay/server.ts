import { createHash, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { isIP } from 'node:net';
import { resolve } from 'node:path';
import { Readable } from 'node:stream';
import { pathToFileURL } from 'node:url';
import { ApiError, boundedWork, errorResponse, readJson } from '../../src/lib/server/http';
import {
  MAX_IMAGE_BYTES,
  publicGet,
  validatePublicUrl,
  type Resolver,
  type Transport,
} from '../../src/lib/server/public-fetch';

export interface RelayConfig {
  token: string;
  allowedHosts: ReadonlySet<string>;
  host: '127.0.0.1' | '::1';
  port: number;
  maxBytes: number;
  timeoutMs: number;
}

export function readRelayConfig(
  env: Record<string, string | undefined> = process.env,
): RelayConfig {
  const token = env.RELAY_TOKEN || '';
  if (token.length < 32 || token.length > 256 || /[^\x21-\x7e]/.test(token))
    throw new Error('RELAY_TOKEN must contain 32–256 non-whitespace ASCII characters.');
  const entries = (env.RELAY_ALLOWED_DOMAINS || '')
    .split(',')
    .map((entry) => entry.trim().toLowerCase());
  const allowedHosts = new Set<string>();
  for (const host of entries) {
    try {
      const url = validatePublicUrl(`https://${host}/`);
      if (url.hostname !== host || isIP(host) || host.endsWith('.')) throw new Error();
      allowedHosts.add(host);
    } catch {
      throw new Error(
        'RELAY_ALLOWED_DOMAINS must be a nonempty list of exact public domain names.',
      );
    }
  }
  const number = (key: string, fallback: number, max: number) => {
    const value = env[key] === undefined ? fallback : Number(env[key]);
    if (!Number.isSafeInteger(value) || value < 1 || value > max)
      throw new Error(`${key} must be an integer between 1 and ${max}.`);
    return value;
  };
  const host = env.RELAY_HOST || '127.0.0.1';
  if (host !== '127.0.0.1' && host !== '::1')
    throw new Error('RELAY_HOST must be 127.0.0.1 or ::1.');
  return {
    token,
    allowedHosts,
    host,
    port: number('RELAY_PORT', 8787, 65535),
    maxBytes: number('RELAY_MAX_BYTES', MAX_IMAGE_BYTES, MAX_IMAGE_BYTES),
    timeoutMs: number('RELAY_TIMEOUT_MS', 15000, 30000),
  };
}

export function createRelayHandler(
  config: RelayConfig,
  dependencies: { resolver?: Resolver; transport?: Transport } = {},
): (request: Request) => Promise<Response> {
  const tokenHash = createHash('sha256').update(config.token).digest();
  return async (request) => {
    try {
      const supplied =
        /^Bearer ([^\s]+)$/i.exec(request.headers.get('authorization') || '')?.[1] || '';
      if (!supplied || !timingSafeEqual(tokenHash, createHash('sha256').update(supplied).digest()))
        throw new ApiError(401, 'Требуется Bearer-токен relay.');
      const path = new URL(request.url).pathname;
      const method = path === '/health' ? 'GET' : path === '/fetch' ? 'POST' : undefined;
      if (!method) throw new ApiError(404, 'Маршрут не найден.');
      if (request.method !== method)
        return Response.json(
          { error: 'Метод не разрешён.' },
          { status: 405, headers: { Allow: method, 'Cache-Control': 'no-store' } },
        );
      if (path === '/health')
        return Response.json(
          { ok: true, service: 'shelf-relay' },
          { headers: { 'Cache-Control': 'no-store' } },
        );

      const input = await readJson(request);
      if (
        !input ||
        typeof input !== 'object' ||
        Array.isArray(input) ||
        Object.keys(input).some((key) => key !== 'url') ||
        typeof (input as Record<string, unknown>).url !== 'string'
      )
        throw new ApiError(422, 'Ожидается JSON с единственным полем url.');
      const url = (input as { url: string }).url;
      return await boundedWork(async () => {
        const result = await publicGet(
          url,
          {
            method: 'GET',
            allowedHosts: config.allowedHosts,
            cloudFallback: false,
            maxBytes: config.maxBytes,
            timeoutMs: config.timeoutMs,
            // Bounds DNS + all redirect hops, in addition to the per-request timeout.
            signal: AbortSignal.any([request.signal, AbortSignal.timeout(config.timeoutMs)]),
            accept: 'text/html,application/json,image/*;q=0.9,*/*;q=0.5',
          },
          dependencies,
        );
        if (result.body.length > config.maxBytes)
          throw new ApiError(413, 'Ответ превышает допустимый размер.');
        const noBody = [204, 205, 304].includes(result.status);
        return new Response(noBody ? null : new Uint8Array(result.body), {
          status: result.status,
          headers: {
            'Content-Type': result.headers['content-type'] || 'application/octet-stream',
            'Content-Length': String(noBody ? 0 : result.body.length),
            'Cache-Control': 'no-store',
            'X-Content-Type-Options': 'nosniff',
            'Content-Security-Policy':
              "sandbox; default-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
            'X-Shelf-Upstream-Status': String(result.status),
            'X-Shelf-Upstream-Url': result.url,
          },
        });
      });
    } catch (error) {
      const timedOut =
        error instanceof Error && ['TimeoutError', 'AbortError'].includes(error.name);
      const response = errorResponse(
        timedOut ? new ApiError(504, 'Время ожидания источника истекло.') : error,
      );
      if (response.status === 401)
        response.headers.set('WWW-Authenticate', 'Bearer realm="Shelf relay"');
      return response;
    }
  };
}

export function createRelayServer(
  config: RelayConfig,
  dependencies: Parameters<typeof createRelayHandler>[1] = {},
) {
  const handler = createRelayHandler(config, dependencies);
  const serve = async (incoming: IncomingMessage, outgoing: ServerResponse) => {
    const controller = new AbortController();
    const disconnect = () => {
      if (!outgoing.writableEnded) controller.abort();
    };
    outgoing.once('close', disconnect);
    try {
      if (!incoming.url?.startsWith('/')) throw new ApiError(400, 'Некорректный путь запроса.');
      const headers = new Headers();
      for (const [key, value] of Object.entries(incoming.headers))
        if (value !== undefined) headers.set(key, Array.isArray(value) ? value.join(', ') : value);
      const init: RequestInit & { duplex: 'half' } = {
        method: incoming.method,
        headers,
        signal: controller.signal,
        duplex: 'half',
        ...(!['GET', 'HEAD'].includes(incoming.method || 'GET')
          ? { body: Readable.toWeb(incoming) as ReadableStream<Uint8Array> }
          : {}),
      };
      const response = await handler(
        new Request(new URL(incoming.url, 'http://relay.local'), init),
      );
      if (!outgoing.destroyed) {
        outgoing.writeHead(response.status, Object.fromEntries(response.headers));
        outgoing.end(Buffer.from(await response.arrayBuffer()));
      }
    } catch (error) {
      if (!outgoing.destroyed) {
        const response = errorResponse(error);
        outgoing.writeHead(response.status, Object.fromEntries(response.headers));
        outgoing.end(await response.text());
      }
    } finally {
      // Drain unread bodies after auth/validation failures so keep-alive stays bounded.
      incoming.resume();
    }
  };
  return createServer(
    { requestTimeout: 10000, headersTimeout: 10000, maxHeaderSize: 16384 },
    (req, res) => {
      void serve(req, res);
    },
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const config = readRelayConfig();
    const server = createRelayServer(config);
    server.on('error', (error: NodeJS.ErrnoException) => {
      console.error(`Relay could not listen (${error.code || 'error'}).`);
      process.exitCode = 1;
    });
    server.listen(config.port, config.host, () => {
      const host = config.host === '::1' ? '[::1]' : config.host;
      console.log(`Shelf relay listening on http://${host}:${config.port}`);
    });
    for (const signal of ['SIGINT', 'SIGTERM'] as const)
      process.once(signal, () => {
        server.close(() => process.exit(0));
        setTimeout(() => {
          server.closeAllConnections();
          process.exit(0);
        }, 5000).unref();
      });
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'Invalid relay configuration.');
    process.exitCode = 1;
  }
}
