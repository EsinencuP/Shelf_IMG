import { afterEach, describe, expect, it, vi } from 'vitest';
import sharp from 'sharp';
import { ApiError, boundedWork, guardRequest, readBody } from '../src/lib/server/http';
import { detectImageType, inspectImage } from '../src/lib/server/image';
import { matchCandidate, parseQuantity } from '../src/lib/server/matching';
import {
  isPublicAddress,
  publicGet,
  resolvePublicUrl,
  validatePublicUrl,
  type Transport,
} from '../src/lib/server/public-fetch';
import { offCandidates, productJsonLdCandidates, searchProducts } from '../src/lib/server/search';
import { normalizeGtin, validateProduct } from '../src/lib/server/validation';
import { validateVisionResult, verifyImage } from '../src/lib/server/vision';
import type { Candidate } from '../src/lib/types';
import { GET as imageGet } from '../src/app/api/image/route';
import { GET as configGet } from '../src/app/api/config/route';
import { GET as sessionGet } from '../src/app/api/session/route';
import { POST as searchPost } from '../src/app/api/search/route';

const product = {
  ean: '3017620422003',
  nameRu: 'Nutella 400 г',
  nameRo: '',
  brand: 'Ferrero',
  quantity: '400g',
};
const candidate: Candidate = {
  id: '1',
  title: 'Nutella 400g',
  brand: 'Ferrero',
  quantity: '400 g',
  gtin: product.ean,
  imageUrl: 'https://images.openfoodfacts.org/front.jpg',
  pageUrl: 'https://world.openfoodfacts.org/product/3017620422003',
  source: 'OFF',
  rights: 'open_license',
  gtinExact: true,
  warnings: [],
};
const postRequest = (body: unknown, origin = 'https://shelf.site') =>
  new Request('https://shelf.site/api/search', {
    method: 'POST',
    headers: { Origin: origin, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('API input and access boundaries', () => {
  it('normalizes equivalent GTINs without accepting bad checksums', () => {
    expect(normalizeGtin(product.ean)).toBe('03017620422003');
    expect(normalizeGtin('03017620422003')).toBe('03017620422003');
    expect(normalizeGtin('3017620422004')).toBeNull();
    expect(normalizeGtin('1e12')).toBeNull();
  });
  it('strips internal and arbitrary fields and caps attributes', () => {
    expect(
      validateProduct({ ...product, sku: 'SECRET', internalCode: 'PRIVATE', candidates: [] }),
    ).toEqual(product);
    expect(() => validateProduct({ ...product, brand: 'a'.repeat(81) })).toThrow(ApiError);
    expect(() => validateProduct({ ean: 3017620422003 })).toThrow(ApiError);
  });
  it('rejects missing/foreign Origin before any provider request', async () => {
    vi.stubEnv('NODE_ENV', 'development');
    vi.stubEnv('MVP_ACCESS_PASSWORD', '');
    const fetcher = vi.fn();
    vi.stubGlobal('fetch', fetcher);
    expect((await searchPost(postRequest(product, 'https://attacker.site'))).status).toBe(403);
    expect(() =>
      guardRequest(new Request('https://shelf.site/api/search', { method: 'POST' })),
    ).toThrow(ApiError);
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('accepts the browser loopback Host when Next canonicalizes request.url to localhost', () => {
    vi.stubEnv('NODE_ENV', 'development');
    vi.stubEnv('MVP_ACCESS_PASSWORD', '');
    vi.stubEnv('VERCEL', '');
    const request = new Request('http://localhost:3000/api/search', {
      method: 'POST',
      headers: { Host: '127.0.0.1:3000', Origin: 'http://127.0.0.1:3000' },
    });
    expect(() => guardRequest(request)).not.toThrow();
    const foreign = new Request(request.url, {
      method: 'POST',
      headers: { Host: '127.0.0.1:3000', Origin: 'http://attacker.site:3000' },
    });
    expect(() => guardRequest(foreign)).toThrow(ApiError);
    const wrongPort = new Request(request.url, {
      method: 'POST',
      headers: { Host: '127.0.0.1:3000', Origin: 'http://127.0.0.1:3001' },
    });
    expect(() => guardRequest(wrongPort)).toThrow(ApiError);
  });
  it('uses Vercel client Host and trusted forwarded HTTPS for an internal HTTP request', () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('VERCEL', '1');
    vi.stubEnv('MVP_ACCESS_PASSWORD', 'correct');
    const headers = {
      Host: 'shelf.example.org',
      Origin: 'https://shelf.example.org',
      'X-Forwarded-Proto': 'https',
      'X-Forwarded-Host': 'attacker.site',
      Authorization: `Basic ${Buffer.from('shelf:correct').toString('base64')}`,
    };
    expect(() =>
      guardRequest(new Request('http://localhost:3000/api/search', { method: 'POST', headers })),
    ).not.toThrow();
    expect(() =>
      guardRequest(
        new Request('http://localhost:3000/api/search', {
          method: 'POST',
          headers: { ...headers, Origin: 'https://attacker.site' },
        }),
      ),
    ).toThrow(ApiError);
  });
  it('ignores spoofed forwarded Host and protocol outside Vercel', () => {
    vi.stubEnv('NODE_ENV', 'development');
    vi.stubEnv('MVP_ACCESS_PASSWORD', '');
    vi.stubEnv('VERCEL', '');
    const request = new Request('http://localhost:3000/api/search', {
      method: 'POST',
      headers: {
        Host: '127.0.0.1:3000',
        Origin: 'https://attacker.site',
        'X-Forwarded-Host': 'attacker.site',
        'X-Forwarded-Proto': 'https',
      },
    });
    expect(() => guardRequest(request)).toThrow(ApiError);
    const spoofedHttps = new Request(request.url, {
      method: 'POST',
      headers: {
        Host: '127.0.0.1:3000',
        Origin: 'https://127.0.0.1:3000',
        'X-Forwarded-Proto': 'https',
      },
    });
    expect(() => guardRequest(spoofedHttps)).toThrow(ApiError);
  });
  it('rejects a rebinding Host on the local development server and malformed authorities', () => {
    vi.stubEnv('NODE_ENV', 'development');
    vi.stubEnv('MVP_ACCESS_PASSWORD', '');
    vi.stubEnv('VERCEL', '');
    expect(() =>
      guardRequest(
        new Request('http://localhost:3000/api/search', {
          method: 'POST',
          headers: { Host: 'attacker.site:3000', Origin: 'http://attacker.site:3000' },
        }),
      ),
    ).toThrow(ApiError);
    expect(() =>
      guardRequest(
        new Request('https://shelf.site/api/search', {
          method: 'POST',
          headers: { Host: 'shelf.site/evil', Origin: 'https://shelf.site' },
        }),
      ),
    ).toThrow(ApiError);
  });
  it('blocks production APIs without password and only exposes boolean config', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('MVP_ACCESS_PASSWORD', '');
    vi.stubEnv('BRAVE_SEARCH_API_KEY', 'SECRET');
    vi.stubEnv('GEMINI_API_KEY', 'SECRET');
    expect((await sessionGet(new Request('https://shelf.site/api/session'))).status).toBe(503);
    expect(await (await configGet()).json()).toEqual({
      braveConfigured: false,
      geminiConfigured: false,
      accessProtected: false,
      serverReady: false,
    });
  });
  it('requires the configured Basic password', async () => {
    vi.stubEnv('MVP_ACCESS_PASSWORD', 'correct');
    expect((await sessionGet(new Request('https://shelf.site/api/session'))).status).toBe(401);
    const request = new Request('https://shelf.site/api/session', {
      headers: { Authorization: `Basic ${Buffer.from('shelf:correct').toString('base64')}` },
    });
    expect((await sessionGet(request)).status).toBe(200);
  });
  it('caps actual streamed request bytes even without content-length', async () => {
    const response = new Response(new Uint8Array(100));
    await expect(readBody(response, 50)).rejects.toMatchObject({ status: 413 });
  });
  it('returns validation errors without contacting providers', async () => {
    vi.stubEnv('NODE_ENV', 'development');
    vi.stubEnv('MVP_ACCESS_PASSWORD', '');
    const fetcher = vi.fn();
    vi.stubGlobal('fetch', fetcher);
    expect((await searchPost(postRequest({ ...product, ean: '3017620422004' }))).status).toBe(422);
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('bounds concurrent expensive work', async () => {
    const releases: (() => void)[] = [];
    const jobs = Array.from({ length: 3 }, () =>
      boundedWork(() => new Promise<void>((resolve) => releases.push(resolve))),
    );
    await expect(boundedWork(async () => undefined)).rejects.toMatchObject({ status: 429 });
    releases.forEach((release) => release());
    await Promise.all(jobs);
  });
});

describe('SSRF protection and images', () => {
  it.each([
    '127.0.0.1',
    '10.0.0.1',
    '169.254.169.254',
    '172.16.2.3',
    '192.168.0.1',
    '100.64.0.1',
    '198.18.0.1',
    '192.0.2.4',
    '224.0.0.1',
    '::1',
    'fe80::1',
    'fc00::1',
    '::ffff:127.0.0.1',
    '2001:db8::1',
    '2002:7f00:1::',
  ])('rejects reserved IP %s', (address) => expect(isPublicAddress(address)).toBe(false));
  it.each([
    'https://2130706433/image.jpg',
    'https://0x7f000001/image.jpg',
    'https://[::1]/image.jpg',
    'https://localhost/image.jpg',
    'https://foo.local/a',
    'http://cdn.site/image.jpg',
    'https://user:pass@cdn.site/a',
    'https://cdn.site:8443/a',
  ])('rejects dangerous URL %s', (url) => expect(() => validatePublicUrl(url)).toThrow(ApiError));
  it('permits actual public unicast addresses', () => {
    expect(isPublicAddress('8.8.8.8')).toBe(true);
    expect(isPublicAddress('2606:4700:4700::1111')).toBe(true);
  });
  it('rejects a hostname if any DNS answer is private', async () => {
    await expect(
      resolvePublicUrl('https://cdn.site/a', async () => [
        { address: '8.8.8.8', family: 4 },
        { address: '127.0.0.1', family: 4 },
      ]),
    ).rejects.toMatchObject({ status: 422 });
  });
  it('passes the validated address to transport and checks redirected URLs again', async () => {
    const resolver = vi.fn(async () => [{ address: '8.8.8.8', family: 4 }]);
    const transport: Transport = vi.fn(async (_url, address) => {
      expect(address).toEqual({ address: '8.8.8.8', family: 4 });
      return {
        status: 302,
        headers: { location: 'https://169.254.169.254/secrets' },
        body: Buffer.alloc(0),
        url: '',
      };
    });
    await expect(
      publicGet('https://cdn.site/image.jpg', {}, { resolver, transport }),
    ).rejects.toMatchObject({ status: 422 });
    expect(transport).toHaveBeenCalledTimes(1);
  });
  it('checks DNS on each public redirect', async () => {
    const resolver = vi
      .fn()
      .mockResolvedValueOnce([{ address: '8.8.8.8', family: 4 }])
      .mockResolvedValueOnce([{ address: '10.0.0.1', family: 4 }]);
    const transport: Transport = vi.fn(async () => ({
      status: 302,
      headers: { location: 'https://second.site/a' },
      body: Buffer.alloc(0),
      url: '',
    }));
    await expect(
      publicGet('https://first.site/a', {}, { resolver, transport }),
    ).rejects.toMatchObject({ status: 422 });
    expect(resolver).toHaveBeenCalledTimes(2);
    expect(transport).toHaveBeenCalledTimes(1);
  });
  it('rejects an SVG disguised with a JPEG filename', async () => {
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>');
    expect(detectImageType(svg)).toBeNull();
    await expect(inspectImage(svg)).rejects.toMatchObject({ status: 415 });
  });
  it('validates decodable raster metadata and rejects truncated magic-only files', async () => {
    const png = await sharp({ create: { width: 10, height: 20, channels: 3, background: '#fff' } })
      .png()
      .toBuffer();
    expect(await inspectImage(png)).toEqual({ mime: 'image/png', width: 10, height: 20 });
    await expect(inspectImage(Buffer.from([0xff, 0xd8, 0xff]))).rejects.toMatchObject({
      status: 422,
    });
  });
  it('rejects private proxy URLs at route boundary', async () => {
    vi.stubEnv('NODE_ENV', 'development');
    vi.stubEnv('MVP_ACCESS_PASSWORD', '');
    expect(
      (
        await imageGet(
          new Request('https://shelf.site/api/image?url=https%3A%2F%2F127.0.0.1%2Fimage.jpg'),
        )
      ).status,
    ).toBe(422);
  });
});

describe('matching and source evidence', () => {
  it('normalizes units while retaining pack count', () => {
    expect(parseQuantity('0,5 l')).toEqual(parseQuantity('500 ml'));
    expect(parseQuantity('6 x 330 ml')).toEqual(parseQuantity('330 ml x 6'));
    expect(
      matchCandidate({ ...product, quantity: '6x330ml' }, { ...candidate, quantity: '1980ml' })
        .rejected,
    ).toBe(true);
  });
  it('rejects explicit brand and quantity conflicts even with exact GTIN', () => {
    expect(matchCandidate(product, { ...candidate, brand: 'Other' }).rejected).toBe(true);
    expect(matchCandidate(product, { ...candidate, quantity: '750 g' }).rejected).toBe(true);
    expect(matchCandidate(product, candidate).rejected).toBe(false);
  });
  it('does not equate barcode query text with exact image evidence', () => {
    expect(
      matchCandidate(product, { ...candidate, gtin: undefined, gtinExact: false }).candidate
        .gtinExact,
    ).toBe(false);
  });
  it('uses only exact Product JSON-LD associations, not nearby recommendation data', () => {
    const html = `<script type="application/ld+json">${JSON.stringify({ '@type': 'Product', gtin13: product.ean, name: 'Nutella', brand: { name: 'Ferrero' }, image: '/front.jpg', relatedProducts: { '@type': 'Product', gtin13: product.ean, image: '/wrong.jpg' } })}</script>`;
    const results = productJsonLdCandidates(html, 'https://shop.site/item', product);
    expect(results).toHaveLength(1);
    expect(results[0].imageUrl).toBe('https://shop.site/front.jpg');
    expect(results[0].gtinExact).toBe(true);
    expect(
      productJsonLdCandidates(
        html.replace(product.ean, '4005808890570'),
        'https://shop.site/item',
        product,
      ),
    ).toHaveLength(0);
  });
  it('preserves OFF front selection and original photo author', () => {
    const results = offCandidates(
      {
        product: {
          code: product.ean,
          product_name: 'Nutella',
          brands: 'Ferrero',
          quantity: '400g',
          selected_images: {
            front: {
              display: {
                ro: 'https://images.openfoodfacts.org/images/products/301/762/042/2003/front_ro.7.400.jpg',
              },
            },
          },
          images: { front_ro: { imgid: '5', rev: '7' }, '5': { uploader: 'photo-author' } },
        },
      },
      product,
    );
    expect(results).toHaveLength(1);
    expect(results[0].imageUrl).toContain('.full.jpg');
    expect(results[0].license).toContain('photo-author');
    expect(results[0].source).toContain('Open Food Facts');
  });
  it('performs a real provider-shaped exact lookup and reports unavailable web provider', async () => {
    vi.stubEnv('BRAVE_SEARCH_API_KEY', '');
    const fetcher = vi.fn(async (_url: string, _init?: RequestInit) =>
      Response.json({
        status: 1,
        product: {
          code: product.ean,
          product_name: 'Nutella',
          brands: 'Ferrero',
          quantity: '400g',
          image_front_url: 'https://images.openfoodfacts.org/front.jpg',
        },
      }),
    );
    vi.stubGlobal('fetch', fetcher);
    const result = await searchProducts(product);
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0].gtinExact).toBe(true);
    expect(fetcher.mock.calls[0]?.[0]).toContain(`/product/${product.ean}.json`);
    expect(result.warnings.join(' ')).toContain('BRAVE_SEARCH_API_KEY');
  });
  it('reports a provider outage as an error instead of a false not-found result', async () => {
    vi.stubEnv('BRAVE_SEARCH_API_KEY', '');
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('', { status: 503 })),
    );
    await expect(searchProducts(product)).rejects.toMatchObject({ status: 502 });
  });
  it('keeps image candidates when the independent web endpoint fails and makes only two calls', async () => {
    vi.stubEnv('BRAVE_SEARCH_API_KEY', 'server-only-key');
    const fetcher = vi.fn(async (url: string) =>
      url.includes('/images/search')
        ? Response.json({
            results: [
              {
                title: 'Bottle 500ml',
                url: 'https://shop.site/item',
                properties: { url: 'https://cdn.site/front.jpg' },
              },
            ],
          })
        : new Response('', { status: 429 }),
    );
    vi.stubGlobal('fetch', fetcher);
    const result = await searchProducts({
      ean: '',
      nameRu: '',
      nameRo: 'Bottle',
      brand: '',
      quantity: '500ml',
    });
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0].gtinExact).toBe(false);
    expect(result.warnings.join(' ')).toContain('Brave Web');
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
});

describe('vision result constraints', () => {
  it('downgrades model consistency when required observed details are missing', () => {
    const result = validateVisionResult(
      { verdict: 'consistent', brand: '', quantity: '', variant: '', reasons: [] },
      product,
    );
    expect(result.verdict).toBe('uncertain');
    expect(result.reasons.join(' ')).toContain('не заменяет');
  });
  it('overrides model consistency on deterministic conflicts', () => {
    expect(
      validateVisionResult(
        {
          verdict: 'consistent',
          brand: 'Other',
          quantity: '400g',
          variant: 'Nutella',
          reasons: [],
        },
        product,
      ).verdict,
    ).toBe('conflict');
  });
  it('fails closed on invalid provider output', () => {
    expect(() =>
      validateVisionResult(
        { verdict: 'approved', brand: '', quantity: '', variant: '', reasons: [] },
        product,
      ),
    ).toThrow(ApiError);
  });
  it('uses one supported vision model and sends no internal SKU', async () => {
    vi.stubEnv('GEMINI_API_KEY', 'server-key');
    vi.stubEnv('GEMINI_MODEL', 'gemini-3.1-flash-lite');
    const png = await sharp({ create: { width: 10, height: 20, channels: 3, background: '#fff' } })
      .png()
      .toBuffer();
    const fetcher = vi.fn(async (_url: string, _init?: RequestInit) =>
      Response.json({
        candidates: [
          {
            finishReason: 'STOP',
            content: {
              parts: [
                {
                  text: JSON.stringify({
                    verdict: 'consistent',
                    brand: 'Ferrero',
                    quantity: '400g',
                    variant: 'Nutella',
                    reasons: ['видимые признаки совпадают'],
                  }),
                },
              ],
            },
          },
        ],
      }),
    );
    vi.stubGlobal('fetch', fetcher);
    const input = validateProduct({ ...product, sku: 'DO-NOT-SEND' });
    expect((await verifyImage(input, png)).verdict).toBe('consistent');
    const [url, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toContain('gemini-3.1-flash-lite');
    expect(String(init.body)).not.toContain('DO-NOT-SEND');
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
