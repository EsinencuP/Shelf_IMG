import { sourceDiagnostic, sourceFailureDetails } from '../source-status';
import { createHash } from 'node:crypto';
import type { Candidate, SearchAttempt, SearchDiagnostic } from '../types';
import { ApiError } from './http';
import { candidateId, obj, safeUrl, str, zakazProductGtin } from './catalog-utils';
import { discoverPage } from './page-discovery';
import { serviceJson } from './discovery-services';
import { reserveSource } from './database';
import { matchCandidate } from './matching';
import {
  canonicalText,
  supplierWebQueries,
  titleRelevance,
  webQueries,
  withMarketName,
} from './search-queries';
import { extractedPageEvidence } from './extracted-page';
import { normalizeGtin, type SearchProduct } from './validation';
import { SUPPLIER_MARKETS, type SupplierMarket } from '../search-sources';
import { recordSearchAttempt } from './search-attempt';
export const WEB_PROVIDER_IDS = ['brave', 'tavily'] as const;
export type WebProvider = (typeof WEB_PROVIDER_IDS)[number];
export const WEB_PROVIDER_NAMES = { brave: 'Brave Search', tavily: 'Tavily Free' };
export const MOLDOVA_WEB_DOMAINS = [
  'metro.zakaz.md',
  'bonus.zakaz.md',
  'linella.md',
  'bucuria.md',
  'www.bucuria.md',
] as const;
export function configuredWebProviders(): WebProvider[] {
  return [
    ...(process.env.BRAVE_SEARCH_API_KEY?.trim() ? ['brave' as const] : []),
    ...(process.env.TAVILY_API_KEY?.trim() ? ['tavily' as const] : []),
  ];
}
// Attestation must refer to this key's account with paid balance/top-ups/overage disabled.
// No process-local counter can enforce a global zero-spend limit on Vercel.
export function braveFreeOnlyConfirmed(): boolean {
  const key = process.env.BRAVE_SEARCH_API_KEY?.trim();
  return (
    !!key &&
    process.env.BRAVE_FREE_ONLY_CONFIRMED === 'true' &&
    createHash('sha256').update(key).digest('hex') === process.env.BRAVE_FREE_ONLY_KEY_SHA256
  );
}
function limit(value: string | undefined, fallback: number, maximum: number) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 1 ? Math.min(maximum, Math.floor(number)) : fallback;
}
function exact(product: SearchProduct, candidates: Candidate[]) {
  return candidates.some((c) => {
    const m = matchCandidate(product, c);
    return !m.rejected && m.candidate.matchStatus === 'exact';
  });
}
/** Fail closed if the provider cannot prove a free account with paid overage disabled. */
export function tavilyFreeRemaining(data: Record<string, unknown>): number {
  const account = obj(data.account),
    key = obj(data.key);
  const { current_plan, plan_limit, plan_usage, paygo_limit, paygo_usage } = account;
  if (
    typeof current_plan !== 'string' ||
    !/^(free|researcher)$/i.test(current_plan) ||
    typeof plan_limit !== 'number' ||
    !Number.isInteger(plan_limit) ||
    plan_limit <= 0 ||
    plan_limit > 1000 ||
    typeof plan_usage !== 'number' ||
    !Number.isInteger(plan_usage) ||
    plan_usage < 0 ||
    !(
      paygo_limit === 0 ||
      (paygo_limit === null && process.env.TAVILY_FREE_ACCOUNT_CONFIRMED === 'true')
    ) ||
    paygo_usage !== 0
  )
    throw new ApiError(
      503,
      'Tavily отключён: нужен Free/Researcher без pay-as-you-go; тариф не подтверждён.',
    );
  let remaining = plan_limit - plan_usage;
  if (key.limit !== null && key.limit !== undefined) {
    if (
      typeof key.limit !== 'number' ||
      typeof key.usage !== 'number' ||
      !Number.isInteger(key.limit) ||
      !Number.isInteger(key.usage) ||
      key.limit < 0 ||
      key.usage < 0
    )
      throw new ApiError(503, 'Tavily: остаток квоты ключа не подтверждён.');
    remaining = Math.min(remaining, key.limit - key.usage);
  }
  return Math.max(0, remaining - 5); // Headroom; provider enforces the no-overage account quota.
}

