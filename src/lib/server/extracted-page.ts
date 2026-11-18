import type { Candidate } from '../types';
import { candidateId, obj, safeUrl, str, zakazProductGtin } from './catalog-utils';
import { matchCandidate } from './matching';
import { titleRelevance } from './search-queries';
import { normalizeGtin, type SearchProduct } from './validation';

/** Extracted pages contain recommendation images; never treat the whole list as SKU photos. */
export function extractedPageCandidates(value: unknown, product: SearchProduct): Candidate[] {
  return extractedPageEvidence(value, product).candidates;
}
export function extractedPageEvidence(
  value: unknown,
  product: SearchProduct,
): { candidates: Candidate[]; conflict: boolean } {
  const empty = { candidates: [], conflict: false };
  const item = obj(value),
    pageUrl = safeUrl(item.url);
  if (!pageUrl || typeof item.raw_content !== 'string' || item.raw_content.length > 750000)
    return empty;
  const content = item.raw_content;
  const title = str(content.match(/^#\s+(.+)$/m)?.[1] || item.title);
  if (!title || titleRelevance(product, title) < 0.35) return empty;
  const cutoff = content.search(
    /^#{1,3}\s+(?:produse asem[aă]n[aă]toare|cu acest produs|related|recommended|similar|you may|похожие|рекомендуем|с этим товаром)/im,
  );
  const main = cutoff < 0 ? content : content.slice(0, cutoff);
  const related = cutoff < 0 ? '' : content.slice(cutoff);
  const recommendationImages = new Set(
    [...related.matchAll(/!\[[^\]]*\]\((https:\/\/[^\s)]+)/g)].map((m) => m[1]),
  );
  // A labelled barcode is evidence. Arbitrary numbers elsewhere in a page are not.
  const codes = [
    ...main.matchAll(
      /(?:EAN|GTIN(?:13|14)?|barcode|штрихкод|cod de bare)\s*[:#*-]?\s*(\d{8,14})\b/gi,
    ),
  ]
    .map((m) => m[1])
    .filter((code) => normalizeGtin(code));
  const source = new URL(pageUrl);
  // Zakaz's canonical product route embeds its EAN after '--'; this is source evidence,
  // not a number copied from the user's query or a search snippet.
  const routeGtin = zakazProductGtin(pageUrl);
  if (routeGtin) codes.push(routeGtin);
  const unique = [...new Set(codes.map((code) => normalizeGtin(code)!))];
  if (unique.length > 1) return { candidates: [], conflict: true };
  const gtin = unique.length === 1 ? codes[0] : undefined;
  const gtinExact = !!product.ean && !!gtin && normalizeGtin(product.ean) === normalizeGtin(gtin);
  const identity = matchCandidate(product, {
    id: 'extracted-identity',
    title,
    gtin,
    gtinExact,
    imageUrl: pageUrl,
    pageUrl,
    source: source.hostname,
    rights: 'unknown',
    warnings: [],
  });
  if (identity.rejected) return { candidates: [], conflict: true };
  // Without recommendation boundaries or GTIN evidence, only explicitly captioned
  // main-content images are safe enough to present as unverified candidates.
  const captioned = new Set(
    [...main.matchAll(/!\[([^\]]+)\]\((https:\/\/[^\s)]+)/g)]
      .filter((m) => titleRelevance(product, m[1]) >= 0.35)
      .map((m) => m[2]),
  );
  const images = Array.isArray(item.images) ? item.images : [];
  const candidates = images
    .flatMap((raw): Candidate[] => {
      const imageUrl = safeUrl(typeof raw === 'string' ? raw : obj(raw).url);
      if (
        !imageUrl ||
        recommendationImages.has(imageUrl) ||
        (!gtin && !captioned.has(imageUrl)) ||
        /(?:\.svg(?:\?|$)|logo|icon|banner|favicon|promotion|s150x150)/i.test(imageUrl)
      )
        return [];
      const candidate: Candidate = {
        id: candidateId(imageUrl),
        title,
        imageUrl,
        pageUrl,
        gtin,
        gtinExact,
        source: `Tavily Extract · ${source.hostname}`,
        rights: 'unknown',
        warnings: [
          'Карточка прочитана облачным сервисом. Проверьте соответствие фотографии, упаковку и права использования.',
        ],
      };
      const match = matchCandidate(product, candidate);
      return match.rejected ? [] : [match.candidate];
    })
    .slice(0, 2);
  return { candidates, conflict: false };
}
