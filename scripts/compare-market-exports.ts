import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import JSZip from 'jszip';
import { normalizeGtin } from '../src/lib/gtin';
import { rowSearchError } from '../src/lib/row-search';
import { isSupplierMarket, type SupplierMarket } from '../src/lib/search-sources';
import type { Candidate, ProductRow, SearchDiagnostic, SearchOptions } from '../src/lib/types';
import { percentile } from './baseline-stats';

const verdicts = ['usable_md', 'wrong_sku', 'wrong_packaging', 'unusable'] as const;
type Verdict = (typeof verdicts)[number];

type ExportedCandidate = Pick<Candidate, 'id' | 'title' | 'imageUrl' | 'pageUrl'> & {
  sourceMarket: Candidate['sourceMarket'] | null;
  matchStatus: Candidate['matchStatus'] | null;
  sourceImageHash: string | null;
};
type ManifestRow = Pick<
  ProductRow,
  | 'sourceRow'
  | 'sku'
  | 'internalCode'
  | 'ean'
  | 'nameRu'
  | 'nameRo'
  | 'brand'
  | 'quantity'
  | 'status'
> & {
  searchByName: boolean;
  searchOptions: SearchOptions | null;
  searchDiagnostics: SearchDiagnostic[];
  searchCoverage: ProductRow['searchCoverage'] | null;
  searchElapsedMs: number | null;
  firstUsablePhotoMs: number | null;
  candidates: ExportedCandidate[];
};
export interface MarketManifest {
  version: 1;
  batchId: string;
  totalRows: number;
  rows: ManifestRow[];
}

interface SearchRun {
  requests: number;
  marketQueries: number;
  elapsedMs: number;
  firstPhotoMs: number | null;
  partial: boolean;
  candidates: ExportedCandidate[];
}
interface PairedRow {
  sourceRow: number;
  sku: string;
  ean: string;
  nameRu: string;
  nameRo: string;
  quantity: string;
  lookup: 'gtin' | 'name';
  moldova: SearchRun;
  expanded: SearchRun;
}
type Arm = 'moldova' | 'expanded';

const hasDuration = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0;
const inputKey = (row: ManifestRow) => [
  row.sku,
  row.internalCode,
  row.ean,
  row.nameRu,
  row.nameRo,
  row.brand,
  row.quantity,
  row.searchByName,
];

function indexManifest(manifest: MarketManifest): Map<number, ManifestRow> {
  if (
    manifest?.version !== 1 ||
    typeof manifest.batchId !== 'string' ||
    !Array.isArray(manifest.rows) ||
    !manifest.rows.length ||
    manifest.totalRows !== manifest.rows.length
  )
    throw new Error('Ожидается полный manifest.json версии 1 из архива Shelf.');
  const rows = new Map<number, ManifestRow>();
  for (const row of manifest.rows) {
    if (
      !Number.isInteger(row?.sourceRow) ||
      row.sourceRow < 1 ||
      rows.has(row.sourceRow) ||
      inputKey(row)
        .slice(0, 7)
        .some((value) => typeof value !== 'string') ||
      typeof row.searchByName !== 'boolean'
    )
      throw new Error('В manifest.json есть неполная или повторяющаяся исходная строка.');
    rows.set(row.sourceRow, row);
  }
  return rows;
}

function readRun(row: ManifestRow, market?: SupplierMarket): SearchRun {
  if (
    !['review', 'ready', 'not_found', 'deferred'].includes(row.status) ||
    !hasDuration(row.searchElapsedMs) ||
    !['complete', 'partial'].includes(row.searchCoverage ?? '') ||
    !Array.isArray(row.searchDiagnostics) ||
    !row.searchDiagnostics.length ||
    !Array.isArray(row.candidates) ||
    row.searchDiagnostics.some(
      (source) =>
        typeof source?.id !== 'string' ||
        source.id === 'cache' ||
        source.id === 'library' ||
        (source.requests !== undefined &&
          (!Number.isInteger(source.requests) || source.requests < 0)) ||
        (source.attempts !== undefined && !Array.isArray(source.attempts)),
    ) ||
    (row.firstUsablePhotoMs != null &&
      (!hasDuration(row.firstUsablePhotoMs) || row.firstUsablePhotoMs > row.searchElapsedMs))
  )
    throw new Error(`Строка ${row.sourceRow}: нужен завершённый поиск с замером времени без кэша.`);
  const candidates = row.candidates.slice(0, 3);
  if (
    candidates.some((item) => typeof item?.id !== 'string' || typeof item.imageUrl !== 'string') ||
    new Set(candidates.map(({ id }) => id)).size !== candidates.length
  )
    throw new Error(`Строка ${row.sourceRow}: некорректные кандидаты в manifest.json.`);
  return {
    requests: row.searchDiagnostics.reduce(
      (sum, source) => sum + (source.requests ?? source.attempts?.length ?? 0),
      0,
    ),
    marketQueries: market
      ? row.searchDiagnostics.reduce(
          (sum, source) =>
            ['brave', 'tavily'].includes(source.id) ||
            (market === 'UA' && source.id.endsWith('-ua'))
              ? sum + (source.attempts?.length ?? 0)
              : sum,
          0,
        )
      : 0,
    elapsedMs: row.searchElapsedMs,
    firstPhotoMs: hasDuration(row.firstUsablePhotoMs) ? row.firstUsablePhotoMs : null,
    partial: row.searchCoverage === 'partial',
    candidates,
  };
}

