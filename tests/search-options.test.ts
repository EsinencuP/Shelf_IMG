import { afterEach, describe, expect, it, vi } from 'vitest';
import { searchProducts } from '@/lib/server/search';
import { validateSearchOptions } from '@/lib/server/validation';
import { publicJson, publicHtml } from '@/lib/server/catalog-utils';
import { searchSupplementalCatalogs } from '@/lib/server/supplemental-search';
import { DEFAULT_SEARCH_OPTIONS } from '@/lib/types';
import {
  DEFAULT_PREFERENCES,
  readPreferences,
  savePreferences,
  processingChanged,
} from '@/lib/preferences';
import { POST } from '@/app/api/search/route';

vi.mock('@/lib/server/catalog-utils', async (original) => ({
  ...(await original<typeof import('@/lib/server/catalog-utils')>()),
  publicJson: vi.fn(async () => ({ results: [] })),
  publicHtml: vi.fn(async () => '<html></html>'),
}));
vi.mock('@/lib/server/supplemental-search', async (original) => ({
  ...(await original<typeof import('@/lib/server/supplemental-search')>()),
  searchSupplementalCatalogs: vi.fn(async () => ({ candidates: [], diagnostics: [] })),
}));
const product = { ean: '', nameRu: 'Творог JLC 500 г', nameRo: '', brand: 'JLC', quantity: '500g' };
afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('search modes and API budgets', () => {
  it('omitted options preserve expanded coverage and invalid budgets cannot reach providers', async () => {
    expect(validateSearchOptions(undefined)).toEqual(DEFAULT_SEARCH_OPTIONS);
    for (const options of [
      null,
      [],
      { mode: 'anything' },
      { useWeb: 'false' },
      { webQueryLimit: 100 },
      { webQueryLimit: '1' },
    ]) {
      expect(() => validateSearchOptions(options)).toThrow();
    }
    vi.stubEnv('NODE_ENV', 'development');
    vi.stubEnv('MVP_ACCESS_PASSWORD', '');
    const response = await POST(
      new Request('https://shelf.site/api/search', {
        method: 'POST',
        headers: { Origin: 'https://shelf.site', 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...product, searchOptions: { webQueryLimit: 100 } }),
      }),
    );
    expect(response.status).toBe(422);
    expect(publicJson).not.toHaveBeenCalled();
  });
  it('Moldova mode actually avoids foreign catalogs, supplementary lookups and configured Brave', async () => {
    vi.stubEnv('BRAVE_SEARCH_API_KEY', 'test-key');
    const fetcher = vi.fn();
    vi.stubGlobal('fetch', fetcher);
    const result = await searchProducts(product, { ...DEFAULT_SEARCH_OPTIONS, mode: 'moldova' });
    const urls = vi.mocked(publicJson).mock.calls.map(([url]) => url);
    expect(urls.length).toBeGreaterThan(0);
    expect(urls.every((url) => new URL(url).hostname === 'stores-api.zakaz.md')).toBe(true);
    expect(publicHtml).toHaveBeenCalled();
    expect(searchSupplementalCatalogs).not.toHaveBeenCalled();
    expect(fetcher).not.toHaveBeenCalled();
    expect(result.diagnostics?.find((source) => source.id === 'metro-ua')).toMatchObject({
      status: 'skipped',
      elapsedMs: 0,
    });
    expect(result.diagnostics?.find((source) => source.id === 'brave')).toMatchObject({
      status: 'skipped',
    });
  });
  it('expanded mode restores foreign catalogs without calling Brave when disabled', async () => {
    vi.stubEnv('BRAVE_SEARCH_API_KEY', 'test-key');
    const fetcher = vi.fn();
    vi.stubGlobal('fetch', fetcher);
    const result = await searchProducts(product, { ...DEFAULT_SEARCH_OPTIONS, useWeb: false });
    expect(
      vi
        .mocked(publicJson)
        .mock.calls.some(([url]) => new URL(url).hostname === 'stores-api.zakaz.ua'),
    ).toBe(true);
    expect(searchSupplementalCatalogs).toHaveBeenCalledOnce();
    expect(fetcher).not.toHaveBeenCalled();
    expect(result.diagnostics?.find((source) => source.id === 'metro-ua')?.status).toBe('ok');
  });
  it('client request budget can reduce the server budget to one image/web pair', async () => {
    vi.stubEnv('BRAVE_SEARCH_API_KEY', 'test-key');
    vi.stubEnv('SEARCH_MAX_WEB_QUERIES', '6');
    const fetcher = vi.fn(async () => Response.json({ results: [], web: { results: [] } }));
    vi.stubGlobal('fetch', fetcher);
    await searchProducts(product, { ...DEFAULT_SEARCH_OPTIONS, webQueryLimit: 1 });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
});

describe('persistent browser defaults', () => {
  function storage() {
    const data = new Map<string, string>();
    const target = {
      getItem: (key: string) => data.get(key) ?? null,
      setItem: (key: string, value: string) => data.set(key, value),
    };
    vi.stubGlobal('localStorage', target);
    return target;
  }
  it('saves validated settings and contains no credentials', () => {
    const target = storage();
    const settings = {
      profile: { ...DEFAULT_PREFERENCES.profile, quality: 0.9 },
      search: { ...DEFAULT_SEARCH_OPTIONS, mode: 'moldova' as const },
    };
    savePreferences(settings);
    expect(readPreferences()).toEqual(settings);
    expect(target.getItem('shelf-studio.preferences.v1')).not.toMatch(/password|api.?key/i);
  });
  it('recovers corrupt, unavailable or unknown-version preferences', () => {
    const target = storage();
    for (const value of [
      '{broken',
      JSON.stringify({ version: 9 }),
      JSON.stringify({
        version: 1,
        profile: { maxSide: -1, quality: 4 },
        search: { webQueryLimit: 100 },
      }),
    ]) {
      target.setItem('shelf-studio.preferences.v1', value);
      expect(readPreferences()).toEqual(DEFAULT_PREFERENCES);
    }
    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new Error('blocked');
      },
    });
    expect(readPreferences()).toEqual(DEFAULT_PREFERENCES);
  });
  it('changing output pixels invalidates approvals; renaming does not', () => {
    const profile = DEFAULT_PREFERENCES.profile;
    expect(processingChanged(profile, { ...profile, naming: 'internalCode' })).toBe(false);
    expect(processingChanged(profile, { ...profile, quality: 0.9 })).toBe(true);
    expect(processingChanged(profile, { ...profile, maxSide: 2400 })).toBe(true);
    expect(processingChanged(profile, { ...profile, method: 'white' })).toBe(true);
  });
});
