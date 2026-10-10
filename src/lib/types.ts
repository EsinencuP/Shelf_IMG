export type RowStatus =
  'pending' | 'searching' | 'review' | 'processing' | 'ready' | 'not_found' | 'error';
export type RightsStatus = 'open_license' | 'unknown' | 'user_owned';

export interface Candidate {
  id: string;
  title: string;
  brand?: string;
  quantity?: string;
  gtin?: string;
  imageUrl: string;
  pageUrl: string;
  source: string;
  rights: RightsStatus;
  license?: string;
  gtinExact: boolean;
  warnings: string[];
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
  lastSearchOptions?: SearchOptions;
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
}

export const DEFAULT_SEARCH_OPTIONS: SearchOptions = {
  mode: 'expanded',
  useWeb: true,
  webQueryLimit: 4,
};

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
}
export interface SearchDiagnostic {
  id: string;
  source: string;
  status: 'ok' | 'unavailable' | 'skipped' | 'not_configured';
  count: number;
  elapsedMs: number;
  requests?: number;
  message?: string;
}
export interface AppConfig {
  braveConfigured: boolean;
  geminiConfigured: boolean;
  accessProtected: boolean;
  serverReady?: boolean;
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
  error: 'Ошибка',
};
