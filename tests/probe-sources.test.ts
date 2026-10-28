import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { probeSources, REFERENCE_EANS, runProbe } from '../scripts/probe-sources';
import { normalizeGtin } from '../src/lib/server/validation';

const sleep = vi.fn(async (_ms: number) => {});
const empty = (url: string) => {
  if (url.includes('zakaz')) return Response.json({ results: [] });
  if (url.includes('upcitemdb')) return Response.json({ items: [] });
  if (url.includes('facts.org')) return Response.json({ status: 0 });
  return new Response('<html></html>');
};
afterEach(() => vi.restoreAllMocks());

describe('source probe', () => {
  it('probes every catalog with all three valid EANs and records missing configuration', async () => {
    const fetcher = vi.fn(async (url: string | URL | Request) => empty(String(url)));
    const report = await probeSources({ env: {}, fetch: fetcher, sleep });
    expect(REFERENCE_EANS.every((ean) => normalizeGtin(ean))).toBe(true);
    expect(report.results).toHaveLength(31);
    expect(report.elapsedMs).toBeGreaterThanOrEqual(0);
    expect(fetcher).toHaveBeenCalledTimes(27);
    for (const row of report.results.filter(
      (row) => !['SearXNG', 'Tavily /usage'].includes(row.source),
    )) {
      expect(row).toMatchObject({ httpStatus: 200, status: 'empty', imageCount: 0 });
      expect(row.elapsedMs).toBeGreaterThanOrEqual(0);
    }
    expect(report.results.filter((row) => row.status === 'disabled')).toHaveLength(4);
    expect(sleep.mock.calls.some(([ms]) => ms > 9000)).toBe(true);
  });

  it('continues after HTTP failures, timeouts, broken JSON and network failures', async () => {
    const report = await probeSources({
      env: {},
      sleep,
      fetch: vi.fn(async (url) => {
        const value = String(url);
        if (value.includes('zakaz')) return new Response('denied', { status: 403 });
        if (value.includes('linella'))
          throw new DOMException('secret upstream detail', 'TimeoutError');
        if (value.includes('bucuria')) throw new Error('secret connection string');
        if (value.includes('upcitemdb')) return new Response('{broken');
        return empty(value);
      }),
    });
    expect(report.results.find((row) => row.source === 'METRO Moldova')).toMatchObject({
      httpStatus: 403,
      status: 'blocked',
      imageCount: null,
    });
    expect(report.results.find((row) => row.source === 'Linella')?.status).toBe('timeout');
    expect(report.results.find((row) => row.source === 'Bucuria')?.status).toBe('blocked');
    expect(report.results.find((row) => row.source === 'UPCitemdb')).toMatchObject({
      httpStatus: 200,
      status: 'parse_error',
    });
    expect(JSON.stringify(report)).not.toContain('secret');
  });

  it('counts unique product images using existing parsers and keeps EAN matching strict', async () => {
    const report = await probeSources({
      env: {},
      sleep,
      fetch: vi.fn(async (url) => {
        const value = String(url);
        if (value.includes('upcitemdb'))
          return Response.json({
            items: [
              {
                ean: REFERENCE_EANS[0],
                images: ['https://example.com/a.jpg', 'https://example.com/a.jpg'],
              },
              { ean: '4006381333931', images: ['https://example.com/wrong.jpg'] },
            ],
          });
        if (value.includes('openfoodfacts.org'))
          return Response.json({
            product: {
              code: REFERENCE_EANS[0],
              image_front_url: 'https://images.openfoodfacts.org/front.jpg',
            },
          });
        if (value.includes('linella'))
          return new Response(
            '<html><div class="ut2-gl__item"><img src="/images/product.jpg"><a class="product-title" href="/product/">Product</a></div><img src="/logo.png"></html>',
          );
        return empty(value);
      }),
    });
    for (const source of ['UPCitemdb', 'Open Food Facts']) {
      expect(
        report.results.filter((row) => row.source === source).map((row) => row.imageCount),
      ).toEqual([1, 0, 0]);
    }
    expect(report.results.find((row) => row.source === 'Linella')?.imageCount).toBe(1);
  });

  it('uses SearXNG images and only one authenticated Tavily usage request without paid search', async () => {
    const fetcher = vi.fn(async (url: string | URL | Request) => {
      if (String(url).includes('/usage'))
        return Response.json({
          account: { current_plan: 'Free', plan_usage: 10, plan_limit: 1000 },
          key: { usage: 3, limit: null },
          token: 'never-save-me',
        });
      if (String(url).includes('localhost'))
        return Response.json({
          results: [
            { img_src: 'https://example.com/a.jpg' },
            { img_src: 'https://example.com/a.jpg' },
            { img_src: 'javascript:alert(1)' },
          ],
        });
      return empty(String(url));
    });
    const report = await probeSources({
      env: {
        SEARXNG_URL: 'http://localhost:8080/base',
        SEARXNG_API_TOKEN: 'searx-secret',
        TAVILY_API_KEY: 'tavily-secret',
      },
      fetch: fetcher,
      sleep,
    });
    expect(
      report.results.filter((row) => row.source === 'SearXNG').map((row) => row.imageCount),
    ).toEqual([1, 1, 1]);
    const tavilyCalls = fetcher.mock.calls.filter(([url]) => String(url).includes('tavily.com'));
    expect(tavilyCalls).toHaveLength(1);
    expect(String(tavilyCalls[0][0])).toBe('https://api.tavily.com/usage');
    const calls = fetcher.mock.calls as unknown as [string, RequestInit][];
    expect(calls.find(([url]) => url.includes('tavily.com'))?.[1]).toMatchObject({
      headers: { Authorization: 'Bearer tavily-secret' },
      redirect: 'error',
    });
    expect(new URL(calls.find(([url]) => url.includes('localhost'))![0]).pathname).toBe(
      '/base/search',
    );
    expect(report.results.at(-1)).toMatchObject({
      ean: null,
      imageCount: null,
      status: 'ok',
      usage: { plan_usage: 10, key_limit: null },
    });
    expect(JSON.stringify(report)).not.toMatch(/secret|never-save-me/);
  });

  it('records 429 and malformed usage independently from successful catalogs', async () => {
    const report = await probeSources({
      env: { TAVILY_API_KEY: 'key', SEARXNG_URL: 'https://search.example.com' },
      sleep,
      fetch: vi.fn(async (url) => {
        if (String(url).includes('search.example.com')) return new Response('', { status: 429 });
        if (String(url).includes('tavily')) return Response.json({});
        return empty(String(url));
      }),
    });
    expect(report.results.find((row) => row.source === 'SearXNG')).toMatchObject({
      httpStatus: 429,
      status: 'quota',
    });
    expect(report.results.at(-1)).toMatchObject({ httpStatus: 200, status: 'parse_error' });
  });

  it('follows Bucuria product links and counts package images, excluding logos', async () => {
    const report = await probeSources({
      env: {},
      sleep,
      fetch: vi.fn(async (url) => {
        if (String(url).includes('bucuria.md/ru/search'))
          return new Response(
            '<html><a class="product-title" href="/ru/product/do-re-mi">Do-Re-Mi</a></html>',
          );
        if (String(url).includes('/ru/product/'))
          return new Response(
            '<html><div class="product-content-desc"><h1 class="product-title">Do-Re-Mi</h1></div><div class="product-image-block"><img class="product-image" src="/photo.jpg"></div><img src="/logo.png"></html>',
          );
        return empty(String(url));
      }),
    });
    expect(
      report.results.filter((row) => row.source === 'Bucuria').map((row) => row.imageCount),
    ).toEqual([1, 1, 1]);
  });

  it('preserves search HTTP status when a Bucuria product page fails', async () => {
    const report = await probeSources({
      env: {},
      sleep,
      fetch: vi.fn(async (url) => {
        if (String(url).includes('bucuria.md/ru/search'))
          return new Response(
            '<html><a class="product-title" href="/ru/product/test">Test</a></html>',
          );
        if (String(url).includes('/ru/product/')) return new Response('', { status: 403 });
        return empty(String(url));
      }),
    });
    expect(report.results.find((row) => row.source === 'Bucuria')).toMatchObject({
      httpStatus: 200,
      status: 'blocked',
      imageCount: null,
      message: 'Карточка Bucuria: HTTP 403',
    });
  });

  it('rejects oversized bodies while retaining the received HTTP status', async () => {
    const report = await probeSources({
      env: {},
      sleep,
      fetch: vi.fn(async (url) => {
        if (String(url).includes('linella'))
          return new Response('too large', { headers: { 'content-length': '2000001' } });
        return empty(String(url));
      }),
    });
    expect(report.results.find((row) => row.source === 'Linella')).toMatchObject({
      httpStatus: 200,
      status: 'parse_error',
      imageCount: null,
    });
  });

  it('enforces a real timeout without hanging the report', async () => {
    const report = await probeSources({
      env: {},
      sleep,
      timeoutMs: 5,
      fetch: vi.fn(async (url, init) => {
        if (!String(url).includes('linella')) return empty(String(url));
        return new Promise<Response>((_resolve, reject) => {
          init!.signal!.addEventListener('abort', () => reject(init!.signal!.reason), {
            once: true,
          });
        });
      }),
    });
    expect(
      report.results
        .filter((row) => row.source === 'Linella')
        .every((row) => row.status === 'timeout'),
    ).toBe(true);
  });

  it('prints a table and writes the same JSON report to disk', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'shelf-probe-'));
    const table = vi.spyOn(console, 'table').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const report = await runProbe(
        { env: {}, sleep, fetch: vi.fn(async (url) => empty(String(url))) },
        join(dir, 'probe-report.json'),
      );
      expect(table).toHaveBeenCalledOnce();
      expect(JSON.parse(await readFile(join(dir, 'probe-report.json'), 'utf8'))).toEqual(report);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