export function pairMarketExports(
  market: SupplierMarket,
  moldova: MarketManifest,
  expanded: MarketManifest,
) {
  const base = indexManifest(moldova);
  const other = indexManifest(expanded);
  if (base.size !== other.size) throw new Error('В экспортах разное число исходных строк.');
  const excluded: { sourceRow: number; reason: string }[] = [];
  const rows: PairedRow[] = [];
  for (const [sourceRow, a] of base) {
    const b = other.get(sourceRow);
    if (!b || JSON.stringify(inputKey(a)) !== JSON.stringify(inputKey(b)))
      throw new Error(`Строка ${sourceRow}: изменились данные товара или режим GTIN/названия.`);
    const reason = rowSearchError(a, a.searchByName);
    if (reason) {
      excluded.push({ sourceRow, reason });
      continue;
    }
    const left = a.searchOptions;
    const right = b.searchOptions;
    if (
      left?.mode !== 'moldova' ||
      right?.mode !== 'expanded' ||
      right.market !== market ||
      left.useCache !== false ||
      right.useCache !== false ||
      typeof left.useWeb !== 'boolean' ||
      left.useWeb !== right.useWeb ||
      ![1, 2, 4, 6].includes(left.webQueryLimit) ||
      left.webQueryLimit !== right.webQueryLimit
    )
      throw new Error(
        `Строка ${sourceRow}: нужны Молдова и ${market}, одинаковый веб-лимит и отключённый кэш.`,
      );
    rows.push({
      sourceRow,
      sku: a.sku,
      ean: a.ean,
      nameRu: a.nameRu,
      nameRo: a.nameRo,
      quantity: a.quantity,
      lookup: !a.searchByName && normalizeGtin(a.ean) ? 'gtin' : 'name',
      moldova: readRun(a),
      expanded: readRun(b, market),
    });
  }
  if (!rows.length) throw new Error('В экспортах нет позиций с корректными данными поиска.');
  const comparisonId = createHash('sha256')
    .update(
      JSON.stringify({ market, batches: [moldova.batchId, expanded.batchId], rows, excluded }),
    )
    .digest('hex');
  return { market, comparisonId, sourceRows: base.size, rows, excluded };
}

type Comparison = ReturnType<typeof pairMarketExports>;
interface ReviewCandidate extends ExportedCandidate {
  verdict: Verdict | null;
}
interface ReviewRow extends Pick<
  PairedRow,
  'sourceRow' | 'sku' | 'ean' | 'nameRu' | 'nameRo' | 'quantity'
> {
  referenceAvailable: boolean | null;
  moldova: ReviewCandidate[];
  expanded: ReviewCandidate[];
}
interface Review {
  comparisonId: string;
  rows: ReviewRow[];
}

export function createReviewTemplate(comparison: Comparison): Review {
  return {
    comparisonId: comparison.comparisonId,
    rows: comparison.rows.map((row) => ({
      sourceRow: row.sourceRow,
      sku: row.sku,
      ean: row.ean,
      nameRu: row.nameRu,
      nameRo: row.nameRo,
      quantity: row.quantity,
      referenceAvailable: null,
      moldova: row.moldova.candidates.map((candidate) => ({ ...candidate, verdict: null })),
      expanded: row.expanded.candidates.map((candidate) => ({ ...candidate, verdict: null })),
    })),
  };
}

const rate = (hits: number, total: number) => ({
  hits,
  total,
  percent: total ? (100 * hits) / total : null,
});
const timing = (values: number[]) => ({
  n: values.length,
  p50Ms: percentile(values, 0.5),
  p95Ms: percentile(values, 0.95),
});

