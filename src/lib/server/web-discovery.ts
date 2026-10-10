import type { Candidate, SearchDiagnostic } from '../types';
import { ApiError } from './http';
import { candidateId, obj, safeUrl, str } from './catalog-utils';
import { discoverPage } from './page-discovery';
import { serviceEndpoint, serviceJson } from './discovery-services';
import { matchCandidate } from './matching';
import { titleRelevance, webQueries } from './search-queries';
import type { SearchProduct } from './validation';

export type WebProvider = 'searxng' | 'tavily';
export function configuredWebProviders(): WebProvider[] {
  return [
    ...(process.env.SEARXNG_URL ? ['searxng' as const] : []),
    ...(process.env.TAVILY_API_KEY ? ['tavily' as const] : []),
  ];
}
const names = { searxng: 'SearXNG', tavily: 'Tavily Free' };

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
    /(?:logo|favicon|icon)(?:[._/-]|$)/i.test(new URL(imageUrl).pathname)
  )
    return [];
  return [
    {
      id: candidateId(imageUrl),
      title,
      imageUrl,
      pageUrl,
      source: `${names[provider]} · ${new URL(pageUrl).hostname}`,
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
): Promise<{
  candidates: Candidate[];
  diagnostics: SearchDiagnostic[];
  warnings: string[];
}> {
  const candidates: Candidate[] = [],
    diagnostics: SearchDiagnostic[] = [],
    warnings: string[] = [];
  const pages = new Set<string>(),
    budget = { rendered: 0 };
  const conflictingPages = new Set<string>();
  const serverLimit = Math.min(
    6,
    Math.max(1, Math.floor(Number(process.env.SEARCH_MAX_WEB_QUERIES) || 4)),
  );
  let reads = 0;
  for (const provider of configuredWebProviders()) {
    const start = Date.now();
    let requests = 0,
      completed = 0;
    const providerCandidates: Candidate[] = [];
    try {
      // One credit/SKU by default. Client's larger search limit cannot increase this cap.
      const limit =
        provider === 'tavily'
          ? Math.min(
              serverLimit,
              queryLimit,
              Math.min(2, Math.max(1, Math.floor(Number(process.env.TAVILY_MAX_QUERIES) || 1))),
            )
          : Math.min(serverLimit, queryLimit);
      if (provider === 'tavily') {
        if (!process.env.TAVILY_API_KEY?.startsWith('tvly-'))
          throw new ApiError(
            503,
            'TAVILY_API_KEY должен содержать ключ Tavily; ключ другого провайдера не отправлен.',
          );
        requests++;
        const usage = await serviceJson(
          new URL('https://api.tavily.com/usage'),
          process.env.TAVILY_API_KEY,
        );
        if (tavilyFreeRemaining(usage) < limit)
          throw new ApiError(429, 'Бесплатная квота Tavily исчерпана; платный переход запрещён.');
      }
      for (const query of webQueries(product, limit)) {
        requests++;
        let data: Record<string, unknown>;
        if (provider === 'searxng') {
          const endpoint = serviceEndpoint(process.env.SEARXNG_URL!, 'search');
          endpoint.search = new URLSearchParams({
            q: query,
            format: 'json',
            categories: 'general,images',
            language: 'auto',
            safesearch: '2',
            pageno: '1',
          }).toString();
          data = await serviceJson(endpoint, process.env.SEARXNG_API_TOKEN);
          if (Array.isArray(data.unresponsive_engines) && data.unresponsive_engines.length)
            warnings.push('SearXNG: часть поисковых движков недоступна.');
          if (
            !Array.isArray(data.results) ||
            (!data.results.length &&
              Array.isArray(data.unresponsive_engines) &&
              data.unresponsive_engines.length)
          )
            throw new ApiError(502, 'SearXNG не получил корректную выдачу от поисковых движков.');
        } else {
          data = await serviceJson(
            new URL('https://api.tavily.com/search'),
            process.env.TAVILY_API_KEY,
            {
              query,
              search_depth: 'basic',
              topic: 'general',
              max_results: 6,
              auto_parameters: false,
              include_answer: false,
              include_raw_content: false,
              include_images: true,
              include_image_descriptions: false,
              include_usage: true,
            },
          );
          if (!Array.isArray(data.results))
            throw new ApiError(502, 'Tavily вернул некорректную выдачу.');
        }
        completed++;
        for (const entry of (data.results as unknown[]).slice(0, 12)) {
          const item = obj(entry),
            pageUrl = safeUrl(item.url),
            title = str(item.title);
          if (!pageUrl) continue;
          if (!pages.has(pageUrl) && reads < 3) {
            pages.add(pageUrl);
            reads++;
            try {
              const result = await discoverPage(pageUrl, product, budget);
              providerCandidates.push(...result.candidates);
              if (result.conflict) conflictingPages.add(pageUrl);
            } catch {
              warnings.push(
                'Карточка товара недоступна или отклонена проверкой безопасности; другие результаты проверяются.',
              );
            }
          }
          if (conflictingPages.has(pageUrl)) continue;
          if (provider === 'searxng') {
            const image = safeUrl(item.img_src);
            if (image)
              providerCandidates.push(...imageCandidate(image, pageUrl, title, provider, product));
          } else {
            // Top-level images lack page provenance: use only images associated with a result.
            for (const entry of (Array.isArray(item.images) ? item.images : []).slice(0, 3)) {
              const image = safeUrl(typeof entry === 'string' ? entry : obj(entry).url);
              if (image)
                providerCandidates.push(
                  ...imageCandidate(image, pageUrl, title, provider, product),
                );
            }
          }
        }
        if (
          providerCandidates.some((candidate) => {
            const matched = matchCandidate(product, candidate);
            return !matched.rejected && matched.candidate.gtinExact;
          })
        )
          break;
      }
      candidates.push(...providerCandidates);
      diagnostics.push({
        id: provider,
        source: names[provider],
        status: 'ok',
        count: providerCandidates.length,
        elapsedMs: Date.now() - start,
        requests,
        message:
          provider === 'tavily'
            ? 'Только basic; Free/Researcher и отключённый pay-as-you-go проверены.'
            : 'Собственный поисковый сервер; без токенов LLM.',
      });
      if (providerCandidates.some((candidate) => !matchCandidate(product, candidate).rejected))
        break;
    } catch (error) {
      // Keep successful earlier query results if a later query failed.
      candidates.push(...providerCandidates);
      diagnostics.push({
        id: provider,
        source: names[provider],
        status: completed ? 'ok' : 'unavailable',
        count: providerCandidates.length,
        elapsedMs: Date.now() - start,
        requests,
        message: error instanceof ApiError ? error.message : 'Сервис поиска временно недоступен.',
      });
      if (providerCandidates.some((candidate) => !matchCandidate(product, candidate).rejected))
        break;
    }
  }
  for (const provider of configuredWebProviders())
    if (!diagnostics.some((item) => item.id === provider))
      diagnostics.push({
        id: provider,
        source: names[provider],
        status: 'skipped',
        count: 0,
        elapsedMs: 0,
        message: 'Предыдущий бесплатный источник уже дал кандидатов.',
      });
  return { candidates, diagnostics, warnings };
}
