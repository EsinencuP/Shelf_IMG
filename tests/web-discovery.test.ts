import { afterEach, describe, expect, it, vi } from 'vitest';
import { serviceEndpoint } from '@/lib/server/discovery-services';
import { serviceJson } from '@/lib/server/discovery-services';
import { searchWebDiscovery, tavilyFreeRemaining } from '@/lib/server/web-discovery';
import { discoverPage } from '@/lib/server/page-discovery';
import type { Candidate } from '@/lib/types';

vi.mock('@/lib/server/discovery-services', async (original) => ({
  ...(await original<typeof import('@/lib/server/discovery-services')>()),
  serviceJson: vi.fn(),
}));
vi.mock('@/lib/server/page-discovery', () => ({ discoverPage: vi.fn() }));

const product = {
  ean: '3017620422003',
  nameRu: 'Nutella 400 г',
  nameRo: '',
  brand: 'Ferrero',
  quantity: '400g',
};
const free = {
  account: {
    current_plan: 'Researcher',
    plan_limit: 1000,
    plan_usage: 100,
    paygo_limit: 0,
    paygo_usage: 0,
  },
  key: { limit: null, usage: 50 },
};
const candidate: Candidate = {
  id: 'x',
  title: 'Nutella 400 g',
  brand: 'Ferrero',
  quantity: '400 g',
  imageUrl: 'https://store.md/front.jpg',
  pageUrl: 'https://store.md/nutella',
  source: 'store.md',
  gtinExact: true,
  gtin: product.ean,
  rights: 'unknown',
  warnings: [],
};
afterEach(() => {
  vi.resetAllMocks();
  vi.unstubAllEnvs();
});

