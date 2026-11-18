import { describe, expect, it } from 'vitest';
import {
  createReviewTemplate,
  pairMarketExports,
  summarizeMarketExports,
  type MarketManifest,
} from '../scripts/compare-market-exports';

type ManifestRow = MarketManifest['rows'][number];
type ExportedCandidate = ManifestRow['candidates'][number];

function photo(id: string, market: 'MD' | 'UA', exact = true): ExportedCandidate {
  return {
    id,
    title: 'Контрольная упаковка',
    imageUrl: `https://example.com/${id}.jpg`,
    pageUrl: `https://example.com/${id}`,
    sourceMarket: market,
    matchStatus: exact ? 'exact' : 'probable',
    sourceImageHash: exact ? 'checked' : null,
  };
}

function manifest(expanded = false): MarketManifest {
  const row: ManifestRow = {
    sourceRow: 2,
    sku: '00001',
    internalCode: '0012',
    ean: '3017620422003',
    nameRu: 'Паста Nutella 400 г',
    nameRo: '',
    brand: 'Ferrero',
    quantity: '400g',
    status: 'review',
    searchByName: false,
    searchOptions: {
      mode: expanded ? 'expanded' : 'moldova',
      useWeb: true,
      webQueryLimit: 2,
      useCache: false,
      ...(expanded ? { market: 'UA' } : {}),
    },
    searchCoverage: expanded ? 'partial' : 'complete',
    searchElapsedMs: expanded ? 110 : 34,
    firstUsablePhotoMs: expanded ? 20 : 25,
    searchDiagnostics: [
      { id: 'linella', source: 'Linella', requests: 2, status: 'ok', count: 1, elapsedMs: 15 },
      ...(expanded
        ? [
            {
              id: 'brave',
              source: 'Brave',
              status: 'ok' as const,
              count: 1,
              elapsedMs: 30,
              requests: 3,
              attempts: [{ query: 'control', status: 'ok' as const, count: 1, elapsedMs: 9 }],
            },
          ]
        : []),
    ],
    candidates: expanded
      ? [photo('ua-verified', 'UA'), photo('ua-other', 'UA', false)]
      : [photo('md-different-design', 'MD')],
  };
  return {
    version: 1,
    batchId: expanded ? 'supplier' : 'moldova',
    totalRows: 3,
    rows: [
      row,
      {
        ...row,
        sourceRow: 3,
        ean: '',
        firstUsablePhotoMs: null,
        candidates: [photo('md-name-only', 'MD', false)],
      },
      { ...row, sourceRow: 4, ean: 'x', candidates: [], searchOptions: null, status: 'error' },
    ],
  };
}

describe('paired market QA exports', () => {
  it('counts reviewed Moldova-compatible photos and measures the same physical rows by lookup type', () => {
    const comparison = pairMarketExports('UA', manifest(), manifest(true));
    const review = createReviewTemplate(comparison);
    expect(review.rows[0]).toMatchObject({ sourceRow: 2, sku: '00001', ean: '3017620422003' });
    review.rows[0].referenceAvailable = true;
    review.rows[0].moldova[0].verdict = 'wrong_packaging';
    review.rows[0].expanded[0].verdict = 'usable_md';
    review.rows[0].expanded[1].verdict = 'wrong_sku';
    review.rows[1].referenceAvailable = false;
    review.rows[1].moldova[0].verdict = 'usable_md';
    review.rows[1].expanded[0].verdict = 'unusable';

    const summary = summarizeMarketExports(comparison, review);
    expect(summary.sourceRows).toBe(3);
    expect(summary.excluded).toMatchObject([{ sourceRow: 4 }]);
    expect(summary.cohorts[0]).toMatchObject({
      lookup: 'all',
      checkedRows: 2,
      marketAttemptedRows: 2,
      additionalFromMarket: 1,
      additionalPer100ExpandedRequests: 10,
      moldovaOnly: 1,
      moldova: {
        wrongPackaging: 1,
        requests: 4,
        precisionAt1: { hits: 0, total: 1, percent: 0 },
        recallAt3: { hits: 0, total: 1, percent: 0 },
      },
      expanded: {
        wrongSku: 1,
        requests: 10,
        partial: 2,
        precisionAt1: { hits: 1, total: 1, percent: 100 },
        recallAt3: { hits: 1, total: 1, percent: 100 },
        firstPhotoTime: { n: 1, p95Ms: 20 },
        totalTime: { n: 2, p95Ms: 110 },
      },
    });
    expect(summary.cohorts[1]).toMatchObject({
      lookup: 'gtin',
      checkedRows: 1,
      additionalFromMarket: 1,
    });
    expect(summary.cohorts[2]).toMatchObject({
      lookup: 'name',
      checkedRows: 1,
      additionalFromMarket: 0,
      expanded: { recallAt3: { hits: 0, total: 0, percent: null } },
    });
  });

  it('rejects altered product rows, different budgets, and missing measurements', () => {
    const varied = manifest(true);
    varied.rows[0].quantity = '500g';
    expect(() => pairMarketExports('UA', manifest(), varied)).toThrow('изменились данные товара');
    const budget = manifest(true);
    budget.rows[0].searchOptions!.webQueryLimit = 6;
    expect(() => pairMarketExports('UA', manifest(), budget)).toThrow('одинаковый веб-лимит');
    const noTiming = manifest(true);
    noTiming.rows[0].searchElapsedMs = null;
    expect(() => pairMarketExports('UA', manifest(), noTiming)).toThrow('замером времени без кэша');
  });

  it('rejects partial labels and labels for a different search', () => {
    const comparison = pairMarketExports('UA', manifest(), manifest(true));
    const template = createReviewTemplate(comparison);
    expect(() => summarizeMarketExports(comparison, template)).toThrow(
      'доступного эталонного фото',
    );
    template.rows[0].referenceAvailable = true;
    expect(() => summarizeMarketExports(comparison, template)).toThrow('по каждому кандидату');
    const newSearch = manifest(true);
    newSearch.rows[0].searchElapsedMs = 1000;
    const rerun = pairMarketExports('UA', manifest(), newSearch);
    expect(() => summarizeMarketExports(rerun, template)).toThrow('другой паре экспортов');
  });
});