function imageCandidate(
  imageUrl: string,
  pageUrl: string,
  title: string,
  provider: WebProvider,
  product: SearchProduct,
): Candidate[] {
  if (
    !title ||
    titleRelevance(product, title) < 0.35 ||
    /(?:\.svg(?:\?|$)|rubricator|promotion|s150x150)/i.test(imageUrl) ||
    /(?:logo|favicon|icon|instagram|facebook|twitter|banner|baner|barcodeimage)(?:[._/?-]|$)/i.test(
      new URL(imageUrl).pathname,
    ) ||
    /\/(?:categories|category|tags|search|reviews)\//i.test(new URL(pageUrl).pathname) ||
    new URL(pageUrl).hostname === 'barcode-list.ru'
  )
    return [];
  return [
    {
      id: candidateId(imageUrl),
      title,
      imageUrl,
      pageUrl,
      source: `${WEB_PROVIDER_NAMES[provider]} · ${new URL(pageUrl).hostname}`,
      rights: 'unknown',
      gtinExact: false,
      warnings: [
        'Поисковый индекс не подтверждает EAN, бренд и вариант упаковки.',
        'Права использования требуют подтверждения.',
      ],
    },
  ];
}

export async function searchWebDiscovery(
  product: SearchProduct,
  queryLimit: number,
  mode: 'moldova' | 'expanded' = 'expanded',
  market?: SupplierMarket,
  checkExactPhoto?: (candidates: Candidate[]) => Promise<boolean>,
  marketName?: string,
) {
  const candidates: Candidate[] = [],
    diagnostics: SearchDiagnostic[] = [],
    warnings: string[] = [];
  const pages = new Set<string>(),
    conflicts = new Set<string>();
  const unreadPages = new Set<string>();
  let reads = 0;
  let searches = 0;
  const selectedMarket = mode === 'expanded' ? market : undefined;
  const marketConfig = selectedMarket ? SUPPLIER_MARKETS[selectedMarket] : undefined;
  const discovery = withMarketName(product, marketConfig ? marketName : undefined);
  const usableExact = (matches: Candidate[]) =>
    !selectedMarket && exact(product, matches) && (checkExactPhoto?.(matches) ?? true);
  const scopeDomains = mode === 'moldova' ? MOLDOVA_WEB_DOMAINS : (marketConfig?.domains ?? []);
  const inScope = (url: string) => {
    const host = new URL(url).hostname;
    return (
      !scopeDomains.length ||
      scopeDomains.some(
        (domain) => host === domain || (!!selectedMarket && host.endsWith('.' + domain)),
      )
    );
  };
  const cap = Math.min(
    limit(process.env.SEARCH_MAX_WEB_QUERIES, 4, 6),
    Math.max(0, Math.floor(queryLimit)),
  );
  const providers = configuredWebProviders();
  for (const provider of providers) {
    if (await usableExact(candidates)) break;
    if (searches >= cap) break;
    const started = Date.now();
    const found: Candidate[] = [];
    const attempts: SearchAttempt[] = [];
    let requests = 0,
      completed = 0,
      failure = '';
    let failureDetails: ReturnType<typeof sourceFailureDetails> | undefined;
    try {
      const key =
        provider === 'brave'
          ? process.env.BRAVE_SEARCH_API_KEY?.trim()
          : process.env.TAVILY_API_KEY?.trim();
      const max = Math.min(
        cap -
          searches -
          Number(cap - searches > 1 && provider === 'brave' && providers.includes('tavily')),
        provider === 'brave'
          ? limit(process.env.BRAVE_MAX_QUERIES, 2, 4)
          : limit(process.env.TAVILY_MAX_QUERIES, 1, 2),
      );
      if (!max) continue;
      if (provider === 'brave') {
        if (key?.startsWith('tvly-'))
          throw new ApiError(
            503,
            'BRAVE_SEARCH_API_KEY содержит ключ Tavily; проверьте настройки.',
          );
        if (!braveFreeOnlyConfirmed())
          throw new ApiError(
            503,
            'Brave выключен: запрет платного расхода в аккаунте этого ключа не подтверждён.',
          );
      } else {
        if (!key?.startsWith('tvly-'))
          throw new ApiError(
            503,
            'Некорректный ключ Tavily; ключ другого провайдера не отправлен.',
          );
        requests++;
        if (
          tavilyFreeRemaining(await serviceJson(new URL('https://api.tavily.com/usage'), key)) < max
        )
          throw new ApiError(429, 'Бесплатная квота Tavily исчерпана; платный переход запрещён.');
      }
      const queryProduct =
        (provider === 'tavily' || max === 1) && webQueries({ ...product, ean: '' }, 1).length
          ? { ...product, ean: '' }
          : product;
      const queries = marketConfig
        ? supplierWebQueries(discovery, max)
        : webQueries(queryProduct, max);
      for (const rawQuery of queries) {
        const nameQuery = !/^"\d+"$/.test(rawQuery);
        const scope = scopeDomains
          .filter((domain) => !domain.startsWith('www.'))
          .map((domain) => `site:${domain}`)
          .join(' OR ');
        const languageFilter =
          marketConfig && nameQuery && (marketName || (selectedMarket === 'RO' && product.nameRo))
            ? ` lang:${marketConfig.language}`
            : '';
        const query =
          scope && provider === 'brave'
            ? `${rawQuery.replace(/\s+\([^)]*site:[^)]*\)$/, '').slice(0, 400 - scope.length - languageFilter.length - 3)} (${scope})${languageFilter}`
            : mode === 'moldova'
              ? `${rawQuery.replace(/\s+\([^)]*site:[^)]*\)$/, '').slice(0, 392)} Moldova`
              : selectedMarket
                ? rawQuery.replace(/\s+\([^)]*site:[^)]*\)$/, '')
                : rawQuery;
        requests++;
        const data = await recordSearchAttempt(
          attempts,
          query,
          async () => {
            let data: Record<string, unknown>;
            if (provider === 'brave') {
              await reserveSource('api.search.brave.com', 1100);
              const endpoint = new URL('https://api.search.brave.com/res/v1/web/search');
              endpoint.search = new URLSearchParams({
                q: query,
                count: '10',
                country: 'ALL',
                safesearch: 'strict',
                spellcheck: 'false',
              }).toString();
              searches++;
              const raw = await serviceJson(
                endpoint,
                key,
                undefined,
                10000,
                1500000,
                'X-Subscription-Token',
              );
              // Brave omits the nullable web field on a valid zero-result response.
              data = {
                results:
                  raw.web == null && (raw.type === 'search' || raw.query)
                    ? []
                    : obj(raw.web).results,
              };
            } else {
              await reserveSource('api.tavily.com', 1100);
              searches++;
              data = await serviceJson(new URL('https://api.tavily.com/search'), key, {
                query,
                search_depth: 'basic',
                topic: 'general',
                max_results: mode === 'moldova' ? 8 : 6,
                auto_parameters: false,
                include_answer: false,
                include_raw_content: false,
                // Tavily's image search can replace useful product-page results with
                // broad image matches. Regional recovery needs canonical pages first;
                // Extract obtains their actual photos below.
                include_images: mode !== 'moldova',
                ...(mode === 'moldova' ? {} : { include_image_descriptions: true }),
                include_usage: true,
                ...(marketConfig
                  ? {
                      country: marketConfig.country,
                      ...(nameQuery ? { language: marketConfig.language } : {}),
                    }
                  : {}),
                ...(scopeDomains.length
                  ? {
                      include_domains: [...scopeDomains],
                      include_domains_mode: marketConfig ? 'restrict' : 'prefer',
                    }
                  : {}),
              });
            }
            if (!Array.isArray(data.results))
              throw new ApiError(
                502,
                WEB_PROVIDER_NAMES[provider] + ' вернул некорректную выдачу.',
              );
            return { results: data.results, images: data.images };
          },
          (response) => response.results.length,
        );
        completed++;
        const pageResults = data.results;
        for (const entry of data.results.slice(0, 12)) {
          const item = obj(entry),
            pageUrl = safeUrl(item.url),
            title = str(item.title);
          if (!pageUrl) continue;
          const routeGtin = zakazProductGtin(pageUrl);
          if (product.ean && routeGtin && normalizeGtin(product.ean) !== normalizeGtin(routeGtin))
            continue;
          if (!inScope(pageUrl)) continue;
          const relevant = titleRelevance(discovery, title) >= 0.35;
          const barcodeMentioned =
            !!product.ean &&
            `${title} ${str(item.description)} ${pageUrl}`.includes(
              product.ean.replace(/[\s-]/g, ''),
            );
          if (!relevant && !barcodeMentioned) continue;
          if (/\/(?:categories|category|tags|search|reviews)\//i.test(new URL(pageUrl).pathname))
            continue;
          if (!pages.has(pageUrl) && reads < 6) {
            pages.add(pageUrl);
            reads++;
            try {
              const result = await discoverPage(pageUrl, discovery);
              if (result.failure)
                diagnostics.push(
                  sourceDiagnostic({
                    id: 'page-' + createHash('sha256').update(pageUrl).digest('hex').slice(0, 12),
                    source: new URL(pageUrl).hostname,
                    ...result.failure,
                    count: 0,
                    elapsedMs: 0,
                  }),
                );
              found.push(...result.candidates.filter((candidate) => inScope(candidate.pageUrl)));
              if (result.conflict) conflicts.add(pageUrl);
              else if (!result.candidates.length) unreadPages.add(pageUrl);
            } catch (error) {
              unreadPages.add(pageUrl);
              diagnostics.push(
                sourceDiagnostic({
                  id: 'page-' + createHash('sha256').update(pageUrl).digest('hex').slice(0, 12),
                  source: new URL(pageUrl).hostname,
                  ...sourceFailureDetails(error),
                  count: 0,
                  elapsedMs: 0,
                }),
              );
              warnings.push('Карточка недоступна или отклонена проверкой безопасности.');
            }
          }
          if (!pages.has(pageUrl)) unreadPages.add(pageUrl);
          if (conflicts.has(pageUrl)) continue;
          const thumb = obj(item.thumbnail);
          const tiedImages = Array.isArray(data.images)
            ? data.images.filter((rawImage) => {
                const imageTitle = canonicalText(str(obj(rawImage).title));
                const pageTitle = canonicalText(title);
                if (imageTitle.length < 12 || pageTitle.length < 12) return false;
                const matchingPages = pageResults.filter((rawPage: unknown) => {
                  const otherTitle = canonicalText(str(obj(rawPage).title));
                  return (
                    otherTitle.length >= 12 &&
                    (imageTitle.startsWith(otherTitle) || otherTitle.startsWith(imageTitle))
                  );
                });
                return (
                  matchingPages.length === 1 &&
                  (imageTitle.startsWith(pageTitle) || pageTitle.startsWith(imageTitle))
                );
              })
            : [];
          const images =
            provider === 'brave'
              ? [thumb.original || thumb.src]
              : [
                  ...(Array.isArray(item.images) ? item.images.slice(0, 1) : []),
                  ...tiedImages.slice(0, 2),
                ];
          for (const rawImage of images) {
            const imageUrl = safeUrl(typeof rawImage === 'string' ? rawImage : obj(rawImage).url);
            if (imageUrl)
              found.push(...imageCandidate(imageUrl, pageUrl, title, provider, discovery));
          }
        }
        if (await usableExact(found)) break;
      }
      if (provider === 'tavily' && !(await usableExact(found)) && unreadPages.size) {
        const priority = (url: string) =>
          Number(!!product.ean && url.includes(product.ean.replace(/[\s-]/g, ''))) * 2 +
          Number(/\/(?:products|product|tovar|market-product)\//i.test(new URL(url).pathname));
        const urls = [...unreadPages]
          .filter((url) => !conflicts.has(url))
          .sort((a, b) => priority(b) - priority(a))
          .slice(0, 3);
        if (urls.length) {
          // Check quota again immediately before the optional one-credit batch.
          requests++;
          if (
            tavilyFreeRemaining(await serviceJson(new URL('https://api.tavily.com/usage'), key)) < 1
          )
            throw new ApiError(429, 'Бесплатная квота извлечения карточек исчерпана.');
          await reserveSource('api.tavily.com', 1100);
          requests++;
          const extracted = await serviceJson(
            new URL('https://api.tavily.com/extract'),
            key,
            {
              urls,
              extract_depth: 'basic',
              include_images: true,
              format: 'markdown',
              timeout: 10,
              include_usage: true,
            },
            15000,
          );
          if (Array.isArray(extracted.results))
            for (const page of extracted.results) {
              if (!urls.includes(str(obj(page).url))) continue;
              const evidence = extractedPageEvidence(page, discovery);
              if (evidence.conflict) conflicts.add(str(obj(page).url));
              found.push(...evidence.candidates);
            }
        }
      }
    } catch (error) {
      failure = error instanceof ApiError ? error.message : 'Сервис поиска временно недоступен.';
      failureDetails = sourceFailureDetails(error);
    }
    candidates.push(
      ...found
        .filter(
          (candidate) => inScope(candidate.pageUrl) && !matchCandidate(product, candidate).rejected,
        )
        .map((candidate) =>
          selectedMarket ? { ...candidate, sourceMarket: selectedMarket } : candidate,
        ),
    );
    if (failure) warnings.push(WEB_PROVIDER_NAMES[provider] + ': ' + failure);
    diagnostics.push(
      sourceDiagnostic({
        id: provider,
        source: WEB_PROVIDER_NAMES[provider],
        status: completed ? 'ok' : 'unavailable',
        ...failureDetails,
        count: found.length,
        elapsedMs: Date.now() - started,
        requests,
        ...(attempts.length ? { attempts } : {}),
        message:
          failure ||
          (provider === 'brave'
            ? 'Web Search; пустой ответ вызывает следующий запрос. До шести карточек на SKU.'
            : 'Только basic; Free-квота и отключённый pay-as-you-go проверены.'),
      }),
    );
  }
  for (const provider of providers)
    if (!diagnostics.some((d) => d.id === provider))
      diagnostics.push(
        sourceDiagnostic({
          id: provider,
          source: WEB_PROVIDER_NAMES[provider],
          status: 'skipped',
          count: 0,
          elapsedMs: 0,
          requests: 0,
          message:
            searches >= cap
              ? 'Лимит веб-запросов для этого SKU израсходован.'
              : 'Найден точный EAN без конфликтов; резервная квота сохранена.',
        }),
      );
  return {
    candidates: candidates.filter((candidate) => !conflicts.has(candidate.pageUrl)),
    diagnostics,
    warnings: [...new Set(warnings)],
  };
}
