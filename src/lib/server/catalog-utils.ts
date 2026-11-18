import { createHash } from 'node:crypto';
import { load } from 'cheerio/slim';
import type { Candidate } from '../types';
import { publicGet, validatePublicUrl } from './public-fetch';
import { ApiError } from './http';
import { normalizeGtin, type SearchProduct } from './validation';
import { reserveSource } from './database';
import { sourceFailure } from './source-policy';

export const obj = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
export const str = (value: unknown): string =>
  typeof value === 'string' ? value.slice(0, 500) : '';
export const candidateId = (url: string) =>
  createHash('sha256').update(url).digest('hex').slice(0, 20);
/** Canonical Zakaz product routes contain the source's GTIN after '--'. */
export function zakazProductGtin(url: string): string | undefined {
  const source = new URL(url);
  if (!/^(?:metro|bonus|novus|auchan|tavriav)\.zakaz\.(?:md|ua)$/.test(source.hostname))
    return undefined;
  const code = source.pathname.match(/\/products\/[^/]+--(\d{8,14})\/?$/)?.[1];
  return code && normalizeGtin(code) ? code : undefined;
}
export function safeUrl(value: unknown, base?: string): string | null {
  if (typeof value !== 'string') return null;
  try {
    return validatePublicUrl(new URL(value, base).href).href;
  } catch {
    return null;
  }
}

const hostTails = new Map<
  string,
  { tail: Promise<void>; started: number; unavailableUntil: number }
>();
export async function paced<T>(host: string, interval: number, job: () => Promise<T>): Promise<T> {
  let state = hostTails.get(host);
  if (!state) {
    state = { tail: Promise.resolve(), started: 0, unavailableUntil: 0 };
    hostTails.set(host, state);
  }
  const previous = state.tail;
  let release!: () => void;
  state.tail = new Promise((resolve) => {
    release = resolve;
  });
  await previous;
  try {
    if (state.unavailableUntil > Date.now())
      throw new ApiError(
        503,
        `Источник временно пропущен. Повтор доступен через ${Math.ceil((state.unavailableUntil - Date.now()) / 1000)} сек.`,
        state.unavailableUntil - Date.now(),
      );
    const wait = state.started + interval - Date.now();
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
    state.started = Date.now();
    await reserveSource(host, interval);
    try {
      return await job();
    } catch (error) {
      if (error instanceof ApiError && error.retryAfterMs !== undefined)
        state.unavailableUntil = Date.now() + error.retryAfterMs;
      else if (!(error instanceof ApiError) || [502, 504].includes(error.status))
        state.unavailableUntil = Date.now() + 60000;
      throw error;
    }
  } finally {
    release();
  }
}

export async function publicJson(url: string, interval = 700): Promise<unknown> {
  return paced(new URL(url).hostname, interval, async () => {
    const response = await publicGet(url, {
      maxBytes: 1_500_000,
      timeoutMs: 9000,
      accept: 'application/json',
    });
    if (response.status === 404) return { status: 0, results: [], items: [] };
    if (response.status !== 200)
      throw await sourceFailure(
        url,
        response,
        response.status === 429
          ? 'Квота источника исчерпана.'
          : `Источник ответил HTTP ${response.status}.`,
      );
    try {
      const data: unknown = JSON.parse(response.body.toString('utf8'));
      if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error();
      return data;
    } catch {
      throw new ApiError(502, 'Источник вернул некорректный JSON.');
    }
  });
}

export async function publicHtml(url: string): Promise<string> {
  return paced(new URL(url).hostname, 700, async () => {
    const response = await publicGet(url, {
      maxBytes: 2_000_000,
      timeoutMs: 9000,
      accept: 'text/html',
    });
    if (response.status !== 200)
      throw await sourceFailure(
        url,
        response,
        `Страница источника недоступна (HTTP ${response.status}).`,
      );
    if (!response.headers['content-type']?.includes('text/html'))
      throw new ApiError(502, 'Источник вернул некорректный формат HTML.');
    return response.body.toString('utf8');
  });
}

export function catalogProducts(
  html: string,
  pageUrl: string,
  product: SearchProduct,
  allowUnverified = false,
): Candidate[] {
  const $ = load(html);
  const candidates: Candidate[] = [];
  const expected = product.ean ? normalizeGtin(product.ean) : null;
  let count = 0;
  const walk = (value: unknown, depth = 0): void => {
    if (depth > 8 || count++ > 200 || candidates.length >= 5) return;
    if (Array.isArray(value)) {
      value.slice(0, 40).forEach((node) => walk(node, depth + 1));
      return;
    }
    const node = obj(value);
    const types = Array.isArray(node['@type']) ? node['@type'] : [node['@type']];
    if (types.some((type) => typeof type === 'string' && /(?:^|[/#])Product$/.test(type))) {
      const gtins = ['gtin', 'gtin8', 'gtin12', 'gtin13', 'gtin14']
        .map((key) => str(node[key]))
        .filter((value) => normalizeGtin(value));
      const gtin = gtins.find((value) => normalizeGtin(value) === expected) || gtins[0];
      if (expected && gtin && normalizeGtin(gtin) !== expected) return;
      const exact = !!expected && !!gtin && normalizeGtin(gtin) === expected;
      if (!exact && !allowUnverified) return;
      const title = str(node.name);
      const weight = obj(node.weight);
      const quantity =
        str(node.size) ||
        (weight.value !== undefined
          ? `${String(weight.value)} ${str(weight.unitText) || { GRM: 'g', KGM: 'kg', MLT: 'ml', LTR: 'l' }[str(weight.unitCode)] || ''}`
          : '') ||
        title;
      for (const image of (Array.isArray(node.image) ? node.image : [node.image]).slice(0, 3)) {
        const imageUrl = safeUrl(
          typeof image === 'string' ? image : obj(image).url || obj(image).contentUrl,
          pageUrl,
        );
        if (
          !imageUrl ||
          !title ||
          /(?:instagram|facebook|twitter|favicon|logo|icon)(?:[._/?-]|$)/i.test(
            new URL(imageUrl).pathname,
          )
        )
          continue;
        candidates.push({
          id: candidateId(imageUrl),
          title,
          brand: str(node.brand) || str(obj(node.brand).name),
          quantity,
          gtin,
          imageUrl,
          pageUrl,
          source: new URL(pageUrl).hostname,
          rights: 'unknown',
          gtinExact: exact,
          warnings: [
            exact
              ? 'GTIN связан с фотографией в карточке источника.'
              : 'В карточке нет подтверждённого EAN: проверьте вариант упаковки.',
            'Права использования требуют подтверждения.',
          ],
        });
      }
    }
    if (node['@graph']) walk(node['@graph'], depth + 1);
    if (node.mainEntity) walk(node.mainEntity, depth + 1);
  };
  $('script[type="application/ld+json"]').each((_, element) => {
    const text = $(element).text();
    if (text.length > 200_000) return;
    try {
      walk(JSON.parse(text));
    } catch {}
  });
  return candidates;
}
