import { sourceDiagnostic, sourceFailureDetails, isSourceFailure } from '../source-status';
import { createHash } from 'node:crypto';
import {
  DEFAULT_SEARCH_OPTIONS,
  type Candidate,
  type SearchDiagnostic,
  type SearchResponse,
  type SearchOptions,
  type SourcePhotoCheck,
} from '../types';
import { ApiError, readBody } from './http';
import { USER_AGENT, validatePublicUrl } from './public-fetch';
import { outboundFetch } from './outbound-fetch';
import { matchCandidate } from './matching';
import { normalizeGtin, type SearchProduct } from './validation';
import { searchRegionalSources } from './regional-search';
import { searchSupplementalCatalogs } from './supplemental-search';
import {
  configuredWebProviders,
  searchWebDiscovery,
  WEB_PROVIDER_IDS,
  WEB_PROVIDER_NAMES,
} from './web-discovery';
import { cachedSearch } from './search-cache';
import { resolveBarcodeIdentity } from './barcode-identity';
import { searchSostavista } from './sostavista-search';
import { findApproved } from './library';
import { reserveSource } from './database';
import { REGIONAL_SOURCES, OPEN_CATALOGS } from '../search-sources';
import { checkSourcePhoto } from './source-photo';
import { abortable, currentSearchSignal, inSearch, waitForSource } from './search-signal';
import { sourceFailure } from './source-policy';

export const SEARCH_DEADLINE_MS = 90_000;

const idFor = (value: string) => createHash('sha256').update(value).digest('hex').slice(0, 20);
const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const text = (value: unknown) => (typeof value === 'string' ? value.slice(0, 400) : '');
const publicUrl = (value: unknown, base?: string): string | null => {
  if (typeof value !== 'string') return null;
  try {
    return validatePublicUrl(base ? new URL(value, base).href : value).href;
  } catch {
    return null;
  }
};

