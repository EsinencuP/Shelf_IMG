import type { Candidate } from '../types';
import { catalogProducts } from './catalog-utils';
import { publicGet } from './public-fetch';
import { normalizeGtin, type SearchProduct } from './validation';
import { matchCandidate } from './matching';
import { load } from 'cheerio/slim';
import { candidateId, safeUrl } from './catalog-utils';
import { titleRelevance } from './search-queries';
import { zakazPageEvidence } from './zakaz-page';
import { paced } from './catalog-utils';
import { sourceFailure } from './source-policy';
import { sourceFailureDetails } from '../source-status';

function pageEvidence(html: string, url: string, product: SearchProduct) {
  const hydrated = zakazPageEvidence(html, url, product);
  if (hydrated.conflict || hydrated.candidates.length) return hydrated;
  // Preserve contradictions as well as matches; a search snippet must not conceal a wrong GTIN.
  const expected = product.ean ? normalizeGtin(product.ean) : null;
  const candidates = catalogProducts(html, url, { ...product, ean: '' }, true).map((candidate) => {
    const gtinExact = !!expected && !!candidate.gtin && normalizeGtin(candidate.gtin) === expected;
    return {
      ...candidate,
      gtinExact,
      warnings: candidate.warnings.map((warning) =>
        gtinExact && warning === 'В карточке нет подтверждённого EAN: проверьте вариант упаковки.'
          ? 'GTIN связан с фотографией в карточке источника.'
          : warning,
      ),
    };
  });
  const conflict =
    candidates.length > 0 &&
    candidates.every((candidate) => matchCandidate(product, candidate).rejected);
  if (!candidates.length && !conflict) {
    const $ = load(html);
    const title =
      $('h1').first().text().trim() ||
      $('meta[property="og:title"]').attr('content') ||
      $('title').text().trim();
    const gtinValue = $('[itemprop="gtin13"],[itemprop="gtin"],[itemprop="gtin14"]').first();
    const gtin = gtinValue.attr('content') || gtinValue.text().trim();
    const imageUrl = safeUrl(
      $('meta[property="og:image"]').attr('content') || $('[itemprop="image"]').first().attr('src'),
      url,
    );
    const gtinExact = !!expected && normalizeGtin(gtin) === expected;
    if (imageUrl && title && (gtinExact || titleRelevance(product, title) >= 0.35)) {
      candidates.push({
        id: candidateId(imageUrl),
        title,
        imageUrl,
        pageUrl: url,
        source: new URL(url).hostname,
        rights: 'unknown',
        gtin: normalizeGtin(gtin) ? gtin : undefined,
        gtinExact,
        warnings: ['Фото из метаданных карточки; проверьте упаковку и права использования.'],
      });
    }
  }
  return {
    candidates,
    conflict:
      candidates.length > 0 &&
      candidates.every((candidate) => matchCandidate(product, candidate).rejected),
  };
}

export async function discoverPage(
  url: string,
  product: SearchProduct,
): Promise<{
  candidates: Candidate[];
  rendered: boolean;
  conflict?: boolean;
  failure?: ReturnType<typeof sourceFailureDetails>;
}> {
  if (/\/(?:categories|category|tags|search|reviews)\//i.test(new URL(url).pathname))
    return { candidates: [], rendered: false };
  let failure: ReturnType<typeof sourceFailureDetails> | undefined;
  const page = await paced(new URL(url).hostname, 700, async () => {
    const response = await publicGet(url, {
      maxBytes: 750_000,
      timeoutMs: 8_000,
      accept: 'text/html',
    });
    if ([403, 406, 429, 503].includes(response.status))
      throw await sourceFailure(url, response, `Карточка ответила HTTP ${response.status}.`);
    return response;
  }).catch((error) => {
    failure = sourceFailureDetails(error);
    return undefined;
  });
  // Do not turn an upstream ban or robots denial into a browser retry.
  if (!page) return { candidates: [], rendered: false, failure };
  if (page.status === 404) return { candidates: [], rendered: false };
  if (page.status !== 200)
    return {
      candidates: [],
      rendered: false,
      failure: sourceFailureDetails({
        status: page.status,
        message: `Карточка ответила HTTP ${page.status}.`,
      }),
    };
  if (!page.headers['content-type']?.includes('text/html'))
    return {
      candidates: [],
      rendered: false,
      failure: {
        status: 'parse_error',
        reason: 'Карточка вернула неверный формат HTML.',
        httpStatus: 200,
      },
    };
  const evidence = pageEvidence(page.body.toString('utf8'), page.url, product);
  return {
    ...evidence,
    candidates: evidence.candidates.filter(
      (candidate) => candidate.gtinExact || titleRelevance(product, candidate.title) >= 0.5,
    ),
    rendered: false,
  };
}