describe('free web discovery', () => {
  it('does not make network calls without configuration', async () => {
    vi.stubEnv('SEARXNG_URL', '');
    vi.stubEnv('TAVILY_API_KEY', '');
    expect(await searchWebDiscovery(product, 4)).toEqual({
      candidates: [],
      diagnostics: [],
      warnings: [],
    });
    expect(serviceJson).not.toHaveBeenCalled();
  });
  it('uses SearXNG first, preserves image provenance and stops after an exact verified card', async () => {
    vi.stubEnv('SEARXNG_URL', 'https://search.shelf.org');
    vi.stubEnv('TAVILY_API_KEY', 'secret');
    vi.mocked(serviceJson).mockResolvedValue({
      results: [
        { title: 'Nutella 400 g', url: candidate.pageUrl, img_src: candidate.imageUrl },
        {
          title: 'Nutella',
          url: 'http://127.0.0.1/private',
          img_src: 'https://store.md/other.jpg',
        },
      ],
    });
    vi.mocked(discoverPage).mockResolvedValue({ candidates: [candidate], rendered: false });
    const result = await searchWebDiscovery(product, 4);
    expect(serviceJson).toHaveBeenCalledTimes(1);
    const url = vi.mocked(serviceJson).mock.calls[0][0];
    expect(url.pathname).toBe('/search');
    expect(url.searchParams.get('q')).toBe(`"${product.ean}"`);
    expect(url.searchParams.get('format')).toBe('json');
    expect(discoverPage).toHaveBeenCalledTimes(1);
    expect(result.candidates).toContainEqual(candidate);
    expect(result.candidates.find((item) => item.source.startsWith('SearXNG'))).toMatchObject({
      gtinExact: false,
      rights: 'unknown',
      pageUrl: candidate.pageUrl,
    });
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({ id: 'tavily', status: 'skipped' }),
    );
  });
  it('falls back to free Tavily on SearXNG failure and ignores images without source-page provenance', async () => {
    vi.stubEnv('SEARXNG_URL', 'https://search.shelf.org');
    vi.stubEnv('TAVILY_API_KEY', 'secret');
    vi.mocked(serviceJson)
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce(free)
      .mockResolvedValueOnce({
        results: [
          { title: candidate.title, url: candidate.pageUrl, images: [{ url: candidate.imageUrl }] },
        ],
        images: [{ url: 'https://unrelated.org/logo.jpg' }],
      });
    vi.mocked(discoverPage).mockResolvedValue({ candidates: [], rendered: false });
    const result = await searchWebDiscovery(product, 6);
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0].imageUrl).toBe(candidate.imageUrl);
    const payload = vi.mocked(serviceJson).mock.calls[2][2];
    expect(payload).toMatchObject({
      search_depth: 'basic',
      auto_parameters: false,
      include_answer: false,
      include_raw_content: false,
      include_images: true,
    });
    expect(result.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'searxng', status: 'unavailable' }),
        expect.objectContaining({ id: 'tavily', status: 'ok', requests: 2 }),
      ]),
    );
  });
  it.each([
    { ...free.account, current_plan: 'Bootstrap' },
    { ...free.account, paygo_limit: 10 },
    { ...free.account, paygo_usage: 1 },
    { ...free.account, paygo_limit: null },
    { ...free.account, plan_usage: undefined },
  ])('refuses search if a free account cannot be proven (%j)', async (account) => {
    vi.stubEnv('SEARXNG_URL', '');
    vi.stubEnv('TAVILY_API_KEY', 'secret');
    vi.mocked(serviceJson).mockResolvedValue({ ...free, account });
    const result = await searchWebDiscovery(product, 4);
    expect(result.candidates).toHaveLength(0);
    expect(serviceJson).toHaveBeenCalledTimes(1);
    expect(result.diagnostics[0].status).toBe('unavailable');
  });
  it('refuses exhausted quota without retry or paid upgrade', async () => {
    vi.stubEnv('SEARXNG_URL', '');
    vi.stubEnv('TAVILY_API_KEY', 'secret');
    vi.mocked(serviceJson).mockResolvedValue({
      ...free,
      account: { ...free.account, plan_usage: 995 },
    });
    const result = await searchWebDiscovery(product, 1);
    expect(serviceJson).toHaveBeenCalledTimes(1);
    expect(result.diagnostics[0].message).toContain('платный переход запрещён');
  });
  it('does not stop early on a conflicting exact-GTIN image', async () => {
    vi.stubEnv('SEARXNG_URL', 'https://search.shelf.org');
    vi.stubEnv('TAVILY_API_KEY', '');
    vi.mocked(serviceJson).mockResolvedValue({
      results: [{ title: candidate.title, url: candidate.pageUrl }],
    });
    vi.mocked(discoverPage).mockResolvedValue({
      candidates: [{ ...candidate, quantity: '200g' }],
      rendered: false,
    });
    await searchWebDiscovery(product, 2);
    expect(serviceJson).toHaveBeenCalledTimes(2);
  });
  it('limits all provider page reads to three distinct URLs', async () => {
    vi.stubEnv('SEARXNG_URL', 'https://search.shelf.org');
    vi.stubEnv('TAVILY_API_KEY', '');
    vi.mocked(serviceJson).mockResolvedValue({
      results: Array.from({ length: 12 }, (_, i) => ({
        url: `https://store.md/${i}`,
        title: 'Nutella 400g',
      })),
    });
    vi.mocked(discoverPage).mockResolvedValue({ candidates: [], rendered: false });
    await searchWebDiscovery(product, 4);
    expect(discoverPage).toHaveBeenCalledTimes(3);
  });
  it('observes per-key quota as well as account quota', () => {
    expect(tavilyFreeRemaining(free)).toBe(895);
    expect(tavilyFreeRemaining({ ...free, key: { limit: 100, usage: 98 } })).toBe(0);
  });
  it('does not reuse a matching search snippet when the product card contradicts the SKU', async () => {
    vi.stubEnv('SEARXNG_URL', 'https://search.shelf.org');
    vi.stubEnv('TAVILY_API_KEY', '');
    vi.mocked(serviceJson).mockResolvedValue({
      results: [{ title: candidate.title, url: candidate.pageUrl, img_src: candidate.imageUrl }],
    });
    vi.mocked(discoverPage).mockResolvedValue({
      candidates: [{ ...candidate, quantity: '200g' }],
      rendered: false,
      conflict: true,
    });
    const result = await searchWebDiscovery(product, 2);
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0].quantity).toBe('200g');
    expect(result.candidates.some((item) => item.source.startsWith('SearXNG'))).toBe(false);
  });
});

describe('configured backend addresses', () => {
  it('permits literal loopback only in development, not a user-provided private backend', () => {
    vi.stubEnv('NODE_ENV', 'development');
    expect(serviceEndpoint('http://127.0.0.1:8080', 'search').href).toBe(
      'http://127.0.0.1:8080/search',
    );
    expect(() => serviceEndpoint('http://192.168.1.2', 'search')).toThrow();
    expect(() => serviceEndpoint('http://localhost:8080', 'search')).toThrow();
    vi.stubEnv('NODE_ENV', 'production');
    expect(() => serviceEndpoint('http://127.0.0.1:8080', 'search')).toThrow();
  });
  it('rejects credentials, query/hash and unsafe public endpoints', () => {
    for (const url of [
      'https://user:pass@search.org',
      'https://search.org?key=secret',
      'https://search.org#hash',
      'https://127.0.0.1',
      'https://search.org:1234',
    ])
      expect(() => serviceEndpoint(url, 'search')).toThrow();
  });
});