async function providerJson(
  url: string,
  headers: Record<string, string> = {},
  emptyOnMissing = false,
): Promise<Record<string, unknown>> {
  const response = await outboundFetch(url, {
    cache: 'no-store',
    redirect: 'error',
    headers: {
      'User-Agent': process.env.OPENFOODFACTS_USER_AGENT || USER_AGENT,
      Accept: 'application/json',
      ...headers,
    },
  });
  if (!response.ok) {
    void response.body?.cancel().catch(() => {});
    if (response.status === 404 && emptyOnMissing) return { status: 0 };
    throw await sourceFailure(
      url,
      { status: response.status, headers: Object.fromEntries(response.headers) },
      response.status === 429
        ? 'Лимит источника исчерпан; повторите позже.'
        : `Источник поиска недоступен (HTTP ${response.status}).`,
    );
  }
  const body = await readBody(response, 1_000_000);
  try {
    const parsed: unknown = JSON.parse(Buffer.from(body).toString('utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error();
    return record(parsed);
  } catch {
    throw new ApiError(502, 'Источник вернул некорректный JSON.');
  }
}

// Product reads are paced to stay below OFF's 15 reads/minute/IP within this process.
// Multiple deployments behind one egress IP still need an external shared limiter.
let offTail: Promise<void> = Promise.resolve();
let offStarted = 0;
async function pacedOff<T>(job: () => Promise<T>): Promise<T> {
  const signal = currentSearchSignal();
  signal?.throwIfAborted();
  const previous = offTail;
  let release!: () => void;
  offTail = new Promise<void>((resolve) => {
    release = resolve;
  });
  try {
    await abortable(previous, signal);
    await waitForSource(offStarted + 4_100 - Date.now(), signal);
    offStarted = Date.now();
    await reserveSource('world.openfoodfacts.org', 4100);
    return await job();
  } finally {
    void previous.then(release);
  }
}

export function offCandidates(data: Record<string, unknown>, product: SearchProduct): Candidate[] {
  const item = record(data.product);
  if (
    !Object.keys(item).length ||
    !product.ean ||
    normalizeGtin(text(item.code)) !== normalizeGtin(product.ean)
  )
    return [];
  const images = record(item.images);
  const selected = record(record(item.selected_images).front);
  const display = record(selected.display);
  const languages = [
    ...new Set([
      'ro',
      'ru',
      'en',
      ...Object.keys(display),
      ...Object.keys(images)
        .filter((key) => key.startsWith('front_'))
        .map((key) => key.slice(6)),
    ]),
  ];
  const pageUrl = `https://world.openfoodfacts.org/product/${encodeURIComponent(text(item.code))}`;
  const candidates: Candidate[] = [];
  const seen = new Set<string>();
  for (const lang of languages) {
    const meta = record(images[`front_${lang}`]);
    let url = publicUrl(display[lang]);
    // Preserve the selected front crop, increasing only to the source's existing full resolution.
    if (url && /^\d+$/.test(String(meta.rev ?? '')))
      url = url.replace(/\.\d+\.jpg(?:\?.*)?$/, '.full.jpg');
    if (!url && /^\d+$/.test(String(meta.rev ?? '')) && /^(?:[a-z]{2})$/.test(lang)) {
      const code = text(item.code).padStart(13, '0');
      const path = code.replace(/^(...)(...)(...)(.*)$/, '$1/$2/$3/$4');
      url = `https://images.openfoodfacts.org/images/products/${path}/front_${lang}.${meta.rev}.full.jpg`;
    }
    if (!url || seen.has(url) || new URL(url).hostname !== 'images.openfoodfacts.org') continue;
    seen.add(url);
    const author = text(record(images[String(meta.imgid)]).uploader) || text(item.creator);
    candidates.push({
      id: idFor(url),
      title:
        text(item[`product_name_${lang}`]) || text(item.product_name) || 'Товар Open Food Facts',
      brand: text(item.brands),
      quantity: text(item.quantity),
      gtin: text(item.code),
      imageUrl: url,
      pageUrl,
      source: `Open Food Facts${author ? ` · ${author}` : ' · contributors'}`,
      rights: 'open_license',
      license: `CC BY-SA 3.0 — https://creativecommons.org/licenses/by-sa/3.0/; автор: ${author || 'Open Food Facts contributors'}; источник: ${pageUrl}`,
      gtinExact: true,
      warnings: [
        'Открытая база пищевых продуктов, заполненная участниками. Проверьте фотографию.',
        ...(!author
          ? [
              'Автор конкретной фотографии отсутствует в метаданных; проверьте атрибуцию на странице товара.',
            ]
          : []),
      ],
    });
    if (candidates.length >= 3) break;
  }
  if (!candidates.length) {
    const url = publicUrl(item.image_front_url);
    if (url && new URL(url).hostname === 'images.openfoodfacts.org')
      candidates.push({
        id: idFor(url),
        title: text(item.product_name) || 'Товар Open Food Facts',
        brand: text(item.brands),
        quantity: text(item.quantity),
        gtin: text(item.code),
        imageUrl: url,
        pageUrl,
        source: 'Open Food Facts · contributors',
        rights: 'open_license',
        license: `CC BY-SA 3.0 — https://creativecommons.org/licenses/by-sa/3.0/; источник: ${pageUrl}`,
        gtinExact: true,
        warnings: ['Проверьте автора фотографии на странице источника и актуальность упаковки.'],
      });
  }
  return candidates;
}

async function fromOff(product: SearchProduct): Promise<Candidate[]> {
  if (!product.ean) return [];
  const code = product.ean.replace(/[\s-]/g, '');
  const fields =
    'code,product_name,product_name_ru,product_name_ro,product_name_en,brands,quantity,images,selected_images,image_front_url,creator';
  // v2 remains supported and supplies the documented selected front image/uploader schema.
  const data = await pacedOff(() =>
    providerJson(
      `https://world.openfoodfacts.org/api/v2/product/${code}.json?fields=${fields}`,
      {},
      true,
    ),
  );
  if (data.status !== 0 && !Object.keys(record(data.product)).length)
    throw new ApiError(502, 'Источник вернул некорректную выдачу Open Food Facts.');
  return offCandidates(data, product);
}

export function productJsonLdCandidates(
  html: string,
  pageUrl: string,
  product: SearchProduct,
): Candidate[] {
  const requested = product.ean ? normalizeGtin(product.ean) : null;
  if (!requested) return [];
  const candidates: Candidate[] = [];
  let visited = 0;
  const walk = (value: unknown, depth = 0): void => {
    if (depth > 10 || visited++ > 300 || candidates.length >= 4) return;
    if (Array.isArray(value)) {
      value.slice(0, 100).forEach((node) => walk(node, depth + 1));
      return;
    }
    const node = record(value);
    const types = Array.isArray(node['@type']) ? node['@type'] : [node['@type']];
    if (types.some((type) => typeof type === 'string' && /(?:^|[/#])Product$/.test(type))) {
      const gtins = ['gtin', 'gtin8', 'gtin12', 'gtin13', 'gtin14']
        .map((key) => text(node[key]))
        .filter(Boolean);
      const gtin = gtins.find((value) => normalizeGtin(value) === requested);
      if (gtin) {
        const images = Array.isArray(node.image) ? node.image : [node.image];
        for (const image of images.slice(0, 3)) {
          const imageNode = record(image);
          const imageUrl = publicUrl(
            typeof image === 'string' ? image : imageNode.url || imageNode.contentUrl,
            pageUrl,
          );
          if (!imageUrl) continue;
          candidates.push({
            id: idFor(imageUrl),
            title: text(node.name) || 'Товар каталога',
            brand: text(node.brand) || text(record(node.brand).name),
            quantity: text(node.size) || text(record(node.weight).value),
            gtin,
            imageUrl,
            pageUrl,
            source: new URL(pageUrl).hostname,
            rights: 'unknown',
            gtinExact: true,
            warnings: [
              'GTIN и изображение связаны в Product JSON-LD источника; сведения требуют проверки.',
              'Права использования не подтверждены.',
            ],
          });
        }
      }
    }
    // Only graph containers are traversed; recommendations/relatedProducts are not evidence.
    if (node['@graph']) walk(node['@graph'], depth + 1);
    if (node.mainEntity) walk(node.mainEntity, depth + 1);
  };
  const scripts = html.matchAll(
    /<script\b[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script\s*>/gi,
  );
  for (const script of scripts) {
    if (script[1].length > 200_000) continue;
    try {
      walk(JSON.parse(script[1]));
    } catch {
      /* An invalid script is not product evidence. */
    }
  }
  return candidates;
}

export async function searchProducts(
  product: SearchProduct,
  options: SearchOptions = DEFAULT_SEARCH_OPTIONS,
  refresh = false,
  signal?: AbortSignal,
): Promise<SearchResponse> {
  const started = performance.now();
  const deadline = AbortSignal.timeout(SEARCH_DEADLINE_MS);
  const response = await searchProductsInternal(product, options, refresh, deadline, signal);
  const diagnostics = (response.diagnostics ?? []).map(sourceDiagnostic);
  const knownSources = [
    { id: 'food-facts', name: 'Open Food Facts', eanOnly: true },
    { id: 'sostavista', name: 'Состависта · база EAN', eanOnly: true },
    ...OPEN_CATALOGS.map((source) => ({ ...source, eanOnly: true })),
    { id: 'upcitemdb', name: 'UPCitemdb', eanOnly: true },
    ...REGIONAL_SOURCES.map((source) => ({ ...source, eanOnly: false })),
    ...WEB_PROVIDER_IDS.map((id) => ({ id, name: WEB_PROVIDER_NAMES[id], eanOnly: false })),
  ];
  for (const source of knownSources) {
    if (diagnostics.some((item) => item.id === source.id)) continue;
    const reason =
      source.eanOnly && !product.ean
        ? 'Для этого каталога нужен GTIN товара.'
        : diagnostics.some((item) => item.id === 'search-deadline')
          ? 'Общий лимит времени истёк до запроса к источнику.'
          : response.outcome === 'found'
            ? 'Точный кандидат уже найден; источник не опрашивался.'
            : 'Источник не выбран для категории товара, режима поиска или текущих настроек.';
    diagnostics.push(
      sourceDiagnostic({
        id: source.id,
        source: source.name,
        status: 'disabled',
        reason,
        count: 0,
        elapsedMs: 0,
        requests: 0,
      }),
    );
  }
  return {
    ...response,
    diagnostics,
    elapsedMs: Math.max(0, Math.round(performance.now() - started)),
  };
}

async function searchProductsInternal(
  product: SearchProduct,
  options: SearchOptions,
  refresh: boolean,
  deadline: AbortSignal,
  caller?: AbortSignal,
): Promise<SearchResponse> {
  caller?.throwIfAborted();
  const librarySignal = caller ? AbortSignal.any([caller, deadline]) : deadline;
  try {
    const approved =
      !refresh && options.useCache !== false
        ? await abortable(findApproved(product), librarySignal)
        : [];
    if (approved.length)
      return {
        candidates: approved,
        warnings: [],
        outcome: 'found',
        diagnostics: [
          {
            id: 'library',
            source: 'Общий каталог',
            status: 'ok',
            count: approved.length,
            elapsedMs: 0,
            message: 'Использована ранее подтверждённая фотография; интернет-квота сохранена.',
          },
        ],
      };
  } catch {
    caller?.throwIfAborted();
    /* Shared catalogue outages must not prevent fallback internet discovery. */
  }
  const run = (operation?: AbortSignal) => {
    const signal = operation ? AbortSignal.any([deadline, operation]) : deadline;
    return inSearch(signal, () => runSearchProducts(product, options, refresh, signal));
  };
  try {
    return await cachedSearch(product, options, refresh, run, caller, librarySignal);
  } catch (error) {
    caller?.throwIfAborted();
    if (deadline.aborted && error === deadline.reason) return run();
    throw error;
  }
}

async function runSearchProducts(
  suppliedProduct: SearchProduct,
  options: SearchOptions,
  refresh: boolean,
  signal: AbortSignal,
): Promise<SearchResponse> {
  const diagnostics: SearchDiagnostic[] = [];
  const candidates: Candidate[] = [];
  const warnings: string[] = [];
  let product = suppliedProduct;
  const checkedPhotos = new Map<string, SourcePhotoCheck | null>();
  const exact = (candidate: Candidate) =>
    matchCandidate(suppliedProduct, candidate).candidate.matchStatus === 'exact';
  async function checkExactPhoto(items = candidates) {
    for (const candidate of items) {
      if (signal.aborted) break;
      if (!exact(candidate)) continue;
      if (checkedPhotos.get(candidate.imageUrl)) return true;
      if (checkedPhotos.has(candidate.imageUrl) || checkedPhotos.size >= 3) continue;
      const started = Date.now();
      try {
        checkedPhotos.set(candidate.imageUrl, await checkSourcePhoto(candidate));
        return true;
      } catch (error) {
        if (!signal.aborted) checkedPhotos.set(candidate.imageUrl, null);
        diagnostics.push(
          sourceDiagnostic({
            id: 'image-' + candidate.id,
            source: `Фото · ${candidate.source}`,
            count: 0,
            elapsedMs: Date.now() - started,
            ...(error instanceof ApiError && [413, 415, 422].includes(error.status)
              ? { status: 'parse_error', reason: error.message }
              : sourceFailureDetails(error)),
          }),
        );
      }
    }
    return false;
  }
  const run = async (id: string, source: string, job: () => Promise<Candidate[]>) => {
    if (signal.aborted) return;
    const start = Date.now();
    try {
      const found = await abortable(job(), signal);
      candidates.push(...found);
      diagnostics.push(
        sourceDiagnostic({
          id,
          source,
          status: 'ok',
          count: found.length,
          elapsedMs: Date.now() - start,
        }),
      );
    } catch (error) {
      diagnostics.push(
        sourceDiagnostic({
          id,
          source,
          count: 0,
          elapsedMs: Date.now() - start,
          message: error instanceof Error ? error.message : 'Источник временно недоступен.',
          ...sourceFailureDetails(error),
        }),
      );
    }
  };
  // Inexpensive EAN lookups precede shops and web credits.
  let usableExact = false;
  if (product.ean) {
    await run('sostavista', 'Состависта · база EAN', () => searchSostavista(product));
    usableExact = await checkExactPhoto();
    if (refresh || !usableExact) {
      await run('food-facts', 'Open Food Facts', () => fromOff(product));
      usableExact = await checkExactPhoto();
    }
  }
  if (!signal.aborted && (refresh || !usableExact)) {
    if (
      product.ean &&
      ![product.nameRu, product.nameRo].some((name) => name && !/^Товар с EAN /i.test(name))
    ) {
      const start = Date.now();
      try {
        product = await resolveBarcodeIdentity(product);
        diagnostics.push(
          sourceDiagnostic({
            id: 'barcode-identity',
            source: 'Название по штрихкоду',
            status: product.nameRu ? 'ok' : 'empty',
            count: 0,
            elapsedMs: Date.now() - start,
            message: product.nameRu
              ? 'Название найдено; фотография проверяется отдельно.'
              : 'Название не найдено.',
          }),
        );
      } catch (error) {
        diagnostics.push(
          sourceDiagnostic({
            id: 'barcode-identity',
            source: 'Название по штрихкоду',
            count: 0,
            elapsedMs: Date.now() - start,
            message: 'Справочник названий временно недоступен.',
            ...sourceFailureDetails(error),
          }),
        );
      }
    }
    if (!signal.aborted && options.mode === 'expanded') {
      const result = await searchSupplementalCatalogs(product);
      candidates.push(...result.candidates);
      diagnostics.push(...result.diagnostics);
      usableExact = await checkExactPhoto();
    }
  }
  if (!signal.aborted && (refresh || !usableExact)) {
    const result = await searchRegionalSources(
      product,
      options.mode,
      options.market,
      options.marketName,
    );
    candidates.push(...result.candidates);
    diagnostics.push(...result.diagnostics);
    usableExact = await checkExactPhoto();
  }
  const regionalUnavailable = diagnostics.some(
    (item) =>
      ['metro-md', 'bonus-md', 'linella', 'bucuria'].includes(item.id) &&
      isSourceFailure(item.status),
  );
  const webEnabled = options.useWeb && (options.mode === 'expanded' || regionalUnavailable);
  const needsWeb = !signal.aborted && (refresh || !usableExact) && webEnabled;
  const webUnavailable = needsWeb && !configuredWebProviders().length;
  if (needsWeb && !webUnavailable) {
    const result = await searchWebDiscovery(
      product,
      options.webQueryLimit,
      options.mode,
      options.market,
      checkExactPhoto,
      options.marketName,
    );
    candidates.push(...result.candidates);
    diagnostics.push(...result.diagnostics);
    usableExact = await checkExactPhoto();
    // Low-level fetch failures belong to diagnostics, not the product's warning banner.
    if (result.warnings.length)
      diagnostics.push(
        sourceDiagnostic({
          id: 'web-pages',
          source: 'Карточки веб-поиска',
          ...sourceFailureDetails({ message: result.warnings.join(' '), trustedDiagnostic: true }),
          count: 0,
          elapsedMs: 0,
          message: result.warnings.join(' '),
        }),
      );
  } else {
    for (const id of WEB_PROVIDER_IDS)
      diagnostics.push(
        sourceDiagnostic({
          id,
          source: WEB_PROVIDER_NAMES[id],
          status: webUnavailable ? 'not_configured' : 'skipped',
          count: 0,
          elapsedMs: 0,
          message: signal.aborted
            ? 'Общий лимит времени истёк до запроса к источнику.'
            : usableExact && !webUnavailable
              ? 'Найден точный EAN; резервная квота сохранена.'
              : !webEnabled
                ? options.useWeb
                  ? 'Местные каталоги ответили; резервный поиск не потребовался.'
                  : 'Веб-поиск выключен в настройках.'
                : 'Нужен API-ключ.',
        }),
      );
  }
  if (signal.aborted)
    diagnostics.push(
      sourceDiagnostic({
        id: 'search-deadline',
        source: 'Общее время поиска',
        status: 'timeout',
        count: 0,
        elapsedMs: SEARCH_DEADLINE_MS,
        message: 'Истёк общий лимит поиска по товару. Уже найденные кандидаты сохранены.',
      }),
    );
  const byImage = new Map<string, Candidate>();
  for (const candidate of candidates) {
    const result = matchCandidate(suppliedProduct, candidate);
    if (result.rejected) {
      diagnostics.push(
        sourceDiagnostic({
          id: 'rejected-' + candidate.id,
          source: candidate.source,
          status: 'skipped',
          count: 0,
          elapsedMs: 0,
          message:
            'Отклонён «' +
            candidate.title +
            '»: ' +
            result.candidate.warnings
              .filter((reason) => /отличается|отличаются/.test(reason))
              .join(' '),
        }),
      );
      continue;
    }
    const photo = checkedPhotos.get(candidate.imageUrl);
    if (photo === null) continue;
    if (photo) {
      result.candidate.sourceImageHash = photo.sha256;
      result.candidate.sourcePhotoCheck = photo;
    }
    const previous = byImage.get(candidate.imageUrl);
    if (!previous || (result.candidate.matchStatus === 'exact' && previous.matchStatus !== 'exact'))
      byImage.set(candidate.imageUrl, result.candidate);
  }
  const found = [...byImage.values()]
    .sort(
      (a, b) =>
        Number(!!b.sourceImageHash) - Number(!!a.sourceImageHash) ||
        Number(b.matchStatus === 'exact') - Number(a.matchStatus === 'exact') ||
        Number(b.gtinExact) - Number(a.gtinExact),
    )
    .slice(0, 24);
  const retryable = diagnostics.some(
    (item) =>
      isSourceFailure(item.status) &&
      item.status !== 'parse_error' &&
      ![401, 403, 404, 406, 451].includes(item.httpStatus ?? 0),
  );
  const incomplete = diagnostics.some((item) => isSourceFailure(item.status)) || webUnavailable;
  const outcome = found.length
    ? found.some((item) => item.sourceImageHash && item.matchStatus === 'exact')
      ? 'found'
      : 'review'
    : incomplete
      ? 'deferred'
      : 'not_found';
  if (outcome === 'deferred')
    warnings.push(
      webUnavailable && !diagnostics.some((item) => isSourceFailure(item.status))
        ? 'Поиск неполный: веб-поиск не настроен. Добавьте свою фотографию или измените режим поиска.'
        : 'Поиск неполный: часть источников недоступна. Повторите позже или добавьте свою фотографию.',
    );
  if (
    !found.some((item) => item.matchStatus === 'exact') &&
    found.some((item) => item.matchStatus === 'metadata_conflict')
  )
    warnings.push(
      'EAN найден, но сведения о фасовке противоречивы. Проверьте этикетку перед подтверждением.',
    );
  return {
    candidates: found,
    diagnostics,
    warnings,
    outcome,
    coverage: incomplete ? 'partial' : 'complete',
    retryable,
  };
}
