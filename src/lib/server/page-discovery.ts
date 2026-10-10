import type { Candidate } from '../types';
import { catalogProducts, obj, str } from './catalog-utils';
import { publicGet, resolvePublicUrl } from './public-fetch';
import { serviceEndpoint, serviceJson } from './discovery-services';
import { normalizeGtin, type SearchProduct } from './validation';
import { matchCandidate } from './matching';

function pageEvidence(html: string, url: string, product: SearchProduct) {
  // Preserve contradictions as well as matches; a search snippet must not conceal a wrong GTIN.
  const expected = product.ean ? normalizeGtin(product.ean) : null;
  const candidates = catalogProducts(html, url, { ...product, ean: '' }, true).map((candidate) => ({
    ...candidate,
    gtinExact: !!expected && !!candidate.gtin && normalizeGtin(candidate.gtin) === expected,
  }));
  return {
    candidates,
    conflict:
      candidates.length > 0 &&
      candidates.every((candidate) => matchCandidate(product, candidate).rejected),
  };
}

export function crawlerConfigured(): boolean {
  return (
    !!process.env.CRAWL4AI_URL &&
    !!process.env.CRAWL4AI_API_TOKEN &&
    !!process.env.CRAWL4AI_ALLOWED_HOSTS
  );
}

export function crawlerAllows(url: string): boolean {
  const host = new URL(url).hostname.toLowerCase();
  return (process.env.CRAWL4AI_ALLOWED_HOSTS || '')
    .split(',')
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean)
    .includes(host);
}

/** One rendered page per SKU. No crawling, LLM extraction, JS snippets or anti-bot bypass. */
export async function discoverPage(
  url: string,
  product: SearchProduct,
  budget: { rendered: number },
): Promise<{ candidates: Candidate[]; rendered: boolean; conflict?: boolean }> {
  const page = await publicGet(url, { maxBytes: 750_000, timeoutMs: 8_000, accept: 'text/html' });
  // Do not turn an upstream ban or robots denial into a browser retry.
  if (page.status !== 200 || !page.headers['content-type']?.includes('text/html'))
    return { candidates: [], rendered: false };
  const evidence = pageEvidence(page.body.toString('utf8'), page.url, product);
  const { candidates } = evidence;
  if (candidates.length || budget.rendered >= 1 || !crawlerConfigured() || !crawlerAllows(page.url))
    return { ...evidence, rendered: false };
  await resolvePublicUrl(page.url);
  budget.rendered++;
  const data = await serviceJson(
    serviceEndpoint(process.env.CRAWL4AI_URL!, 'crawl'),
    process.env.CRAWL4AI_API_TOKEN,
    {
      urls: [page.url],
      browser_config: {
        type: 'BrowserConfig',
        params: { headless: true, ignore_https_errors: false },
      },
      crawler_config: {
        type: 'CrawlerRunConfig',
        params: {
          cache_mode: 'bypass',
          page_timeout: 12_000,
          check_robots_txt: true,
          stream: false,
          screenshot: false,
          pdf: false,
        },
      },
    },
    20_000,
    2_000_000,
  );
  const result = obj(Array.isArray(data.results) ? data.results[0] : undefined);
  // Refuse unrelated, redirected or failed output; Markdown is not product evidence.
  if (
    result.success !== true ||
    str(result.url) !== page.url ||
    (result.redirected_url && result.redirected_url !== page.url) ||
    typeof result.html !== 'string'
  )
    return { candidates: [], rendered: true };
  return { ...pageEvidence(result.html, page.url, product), rendered: true };
}
