import { afterEach, describe, expect, it, vi } from 'vitest';
import { discoverPage } from '@/lib/server/page-discovery';
import { publicGet, resolvePublicUrl } from '@/lib/server/public-fetch';
import { serviceJson } from '@/lib/server/discovery-services';

vi.mock('@/lib/server/public-fetch', async (original) => ({
  ...(await original<typeof import('@/lib/server/public-fetch')>()),
  publicGet: vi.fn(),
  resolvePublicUrl: vi.fn(),
}));
vi.mock('@/lib/server/discovery-services', async (original) => ({
  ...(await original<typeof import('@/lib/server/discovery-services')>()),
  serviceJson: vi.fn(),
}));
const product = {
  ean: '3017620422003',
  nameRu: 'Nutella 400 г',
  nameRo: '',
  brand: 'Ferrero',
  quantity: '400g',
};
const url = 'https://shop.md/nutella';
const html =
  '<script type="application/ld+json">{"@type":"Product","name":"Nutella 400 g","brand":"Ferrero","gtin13":"3017620422003","image":"/front.jpg"}</script>';
function setup(status = 200, content = '<div id="app"></div>') {
  vi.stubEnv('CRAWL4AI_URL', 'https://crawler.shelf.org');
  vi.stubEnv('CRAWL4AI_API_TOKEN', 'secret');
  vi.stubEnv('CRAWL4AI_ALLOWED_HOSTS', 'shop.md');
  vi.mocked(publicGet).mockResolvedValue({
    status,
    url,
    body: Buffer.from(content),
    headers: { 'content-type': 'text/html' },
  });
  vi.mocked(serviceJson).mockResolvedValue({ results: [{ success: true, url, html }] });
}
afterEach(() => {
  vi.resetAllMocks();
  vi.unstubAllEnvs();
});
describe('Crawl4AI bounded extraction', () => {
  it('extracts Product JSON-LD from rendered HTML, not arbitrary images or markdown', async () => {
    setup();
    const budget = { rendered: 0 };
    const result = await discoverPage(url, product, budget);
    expect(result.candidates[0]).toMatchObject({
      gtinExact: true,
      imageUrl: 'https://shop.md/front.jpg',
    });
    expect(budget.rendered).toBe(1);
    expect(resolvePublicUrl).toHaveBeenCalledWith(url);
    expect(vi.mocked(serviceJson).mock.calls[0][2]).toMatchObject({
      urls: [url],
      crawler_config: { params: { check_robots_txt: true, screenshot: false, pdf: false } },
    });
  });
  it('skips Chromium when plain HTML already contains the product', async () => {
    setup(200, html);
    expect((await discoverPage(url, product, { rendered: 0 })).candidates).toHaveLength(1);
    expect(serviceJson).not.toHaveBeenCalled();
  });
  it.each([403, 429, 500])(
    'does not retry a blocked/unavailable source through a browser (%s)',
    async (status) => {
      setup(status);
      expect((await discoverPage(url, product, { rendered: 0 })).candidates).toHaveLength(0);
      expect(serviceJson).not.toHaveBeenCalled();
    },
  );
  it('requires an exact allowlisted hostname and one-page budget', async () => {
    setup();
    vi.stubEnv('CRAWL4AI_ALLOWED_HOSTS', 'other.md');
    await discoverPage(url, product, { rendered: 0 });
    expect(serviceJson).not.toHaveBeenCalled();
    vi.stubEnv('CRAWL4AI_ALLOWED_HOSTS', 'shop.md');
    await discoverPage(url, product, { rendered: 1 });
    expect(serviceJson).not.toHaveBeenCalled();
  });
  it('does not delegate DNS rejected by the public-address guard', async () => {
    setup();
    vi.mocked(resolvePublicUrl).mockRejectedValue(new Error('private DNS'));
    await expect(discoverPage(url, product, { rendered: 0 })).rejects.toThrow();
    expect(serviceJson).not.toHaveBeenCalled();
  });
  it('rejects redirected or unrelated result provenance', async () => {
    setup();
    vi.mocked(serviceJson).mockResolvedValue({
      results: [{ success: true, url, redirected_url: 'https://other.md', html }],
    });
    expect((await discoverPage(url, product, { rendered: 0 })).candidates).toHaveLength(0);
  });
  it('rejects another variant even if it is returned by the crawler', async () => {
    setup();
    vi.mocked(serviceJson).mockResolvedValue({
      results: [{ success: true, url, html: html.replace('3017620422003', '4840053004404') }],
    });
    const result = await discoverPage(url, product, { rendered: 0 });
    expect(result.conflict).toBe(true);
    expect(result.candidates[0].gtin).toBe('4840053004404');
  });
});
