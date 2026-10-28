import { EventEmitter } from 'node:events';
import type { ClientRequest, IncomingMessage } from 'node:http';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const https = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock('node:https', () => ({ request: https.request }));
import { createRelayHandler, readRelayConfig } from '../infra/relay/server';

const token = 'unit-test-only-relay-token-1234567890';
const publicAddress = '93.184.216.34';
const config = () =>
  readRelayConfig({
    RELAY_TOKEN: token,
    RELAY_ALLOWED_DOMAINS: 'metro.zakaz.md',
    RELAY_MAX_BYTES: '32',
  });
const request = () =>
  new Request('http://relay.local/fetch', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ url: 'https://metro.zakaz.md/ru/' }),
  });
type LookupOptions = { all?: boolean };
type SocketAddress = string | { address: string; family: number }[];
interface PinnedOptions {
  lookup?: (
    host: string,
    options: LookupOptions,
    callback: (error: Error | null, address: SocketAddress, family?: number) => void,
  ) => void;
}

/** Fake only node:https. The relay, URL validation, DNS checks and byte counter run unchanged. */
function source(
  plan: {
    status?: number;
    headers?: Record<string, string>;
    chunks?: Buffer[];
    all?: boolean;
    beforeConnect?: () => void;
  } = {},
) {
  const req = Object.assign(new EventEmitter(), {
    destroyed: false,
    destroy: vi.fn(() => {
      req.destroyed = true;
      return req;
    }),
    end: vi.fn(),
  });
  const res = Object.assign(new EventEmitter(), {
    statusCode: plan.status ?? 200,
    headers: { 'content-type': 'text/html', ...plan.headers },
    destroyed: false,
    destroy: vi.fn(() => {
      res.destroyed = true;
      return res;
    }),
  });
  const socketLookup = vi.fn();
  https.request.mockImplementationOnce(
    (url: URL, options: PinnedOptions, receive: (response: IncomingMessage) => void) => {
      req.end.mockImplementation(() =>
        queueMicrotask(() => {
          plan.beforeConnect?.();
          options.lookup?.(url.hostname, { all: plan.all ?? false }, socketLookup);
          receive(res as unknown as IncomingMessage);
          for (const chunk of plan.chunks ?? [Buffer.from('<html>METRO</html>')]) {
            if (req.destroyed || res.destroyed) return;
            res.emit('data', chunk);
          }
          if (!req.destroyed && !res.destroyed) res.emit('end');
        }),
      );
      return req as unknown as ClientRequest;
    },
  );
  return { req, res, socketLookup };
}

beforeEach(() => {
  https.request.mockReset();
  // Any accidental switch to native fetch is a failed test, never a real request.
  vi.stubGlobal(
    'fetch',
    vi.fn(() => {
      throw new Error('Unexpected native fetch');
    }),
  );
});
afterEach(() => {
  expect(fetch).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
});

describe('relay DNS rebinding protection', () => {
  it.each([false, true])(
    'pins the validated IP when DNS changes before socket lookup (all=%s)',
    async (all) => {
      let dnsAddress = publicAddress;
      const resolver = vi.fn(async () => [{ address: dnsAddress, family: 4 }]);
      const socket = source({
        all,
        beforeConnect: () => {
          dnsAddress = '127.0.0.1';
        },
      });
      const response = await createRelayHandler(config(), { resolver })(request());
      expect(response.status).toBe(200);
      expect(dnsAddress).toBe('127.0.0.1');
      expect(resolver).toHaveBeenCalledExactlyOnceWith('metro.zakaz.md');
      expect(socket.socketLookup).toHaveBeenCalledExactlyOnceWith(
        null,
        all ? [{ address: publicAddress, family: 4 }] : publicAddress,
        ...(all ? [] : [4]),
      );
      expect(https.request).toHaveBeenCalledWith(
        new URL('https://metro.zakaz.md/ru/'),
        expect.objectContaining({
          method: 'GET',
          agent: false,
          lookup: expect.any(Function),
        }),
        expect.any(Function),
      );
    },
  );

  it.each(['127.0.0.1', '10.20.30.40', '169.254.169.254'])(
    'blocks a same-host redirect if DNS rebinds to %s',
    async (address) => {
      const resolver = vi
        .fn()
        .mockResolvedValueOnce([{ address: publicAddress, family: 4 }])
        .mockResolvedValueOnce([{ address, family: 4 }]);
      source({ status: 302, headers: { location: '/ru/next' }, chunks: [] });
      const response = await createRelayHandler(config(), { resolver })(request());
      expect(response.status).toBe(422);
      expect(resolver.mock.calls).toEqual([['metro.zakaz.md'], ['metro.zakaz.md']]);
      expect(https.request).toHaveBeenCalledTimes(1);
    },
  );

  it('does not reuse a formerly public DNS answer on the next relay request', async () => {
    const resolver = vi
      .fn()
      .mockResolvedValueOnce([{ address: publicAddress, family: 4 }])
      .mockResolvedValueOnce([{ address: '10.0.0.1', family: 4 }]);
    source();
    const handler = createRelayHandler(config(), { resolver });
    expect((await handler(request())).status).toBe(200);
    expect((await handler(request())).status).toBe(422);
    expect(resolver).toHaveBeenCalledTimes(2);
    expect(https.request).toHaveBeenCalledTimes(1);
  });
});

describe('relay bounded HTTPS response', () => {
  const resolver = async () => [{ address: publicAddress, family: 4 }];
  it('rejects an oversized declared Content-Length before reading the body', async () => {
    const { req, res } = source({ headers: { 'content-length': '33' }, chunks: [] });
    expect((await createRelayHandler(config(), { resolver })(request())).status).toBe(413);
    expect(req.destroy).toHaveBeenCalledOnce();
    expect(res.destroy).toHaveBeenCalledOnce();
  });

  it.each([undefined, '1'])(
    'stops an oversized stream with missing or dishonest length (%s)',
    async (length) => {
      const headers: Record<string, string> = length ? { 'content-length': length } : {};
      const { req, res } = source({ headers, chunks: [Buffer.alloc(20), Buffer.alloc(13)] });
      expect((await createRelayHandler(config(), { resolver })(request())).status).toBe(413);
      expect(req.destroy).toHaveBeenCalledOnce();
      expect(res.destroy).toHaveBeenCalledOnce();
    },
  );

  it.each([31, 32])('accepts %s bytes at or below the configured limit', async (bytes) => {
    const { req, res } = source({ chunks: [Buffer.alloc(16), Buffer.alloc(bytes - 16)] });
    const response = await createRelayHandler(config(), { resolver })(request());
    expect(response.status).toBe(200);
    expect((await response.arrayBuffer()).byteLength).toBe(bytes);
    expect(response.headers.get('content-length')).toBe(String(bytes));
    expect(req.destroy).not.toHaveBeenCalled();
    expect(res.destroy).not.toHaveBeenCalled();
  });
});
