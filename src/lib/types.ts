import type { SupplierMarket } from './search-sources';

export type RowStatus =
  'pending' | 'searching' | 'review' | 'processing' | 'ready' | 'not_found' | 'deferred' | 'error';
export type RightsStatus = 'open_license' | 'unknown' | 'user_owned';

export interface SourcePhotoCheck {
  /** Digest of downloaded bytes. Dimensions and MIME describe the decoded raster. */
  sha256: string;
  mime: string;
  width: number;
  height: number;
  checkedAt: string;
}

export interface Candidate {
  id: string;
  title: string;
  brand?: string;
  quantity?: string;
  gtin?: string;
  imageUrl: string;
  previewUrl?: string;
  pageUrl: string;
  source: string;
  rights: RightsStatus;
  license?: string;
  gtinExact: boolean;
  warnings: string[];
  matchStatus?: 'exact' | 'probable' | 'metadata_conflict' | 'rejected';
  matchReasons?: string[];
  sourceMarket?: 'MD' | SupplierMarket;
  sourceImageHash?: string;
  sourcePhotoCheck?: SourcePhotoCheck;
}

export interface ProductRow {
  id: string;
  sourceRow: number;
  sku: string;
  internalCode: string;
  ean: string;
  nameRu: string;
  nameRo: string;
  brand: string;
  quantity: string;
  widthMm?: number;
  heightMm?: number;
  depthMm?: number;
  status: RowStatus;
  candidates: Candidate[];
  selectedCandidateId?: string;
  originalBlob?: Blob;
  outputBlob?: Blob;
  outputWidth?: number;
  outputHeight?: number;
  confirmed?: boolean;
  rightsConfirmed?: boolean;
  processingMethod?: string;
  processingOverride?: 'ai' | 'white';
  inputWarnings?: string[];
  vision?: VisionResult;
  qualityWarnings: string[];
  searchDiagnostics?: SearchDiagnostic[];
  searchCoverage?: 'complete' | 'partial';
  lastSearchOptions?: SearchOptions;
  searchJobId?: string;
  searchRequestKey?: string;
  searchRefresh?: boolean;
  searchByName?: boolean;
  searchJobMessage?: string;
  libraryId?: string;
  error?: string;
}

export interface ExportProfile {
  naming: 'sku' | 'internalCode';
  maxSide: number;
  quality: number;
  background: '#ffffff';
  method: 'ai' | 'white';
}

export interface Batch {
  id: string;
  name: string;
  createdAt: string;
  rows: ProductRow[];
  profile: ExportProfile;
  searchOptions?: SearchOptions;
}

export interface SearchOptions {
  mode: 'moldova' | 'expanded';
  useWeb: boolean;
  webQueryLimit: number;
  useCache?: boolean;
  market?: SupplierMarket;
  marketName?: string;
}

export const DEFAULT_SEARCH_OPTIONS: SearchOptions = {
  mode: 'expanded',
  useWeb: true,
  webQueryLimit: 4,
  useCache: true,
};
export const MAX_JOB_SUBMISSION = 1000;

export type ImportField =
  | 'sku'
  | 'internalCode'
  | 'ean'
  | 'nameRu'
  | 'nameRo'
  | 'brand'
  | 'quantity'
  | 'widthMm'
  | 'heightMm'
  | 'depthMm';
export type ColumnMapping = Partial<Record<ImportField, number>>;
export interface ParsedSheet {
  name: string;
  headers: string[];
  rows: string[][];
  warnings: string[];
}
export interface SearchResponse {
  candidates: Candidate[];
  warnings: string[];
  diagnostics?: SearchDiagnostic[];
  /** Current server execution, including cache lookup and orchestration (not a sum of source times). */
  elapsedMs?: number;
  /** Time from search start to the first decoded photo of an exact match, on a fresh search. */
  firstUsablePhotoMs?: number;
  outcome?: 'found' | 'review' | 'not_found' | 'deferred';
  coverage?: 'complete' | 'partial';
  retryable?: boolean;
}
export type SourceStatus =
  'ok' | 'empty' | 'blocked' | 'timeout' | 'quota' | 'parse_error' | 'disabled' | 'relay_offline';

export interface SearchAttempt {
  query: string;
  status: SourceStatus;
  count: number;
  elapsedMs: number;
  reason?: string;
  httpStatus?: number;
  retryAfterMs?: number;
}

export interface SearchDiagnostic extends Omit<SearchAttempt, 'query'> {
  id: string;
  source: string;
  requests?: number;
  message?: string;
  attempts?: SearchAttempt[];
}
export interface AppConfig {
  braveConfigured: boolean;
  braveFreeOnlyConfirmed?: boolean;
  tavilyConfigured?: boolean;
  geminiConfigured: boolean;
  accessProtected: boolean;
  serverReady?: boolean;
  databaseConfigured?: boolean;
  cloudWorkerConfigured?: boolean;
  build?: { commit: string | null; fingerprint: string | null; deploymentId: string | null };
}
export interface VisionResult {
  verdict: 'consistent' | 'conflict' | 'uncertain';
  brand: string;
  quantity: string;
  variant: string;
  reasons: string[];
}

export const DEFAULT_PROFILE: ExportProfile = {
  naming: 'sku',
  maxSide: 1600,
  quality: 0.95,
  background: '#ffffff',
  method: 'ai',
};
export const STATUS_LABELS: Record<RowStatus, string> = {
  pending: 'Ожидает поиска',
  searching: 'Идёт поиск',
  review: 'На проверке',
  processing: 'Обработка',
  ready: 'Готово',
  not_found: 'Не найдено',
  deferred: 'Повторить позже',
  error: 'Ошибка',
};
