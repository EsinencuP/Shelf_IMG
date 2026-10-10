import {
  DEFAULT_PROFILE,
  DEFAULT_SEARCH_OPTIONS,
  type ExportProfile,
  type SearchOptions,
} from './types';

export interface Preferences {
  profile: ExportProfile;
  search: SearchOptions;
}
const KEY = 'shelf-studio.preferences.v1';
export const DEFAULT_PREFERENCES: Preferences = {
  profile: DEFAULT_PROFILE,
  search: DEFAULT_SEARCH_OPTIONS,
};

/** Browser-only defaults, separate from each batch; never store API keys or passwords. */
export function readPreferences(): Preferences {
  try {
    const value = JSON.parse(localStorage.getItem(KEY) || 'null');
    if (!value || value.version !== 1) return DEFAULT_PREFERENCES;
    const p = value.profile ?? {},
      s = value.search ?? {};
    return {
      profile: {
        naming: p.naming === 'internalCode' ? 'internalCode' : 'sku',
        maxSide: [1200, 1600, 2400].includes(p.maxSide) ? p.maxSide : 1600,
        quality: [0.9, 0.95, 1].includes(p.quality) ? p.quality : 0.95,
        method: p.method === 'white' ? 'white' : 'ai',
        background: '#ffffff',
      },
      search: {
        mode: s.mode === 'moldova' ? 'moldova' : 'expanded',
        useWeb: typeof s.useWeb === 'boolean' ? s.useWeb : true,
        webQueryLimit: [1, 2, 4, 6].includes(s.webQueryLimit) ? s.webQueryLimit : 4,
      },
    };
  } catch {
    return DEFAULT_PREFERENCES;
  }
}

export function savePreferences(value: Preferences): void {
  localStorage.setItem(KEY, JSON.stringify({ version: 1, ...value }));
}

/** Filename changes do not change pixels. Processing changes invalidate old approvals. */
export function processingChanged(a: ExportProfile, b: ExportProfile): boolean {
  return (
    a.maxSide !== b.maxSide ||
    a.quality !== b.quality ||
    a.method !== b.method ||
    a.background !== b.background
  );
}