export function summarizeMarketExports(comparison: Comparison, review: Review) {
  if (
    review?.comparisonId !== comparison.comparisonId ||
    !Array.isArray(review.rows) ||
    review.rows.length !== comparison.rows.length
  )
    throw new Error('Разметка относится к другой паре экспортов или заполнена не для всех строк.');
  const byLine = new Map(review.rows.map((row) => [row.sourceRow, row]));
  const rows = comparison.rows.map((row) => {
    const labels = byLine.get(row.sourceRow);
    if (typeof labels?.referenceAvailable !== 'boolean')
      throw new Error(`Строка ${row.sourceRow}: укажите наличие доступного эталонного фото.`);
    for (const arm of ['moldova', 'expanded'] as const) {
      const expected = row[arm].candidates;
      const decisions = labels[arm];
      if (
        !Array.isArray(decisions) ||
        decisions.length !== expected.length ||
        expected.some((candidate, index) => {
          const label = decisions[index];
          return label?.id !== candidate.id || !verdicts.includes(label.verdict as Verdict);
        })
      )
        throw new Error(`Строка ${row.sourceRow}, ${arm}: укажите решение по каждому кандидату.`);
    }
    return { row, labels };
  });
  const cohorts = [
    { lookup: 'all', members: rows },
    { lookup: 'gtin', members: rows.filter(({ row }) => row.lookup === 'gtin') },
    { lookup: 'name', members: rows.filter(({ row }) => row.lookup === 'name') },
  ];
  return {
    market: comparison.market,
    comparisonId: comparison.comparisonId,
    sourceRows: comparison.sourceRows,
    excluded: comparison.excluded,
    cohorts: cohorts.map(({ lookup, members }) => {
      const usable = (labels: ReviewCandidate[]) =>
        labels.some(({ verdict }) => verdict === 'usable_md');
      const stats = (arm: Arm) => {
        const highConfidence = members.filter(({ row }) => {
          const first = row[arm].candidates[0];
          return first?.matchStatus === 'exact' && !!first.sourceImageHash;
        });
        const withReference = members.filter(({ labels }) => labels.referenceAvailable);
        const decisions = members.flatMap(({ labels }) => labels[arm]);
        return {
          requests: members.reduce((sum, { row }) => sum + row[arm].requests, 0),
          partial: members.filter(({ row }) => row[arm].partial).length,
          usableAt3: members.filter(({ labels }) => usable(labels[arm])).length,
          wrongSku: decisions.filter(({ verdict }) => verdict === 'wrong_sku').length,
          wrongPackaging: decisions.filter(({ verdict }) => verdict === 'wrong_packaging').length,
          precisionAt1: rate(
            highConfidence.filter(({ labels }) => labels[arm][0].verdict === 'usable_md').length,
            highConfidence.length,
          ),
          recallAt3: rate(
            withReference.filter(({ labels }) => usable(labels[arm])).length,
            withReference.length,
          ),
          totalTime: timing(members.map(({ row }) => row[arm].elapsedMs)),
          firstPhotoTime: timing(members.flatMap(({ row }) => row[arm].firstPhotoMs ?? [])),
        };
      };
      const moldova = stats('moldova');
      const expanded = stats('expanded');
      const additionalFromMarket = members.filter(
        ({ row, labels }) =>
          !usable(labels.moldova) &&
          labels.expanded.some(
            ({ verdict }, index) =>
              verdict === 'usable_md' &&
              row.expanded.candidates[index].sourceMarket === comparison.market,
          ),
      ).length;
      return {
        lookup,
        checkedRows: members.length,
        marketAttemptedRows: members.filter(({ row }) => row.expanded.marketQueries > 0).length,
        moldova,
        expanded,
        additionalFromMarket,
        additionalPer100ExpandedRequests: rate(additionalFromMarket, expanded.requests).percent,
        moldovaOnly: members.filter(
          ({ labels }) => usable(labels.moldova) && !usable(labels.expanded),
        ).length,
      };
    }),
  };
}

async function readManifest(file: string): Promise<MarketManifest> {
  const archive = await JSZip.loadAsync(await readFile(file));
  const manifest = archive.file('manifest.json');
  if (!manifest) throw new Error('В ZIP отсутствует manifest.json.');
  return JSON.parse(await manifest.async('string')) as MarketManifest;
}

async function main(args: string[]) {
  const [market, moldovaZip, marketZip, reviewJson] = args;
  if (!isSupplierMarket(market) || !moldovaZip || !marketZip || args.length > 4)
    throw new Error(
      'Использование: compare-market-exports.ts UA|RO md.zip market.zip [review.json]',
    );
  const [moldova, expanded] = await Promise.all([
    readManifest(moldovaZip),
    readManifest(marketZip),
  ]);
  const comparison = pairMarketExports(market, moldova, expanded);
  const result = reviewJson
    ? summarizeMarketExports(
        comparison,
        JSON.parse((await readFile(reviewJson, 'utf8')).replace(/^\uFEFF/, '')),
      )
    : createReviewTemplate(comparison);
  console.log(JSON.stringify(result, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : 'Не удалось сравнить экспорты Shelf.');
    process.exitCode = 1;
  });
}
