import { load } from 'cheerio/slim';
import type { Candidate } from '../types';
import { obj, safeUrl, str, zakazProductGtin } from './catalog-utils';
import { ZAKAZ_STORES, zakazCandidates } from './regional-search';
import { normalizeGtin, type SearchProduct } from './validation';
import { matchCandidate } from './matching';

/** Read only the main product hydration record, never recommendation/search arrays. */
export function zakazPageEvidence(
  html: string,
  pageUrl: string,
  product: SearchProduct,
): { candidates: Candidate[]; conflict: boolean } {
  const empty = { candidates: [], conflict: false };
  const routeGtin = zakazProductGtin(pageUrl);
  const store = ZAKAZ_STORES.find((entry) => entry.site === new URL(pageUrl).hostname);
  if (!store || !routeGtin || html.length > 750000) return empty;
  const payload = load(html)('script#__NEXT_DATA__[type="application/json"]').first().text();
  if (!payload || payload.length > 750000) return empty;
  let root: Record<string, unknown>;
  try {
    root = obj(JSON.parse(payload));
  } catch {
    return empty;
  }
  const state = obj(obj(root.props).initialState);
  const item = obj(obj(obj(state.product).productData).product);
  if (!Object.keys(item).length) return empty;
  const gtin = normalizeGtin(str(item.ean));
  const canonical = safeUrl(item.web_url);
  const route = new URL(pageUrl);
  if (
    !gtin ||
    !canonical ||
    gtin !== normalizeGtin(routeGtin) ||
    new URL(canonical).origin !== route.origin ||
    new URL(canonical).pathname.replace(/\/$/, '') !== route.pathname.replace(/\/$/, '')
  )
    return { candidates: [], conflict: true };
  const matches = zakazCandidates({ results: [item] }, store).map((candidate) =>
    matchCandidate(product, {
      ...candidate,
      quantity:
        (Array.isArray(item.taxons) ? item.taxons.slice(0, 60) : [])
          .map(obj)
          .filter((field) => ['volume-capacity', 'weight'].includes(str(field.type)))
          .map((field) => str(field.name))
          .find(Boolean) || candidate.quantity,
      warnings: [
        ...candidate.warnings,
        'EAN и фотография связаны в основных данных карточки магазина; проверьте актуальность упаковки.',
      ],
    }),
  );
  return {
    candidates: matches.filter((match) => !match.rejected).map((match) => match.candidate),
    conflict:
      (!!product.ean && normalizeGtin(product.ean) !== gtin) ||
      (matches.length > 0 && matches.every((match) => match.rejected)),
  };
}
