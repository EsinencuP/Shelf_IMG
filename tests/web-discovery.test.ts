import { createHash } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import {
  searchWebDiscovery,
  braveFreeOnlyConfirmed,
  configuredWebProviders,
  tavilyFreeRemaining,
} from '@/lib/server/web-discovery';
import { serviceJson } from '@/lib/server/discovery-services';
import { discoverPage } from '@/lib/server/page-discovery';
import { ApiError } from '@/lib/server/http';
vi.mock('@/lib/server/discovery-services', () => ({ serviceJson: vi.fn() }));
vi.mock('@/lib/server/page-discovery', () => ({ discoverPage: vi.fn() }));
const product = {
  ean: '3017620422003',
  nameRu: 'Nutella 400 г',
  nameRo: '',
  brand: 'Ferrero',
  quantity: '400g',
};
const candidate = {
  id: 'x',
  title: 'Nutella 400 g',
  gtin: product.ean,
  gtinExact: true,
  imageUrl: 'https://shop.md/photo.jpg',
  pageUrl: 'https://shop.md/nutella',
  source: 'shop.md',
  rights: 'unknown' as const,
  warnings: [],
};
const result = {
  title: candidate.title,
  url: candidate.pageUrl,
  thumbnail: { original: candidate.imageUrl },
};
const free = {
  account: {
    current_plan: 'Researcher',
    plan_limit: 1000,
    plan_usage: 10,
    paygo_limit: 0,
    paygo_usage: 0,
  },
  key: { limit: null, usage: 10 },
};
function brave() {
  vi.stubEnv('BRAVE_SEARCH_API_KEY', 'brave-test');
  vi.stubEnv('BRAVE_FREE_ONLY_CONFIRMED', 'true');
  vi.stubEnv('BRAVE_FREE_ONLY_KEY_SHA256', createHash('sha256').update('brave-test').digest('hex'));
}
afterEach(() => {
  vi.resetAllMocks();
  vi.unstubAllEnvs();
});
it('does no HTTP without keys', async () => {
  vi.stubEnv('BRAVE_SEARCH_API_KEY', '');
  vi.stubEnv('TAVILY_API_KEY', '');
  expect(configuredWebProviders()).toEqual([]);
  await searchWebDiscovery(product, 4);
  expect(serviceJson).not.toHaveBeenCalled();
});

it('keeps a later quota failure after an earlier successful web query', async () => {
  brave();
  vi.stubEnv('TAVILY_API_KEY', '');
  vi.stubEnv('BRAVE_MAX_QUERIES', '2');
  vi.mocked(serviceJson)
    .mockResolvedValueOnce({ web: { results: [result] } })
    .mockRejectedValueOnce(new ApiError(429, 'Бесплатная квота исчерпана.'));
  vi.mocked(discoverPage).mockResolvedValue({ candidates: [], rendered: false });
  const response = await searchWebDiscovery(product, 2);
  expect(response.candidates.length).toBeGreaterThan(0);
  expect(response.diagnostics.find((row) => row.id === 'brave')).toMatchObject({
    status: 'quota',
    reason: 'Бесплатная квота исчерпана.',
  });
});

it('reports blocked product pages separately from the search provider', async () => {
  brave();
  vi.stubEnv('TAVILY_API_KEY', '');
  vi.mocked(serviceJson).mockResolvedValue({ web: { results: [result] } });
  vi.mocked(discoverPage).mockResolvedValue({
    candidates: [],
    rendered: false,
    failure: { status: 'blocked', reason: 'Карточка ответила HTTP 403.', httpStatus: 403 },
  });
  const response = await searchWebDiscovery(product, 1);
  expect(response.diagnostics.find((row) => row.id.startsWith('page-'))).toMatchObject({
    status: 'blocked',
    httpStatus: 403,
    reason: 'Карточка ответила HTTP 403.',
  });
});
it('fails closed without zero-paid-spend proof, including key rotation', async () => {
  vi.stubEnv('BRAVE_SEARCH_API_KEY', 'brave-test');
  expect(braveFreeOnlyConfirmed()).toBe(false);
  const r = await searchWebDiscovery(product, 4);
  expect(serviceJson).not.toHaveBeenCalled();
  expect(r.diagnostics[0].status).toBe('disabled');
  brave();
  vi.stubEnv('BRAVE_SEARCH_API_KEY', 'new-key');
  expect(braveFreeOnlyConfirmed()).toBe(false);
});
it('Brave first uses subscription header, stops on exact SKU and skips Tavily', async () => {
  brave();
  vi.stubEnv('TAVILY_API_KEY', 'tvly-test');
  vi.mocked(serviceJson).mockResolvedValue({ web: { results: [result] } });
  vi.mocked(discoverPage).mockResolvedValue({ candidates: [candidate], rendered: false });
  const r = await searchWebDiscovery(product, 4);
  expect(serviceJson).toHaveBeenCalledTimes(1);
  const args = vi.mocked(serviceJson).mock.calls[0];
  expect(args[0].hostname).toBe('api.search.brave.com');
  expect(args[0].searchParams.get('spellcheck')).toBe('false');
  expect(args[5]).toBe('X-Subscription-Token');
  expect(r.diagnostics.find((d) => d.id === 'tavily')?.status).toBe('disabled');
});
it('falls back to Tavily after Brave failure and checks free quota before search', async () => {
  brave();
  vi.stubEnv('TAVILY_API_KEY', 'tvly-test');
  vi.mocked(serviceJson)
    .mockRejectedValueOnce(new Error())
    .mockResolvedValueOnce(free)
    .mockResolvedValueOnce({
      results: [{ ...result, images: [candidate.imageUrl] }],
      images: ['https://shop.md/unrelated.jpg'],
    });
  vi.mocked(discoverPage).mockResolvedValue({ candidates: [], rendered: false });
  const r = await searchWebDiscovery(product, 4);
  expect(vi.mocked(serviceJson).mock.calls[1][0].pathname).toBe('/usage');
  expect(vi.mocked(serviceJson).mock.calls[2][2]).toMatchObject({
    search_depth: 'basic',
    include_answer: false,
    auto_parameters: false,
  });
  expect(r.candidates.some((c) => c.imageUrl.endsWith('unrelated.jpg'))).toBe(false);
});
it('does not send a Tavily key to Brave', async () => {
  vi.stubEnv('BRAVE_SEARCH_API_KEY', 'tvly-wrong');
  await searchWebDiscovery(product, 4);
  expect(serviceJson).not.toHaveBeenCalled();
});
it('bounds queries and reads six relevant pages across both providers', async () => {
  brave();
  vi.stubEnv('BRAVE_MAX_QUERIES', '999');
  vi.mocked(serviceJson).mockResolvedValue({
    web: {
      results: Array.from({ length: 10 }, (_, i) => ({
        ...result,
        url: 'https://shop.md/item' + i,
      })),
    },
  });
  vi.mocked(discoverPage).mockResolvedValue({ candidates: [], rendered: false });
  await searchWebDiscovery({ ...product, nameRo: 'Nutella' }, 6);
  expect(vi.mocked(serviceJson).mock.calls.length).toBeLessThanOrEqual(4);
  expect(discoverPage).toHaveBeenCalledTimes(6);
});
it('valid empty Brave response continues to the descriptive query', async () => {
  brave();
  vi.stubEnv('TAVILY_API_KEY', '');
  vi.mocked(serviceJson)
    .mockResolvedValueOnce({ type: 'search', query: { original: product.ean } })
    .mockResolvedValueOnce({ web: { results: [result] } });
  vi.mocked(discoverPage).mockResolvedValue({ candidates: [candidate], rendered: false });
  const r = await searchWebDiscovery(product, 4);
  expect(serviceJson).toHaveBeenCalledTimes(2);
  expect(r.diagnostics[0].status).toBe('ok');
  expect(r.candidates).toContainEqual(candidate);
});
it('reserve uses a known product name rather than repeating an empty barcode query', async () => {
  brave();
  vi.stubEnv('TAVILY_API_KEY', 'tvly-test');
  vi.mocked(serviceJson).mockImplementation(async (url) =>
    url.hostname === 'api.search.brave.com'
      ? { type: 'search', query: { original: product.ean } }
      : url.pathname === '/usage'
        ? free
        : { results: [] },
  );
  await searchWebDiscovery(product, 4);
  const request = vi
    .mocked(serviceJson)
    .mock.calls.find(
      (args) => args[0].hostname === 'api.tavily.com' && args[0].pathname === '/search',
    );
  expect(request?.[2]).toMatchObject({ query: expect.stringContaining('Nutella') });
});
it('conflicting source pages cannot be rescued by snippet images', async () => {
  brave();
  vi.mocked(serviceJson).mockResolvedValue({ web: { results: [result] } });
  vi.mocked(discoverPage).mockResolvedValue({ candidates: [], conflict: true, rendered: false });
  expect((await searchWebDiscovery(product, 1)).candidates).toHaveLength(0);
});
it('rejects a different Zakaz canonical GTIN before fetching its page or using its thumbnail', async () => {
  brave();
  vi.mocked(serviceJson).mockResolvedValue({
    web: {
      results: [{ ...result, url: 'https://bonus.zakaz.md/ro/products/nutella--04840053000444/' }],
    },
  });
  const found = await searchWebDiscovery(product, 1, 'moldova');
  expect(found.candidates).toHaveLength(0);
  expect(discoverPage).not.toHaveBeenCalled();
});
it('Tavily rejects paid plans and nullable paygo without explicit account confirmation', () => {
  expect(() =>
    tavilyFreeRemaining({ ...free, account: { ...free.account, current_plan: 'paid' } }),
  ).toThrow();
  expect(() =>
    tavilyFreeRemaining({ ...free, account: { ...free.account, paygo_limit: null } }),
  ).toThrow();
});
it('uses top-level Tavily images only when their title ties them to one matching source page', async () => {
  vi.stubEnv('BRAVE_SEARCH_API_KEY', '');
  vi.stubEnv('TAVILY_API_KEY', 'tvly-test');
  vi.mocked(serviceJson)
    .mockResolvedValueOnce(free)
    .mockResolvedValueOnce({
      results: [{ title: candidate.title, url: candidate.pageUrl, images: [] }],
      images: [
        { url: candidate.imageUrl, title: candidate.title },
        { url: 'https://shop.md/wrong.jpg', title: 'Another product' },
      ],
    })
    .mockResolvedValueOnce(free)
    .mockResolvedValueOnce({ results: [] });
  vi.mocked(discoverPage).mockResolvedValue({ candidates: [], rendered: false });
  const found = await searchWebDiscovery(product, 1);
  expect(found.candidates.map((c) => c.imageUrl)).toEqual([candidate.imageUrl]);
  expect(found.candidates[0].gtinExact).toBe(false);
});
it('prioritizes a matching barcode card for cloud extraction and never returns its recommendation photos', async () => {
  vi.stubEnv('BRAVE_SEARCH_API_KEY', '');
  vi.stubEnv('TAVILY_API_KEY', 'tvly-test');
  const primary = 'https://shop.md/primary.jpg';
  vi.mocked(serviceJson)
    .mockResolvedValueOnce(free)
    .mockResolvedValueOnce({
      results: [
        {
          title: candidate.title,
          url: candidate.pageUrl,
          images: [primary, 'https://shop.md/icon.svg', 'https://shop.md/recommendation.jpg'],
        },
      ],
    })
    .mockResolvedValueOnce(free)
    .mockResolvedValueOnce({
      results: [
        {
          url: candidate.pageUrl,
          raw_content:
            '# Nutella 400 g\nEAN: ' +
            product.ean +
            '\n![Nutella 400 g](' +
            primary +
            ')\n## Related products\n![Other item](https://shop.md/recommendation.jpg)',
          images: [primary, 'https://shop.md/recommendation.jpg'],
        },
      ],
    });
  vi.mocked(discoverPage).mockResolvedValue({ candidates: [], rendered: false });
  const found = await searchWebDiscovery(product, 1);
  expect(found.candidates.every((c) => c.imageUrl === primary)).toBe(true);
  expect(found.candidates.some((c) => c.gtinExact)).toBe(true);
  expect(vi.mocked(serviceJson).mock.calls.at(-1)?.[0].pathname).toBe('/extract');
});
it('keeps Moldova recovery queries and all fetched source pages inside the regional scope', async () => {
  vi.stubEnv('BRAVE_SEARCH_API_KEY', '');
  vi.stubEnv('TAVILY_API_KEY', 'tvly-test');
  const mdUrl = 'https://metro.zakaz.md/ro/products/nutella--03017620422003';
  vi.mocked(serviceJson)
    .mockResolvedValueOnce(free)
    .mockResolvedValueOnce({
      results: [
        { ...result, url: 'https://metro.zakaz.ua/nutella' },
        { ...result, url: mdUrl },
      ],
    });
  vi.mocked(discoverPage).mockResolvedValue({
    candidates: [{ ...candidate, pageUrl: mdUrl }],
    rendered: false,
  });
  const found = await searchWebDiscovery(product, 1, 'moldova');
  const request = vi.mocked(serviceJson).mock.calls[1][2] as {
    query: string;
    include_domains: string[];
  };
  expect(request.query).not.toContain('site:');
  expect(request.query).toContain('Moldova');
  expect(request.query.length).toBeLessThanOrEqual(400);
  expect(request.include_domains).toContain('linella.md');
  expect(request).toMatchObject({
    include_domains_mode: 'prefer',
    include_images: false,
  });
  expect(request).not.toHaveProperty('include_image_descriptions');
  expect(request.include_domains.some((domain) => domain.endsWith('.ua'))).toBe(false);
  expect(discoverPage).toHaveBeenCalledOnce();
  expect(discoverPage).toHaveBeenCalledWith(mdUrl, product);
  expect(found.candidates.every((item) => item.pageUrl === mdUrl)).toBe(true);
});
