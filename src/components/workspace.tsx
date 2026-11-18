'use client';

import { useEffect, useRef, useState } from 'react';
import {
  ArrowDownToLine,
  ArrowRight,
  Check,
  ChevronRight,
  CircleHelp,
  Clock3,
  CloudUpload,
  Database,
  Download,
  FileSpreadsheet,
  FolderOpen,
  Globe,
  ImageIcon,
  Layers,
  Loader2,
  Plus,
  Search,
  Settings2,
  ShieldCheck,
  Square,
  Trash2,
  X,
} from 'lucide-react';
import type {
  AppConfig,
  Batch,
  ExportProfile,
  ParsedSheet,
  ProductRow,
  RowStatus,
  SearchResponse,
  SearchOptions,
} from '@/lib/types';
import { DEFAULT_PROFILE, DEFAULT_SEARCH_OPTIONS, STATUS_LABELS } from '@/lib/types';
import {
  DEFAULT_PREFERENCES,
  readPreferences,
  restoreSearchOptions,
  savePreferences,
  processingChanged,
  type Preferences,
} from '@/lib/preferences';
import {
  REGIONAL_SOURCES,
  INDEXED_DOMAINS,
  isSupplierMarket,
  SUPPLIER_MARKETS,
} from '@/lib/search-sources';
import { parseFile, downloadTemplate, MAX_IMPORT_ROWS } from '@/lib/import';
import { deleteBatch, listBatches, saveBatch } from '@/lib/storage';
import { exportBatch } from '@/lib/export';
import { apiFetch, ApiRequestError, setAccessPassword } from '@/lib/client-api';
import { rowSearchError, rowSearchProduct, rowTitle } from '@/lib/row-search';
import { matchSupplierPhotos, supplierPhotoPatch } from '@/lib/supplier-photos';
import ImportDialog from './import-dialog';
import SingleProductDialog from './single-product-dialog';
import ReviewPane from './review-pane';
import BlobImage from './blob-image';
import Modal from './modal';

type Tab = 'workspace' | 'history' | 'sources';
type Filter = 'all' | 'review' | 'ready' | 'unresolved';
type ServiceStatus = {
  id: string;
  source: string;
  status: 'ok' | 'unavailable' | 'not_configured';
  message?: string;
};
type SearchServiceStatus = {
  services: ServiceStatus[];
  catalogSize?: number;
  cacheEntries?: number;
};
type JobSnapshot = {
  id: string;
  status: string;
  attempts: number;
  result: SearchResponse;
  error?: string;
  available_at: string;
};
const formatDate = (value: string) =>
  new Intl.DateTimeFormat('ru', {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(value));
const errorText = (reason: unknown) =>
  reason instanceof Error ? reason.message : 'Не удалось выполнить действие.';

async function submitQueuedRows(rows: ProductRow[]) {
  const jobs = rows.map((row) => ({
    ...rowSearchProduct(row),
    searchOptions: row.lastSearchOptions,
    refresh: row.searchRefresh,
    requestKey: row.searchRequestKey,
  }));
  const response = await apiFetch('/api/jobs', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(jobs.length === 1 ? jobs[0] : { jobs }),
  });
  const result = await response.json();
  const ids =
    jobs.length === 1
      ? new Map([[jobs[0].requestKey, result.id as string]])
      : new Map<string | undefined, string>(
          result.jobs.map((job: { request_key: string; id: string }) => [job.request_key, job.id]),
        );
  return new Map(
    rows.map((row) => {
      const id = ids.get(row.searchRequestKey);
      if (!id)
        throw new Error('Сервер не вернул идентификатор задания. Очередь запросит его повторно.');
      return [row.id, { id, workerAwake: result.workerAwake as boolean | undefined }];
    }),
  );
}

export default function Workspace() {
  const [tab, setTab] = useState<Tab>('workspace');
  const [batch, setBatch] = useState<Batch | null>(null);
  const [history, setHistory] = useState<Batch[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [config, setConfig] = useState<AppConfig>({
    braveConfigured: false,
    geminiConfigured: false,
    accessProtected: false,
  });
  const [imported, setImported] = useState<{ sheet: ParsedSheet; filename: string } | null>(null);
  const [singleProductOpen, setSingleProductOpen] = useState(false);
  const [loadingFile, setLoadingFile] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<Filter>('all');
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<Batch | null>(null);
  const [profile, setProfile] = useState<ExportProfile>(DEFAULT_PROFILE);
  const [preferences, setPreferences] = useState<Preferences>(DEFAULT_PREFERENCES);
  const [searchOptions, setSearchOptions] = useState<SearchOptions>(DEFAULT_SEARCH_OPTIONS);
  const [password, setPassword] = useState('');
  const [authBusy, setAuthBusy] = useState(false);
  const [accessVerified, setAccessVerified] = useState(false);
  const [saved, setSaved] = useState(true);
  const [toast, setToast] = useState<{ message: string; error: boolean } | null>(null);
  const [operation, setOperation] = useState<{
    kind: 'search' | 'process';
    total: number;
    done: number;
    message: string;
  } | null>(null);
  const [exporting, setExporting] = useState(false);
  const [panelBusy, setPanelBusy] = useState(false);
  const [switching, setSwitching] = useState(false);
  const [checkingSources, setCheckingSources] = useState(false);
  const [sourceStatus, setSourceStatus] = useState<SearchServiceStatus | null>(null);
  const [sourceStatusError, setSourceStatusError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const supplierFolderRef = useRef<HTMLInputElement>(null);
  const batchRef = useRef<Batch | null>(null);
  const stopRef = useRef(false);
  const controllerRef = useRef<AbortController | null>(null);
  const saveTimerRef = useRef<number | undefined>(undefined);
  const queuePollingRef = useRef(false);
  const queueSubmittingRef = useRef(false);
  const configRef = useRef<AppConfig | null>(null);
  const configPromiseRef = useRef<Promise<AppConfig | null> | null>(null);
  const busy = !!operation || panelBusy || switching;

  function notify(message: string, error = false) {
    setToast({ message, error });
  }
  function requireAccess() {
    setAccessVerified(false);
    setSettingsOpen(true);
  }
  async function checkAccess() {
    setAuthBusy(true);
    try {
      if (password) setAccessPassword(password);
      await apiFetch('/api/session');
      setAccessVerified(true);
      setPassword('');
      notify('Доступ к серверу подтверждён.');
    } catch (error) {
      setAccessPassword('');
      setAccessVerified(false);
      notify(errorText(error), true);
    } finally {
      setAuthBusy(false);
    }
  }
  function changeBatch(value: Batch | null) {
    batchRef.current = value;
    setBatch(value);
  }
  function patchRow(id: string, patch: Partial<ProductRow>) {
    patchRows(new Map([[id, patch]]));
  }
  function patchRows(changes: Map<string, Partial<ProductRow>>) {
    const current = batchRef.current;
    if (!current || !changes.size) return;
    changeBatch({
      ...current,
      rows: current.rows.map((row) => {
        const patch = changes.get(row.id);
        return patch ? { ...row, ...patch } : row;
      }),
    });
  }
  async function persistCurrent() {
    window.clearTimeout(saveTimerRef.current);
    const current = batchRef.current;
    if (!current) return;
    await saveBatch(current);
    if (batchRef.current === current) setSaved(true);
    setHistory((items) =>
      [current, ...items.filter((item) => item.id !== current.id)].sort((a, b) =>
        b.createdAt.localeCompare(a.createdAt),
      ),
    );
  }

  async function commitRow(id: string, patch: Partial<ProductRow>) {
    const current = batchRef.current;
    if (!current) throw new Error('Партия недоступна.');
    const next = {
      ...current,
      rows: current.rows.map((row) => (row.id === id ? { ...row, ...patch } : row)),
    };
    window.clearTimeout(saveTimerRef.current);
    await saveBatch(next);
    if (batchRef.current === current) {
      changeBatch(next);
    } else if (batchRef.current?.id === current.id) {
      patchRow(id, patch);
      await persistCurrent();
    }
  }

  useEffect(() => {
    let alive = true;
    const defaults = readPreferences();
    setPreferences(defaults);
    setProfile(defaults.profile);
    setSearchOptions(defaults.search);
    listBatches()
      .then((items) => {
        if (!alive) return;
        setHistory(items);
        if (items[0]) {
          batchRef.current = items[0];
          setBatch(items[0]);
          setProfile(items[0].profile);
          setSearchOptions(restoreSearchOptions(items[0].searchOptions));
        }
      })
      .catch((error) => {
        if (alive) setToast({ message: errorText(error), error: true });
      })
      .finally(() => {
        if (alive) setLoaded(true);
      });
    configPromiseRef.current = fetch('/api/config')
      .then((response) => response.json())
      .then((value) => {
        if (alive) {
          setConfig(value);
          configRef.current = value;
        }
        return value as AppConfig;
      })
      .catch(() => {
        if (alive)
          setToast({
            message: 'Не удалось проверить источники. Загрузка своих фото доступна.',
            error: true,
          });
        return null;
      });
    return () => {
      alive = false;
      controllerRef.current?.abort();
    };
  }, []);

  useEffect(() => {
    if (!batch || !loaded) return;
    setSaved(false);
    const timer = window.setTimeout(() => {
      saveBatch(batch)
        .then(() => {
          if (batchRef.current === batch) setSaved(true);
          setHistory((current) =>
            [batch, ...current.filter((item) => item.id !== batch.id)].sort((a, b) =>
              b.createdAt.localeCompare(a.createdAt),
            ),
          );
        })
        .catch((reason) => notify(errorText(reason), true));
    }, 350);
    saveTimerRef.current = timer;
    return () => window.clearTimeout(timer);
  }, [batch, loaded]);

  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(null), toast.error ? 18000 : 6000);
    return () => clearTimeout(timer);
  }, [toast]);

  useEffect(() => {
    if (
      !config.databaseConfigured ||
      (config.accessProtected && !accessVerified) ||
      !batch?.rows.some(
        (row) => row.status === 'searching' && (row.searchJobId || row.searchRequestKey),
      )
    )
      return;
    let alive = true;
    let retryAfter = 0;
    const timer = window.setInterval(async () => {
      if (queueSubmittingRef.current || queuePollingRef.current || Date.now() < retryAfter) return;
      queuePollingRef.current = true;
      try {
        const pendingRows =
          batchRef.current?.rows.filter(
            (row) => row.status === 'searching' && (row.searchJobId || row.searchRequestKey),
          ) ?? [];
        const unsent = pendingRows.filter((row) => !row.searchJobId);
        const submittedIds = new Map(pendingRows.map((row) => [row.id, row.searchJobId]));
        if (unsent.length) {
          const completed = await submitQueuedRows(unsent);
          if (!alive) return;
          const changes = new Map<string, Partial<ProductRow>>();
          for (const [id, job] of completed) {
            submittedIds.set(id, job.id);
            changes.set(id, { searchJobId: job.id });
          }
          patchRows(changes);
          await persistCurrent();
        }
        const jobs = new Map<string, JobSnapshot>();
        for (let i = 0; i < pendingRows.length; i += 100) {
          const response = await apiFetch('/api/jobs/status', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              ids: pendingRows.slice(i, i + 100).map((row) => submittedIds.get(row.id)),
            }),
          });
          for (const job of (await response.json()).jobs as JobSnapshot[]) jobs.set(job.id, job);
        }
        const currentRows = new Map(batchRef.current?.rows.map((row) => [row.id, row]));
        const changes = new Map<string, Partial<ProductRow>>();
        for (const row of pendingRows) {
          if (!alive) return;
          if (currentRows.get(row.id)?.searchRequestKey !== row.searchRequestKey) continue;
          const job = jobs.get(submittedIds.get(row.id) ?? '');
          if (!job) {
            changes.set(row.id, {
              status: 'error',
              error: 'Задание не найдено. Запустите поиск снова.',
              searchRequestKey: undefined,
              searchJobId: undefined,
            });
            continue;
          }
          if (job.status === 'succeeded') {
            const result: SearchResponse = job.result;
            changes.set(row.id, {
              status: result.candidates.length
                ? 'review'
                : result.outcome === 'deferred'
                  ? 'deferred'
                  : 'not_found',
              candidates: result.candidates,
              qualityWarnings: result.warnings,
              searchDiagnostics: result.diagnostics,
              searchCoverage: result.coverage,
              searchJobId: undefined,
              searchRequestKey: undefined,
              searchJobMessage: undefined,
              selectedCandidateId: undefined,
              confirmed: false,
            });
          } else if (job.status === 'failed' || job.status === 'cancelled') {
            changes.set(row.id, {
              status: job.status === 'cancelled' ? 'pending' : 'error',
              error: job.error,
              searchJobId: undefined,
              searchRequestKey: undefined,
              searchJobMessage: undefined,
            });
          } else {
            const searchJobMessage =
              job.status === 'queued'
                ? config.cloudWorkerConfigured
                  ? 'В очереди · облачный поиск запускается автоматически'
                  : 'В очереди · резервный облачный поиск'
                : job.status === 'retry'
                  ? `Источники временно недоступны · повтор ${job.attempts + 1}/3 после ${new Date(job.available_at).toLocaleTimeString('ru')}`
                  : `Идёт поиск · попытка ${job.attempts}/3`;
            if (currentRows.get(row.id)?.searchJobMessage !== searchJobMessage)
              changes.set(row.id, { searchJobMessage });
          }
        }
        patchRows(changes);
      } catch (error) {
        retryAfter = Date.now() + 60_000;
        if (alive) {
          if (error instanceof ApiRequestError && error.status === 401) requireAccess();
          notify('Очередь: ' + errorText(error), true);
        }
      } finally {
        queuePollingRef.current = false;
      }
    }, 4000);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, [
    config.databaseConfigured,
    config.cloudWorkerConfigured,
    batch?.id,
    batch?.rows.some((row) => row.status === 'searching'),
    config.accessProtected,
    accessVerified,
  ]);

  async function cancelQueuedSearches() {
    const pending =
      batchRef.current?.rows.filter(
        (row) => row.status === 'searching' && (row.searchJobId || row.searchRequestKey),
      ) ?? [];
    if (!pending.length) return;
    setPanelBusy(true);
    queueSubmittingRef.current = true;
    try {
      const unsent = pending.filter((row) => !row.searchJobId);
      const recovered = unsent.length ? await submitQueuedRows(unsent) : undefined;
      const ids = pending.map((row) => row.searchJobId ?? recovered?.get(row.id)?.id ?? '');
      let cancelled: string[];
      if (ids.length === 1) {
        const reply = await apiFetch('/api/jobs/' + ids[0], { method: 'POST' });
        cancelled = (await reply.json()).status === 'cancelled' ? ids : [];
      } else {
        const reply = await apiFetch('/api/jobs/cancel', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ids }),
        });
        cancelled = (await reply.json()).ids;
      }
      const cancelledSet = new Set(cancelled);
      const changes = new Map<string, Partial<ProductRow>>();
      pending.forEach((row, index) => {
        if (!cancelledSet.has(ids[index])) return;
        changes.set(row.id, {
          status: 'pending',
          searchJobId: undefined,
          searchRequestKey: undefined,
          searchJobMessage: undefined,
        });
      });
      patchRows(changes);
      await persistCurrent();
    } catch (error) {
      if (error instanceof ApiRequestError && error.status === 401) requireAccess();
      notify(errorText(error), true);
    } finally {
      queueSubmittingRef.current = false;
      setPanelBusy(false);
    }
  }

  const rows = batch?.rows ?? [];
  const ready = rows.filter(
    (row) =>
      row.status === 'ready' &&
      row.confirmed &&
      row.rightsConfirmed &&
      row.outputBlob &&
      row.vision?.verdict !== 'conflict',
  ).length;
  const review = rows.filter((row) => row.status === 'review').length;
  const unresolved = rows.filter((row) =>
    ['not_found', 'deferred', 'error'].includes(row.status),
  ).length;
  const activeRow = rows.find((row) => row.id === activeId);
  const filtered = rows.filter((row) => {
    if (filter === 'ready' && row.status !== 'ready') return false;
    if (filter === 'review' && row.status !== 'review') return false;
    if (filter === 'unresolved' && !['not_found', 'deferred', 'error'].includes(row.status))
      return false;
    return `${row.sku} ${row.internalCode} ${row.ean} ${row.nameRu} ${row.nameRo}`
      .toLowerCase()
      .includes(query.toLowerCase());
  });

  async function importFile(file?: File) {
    if (!file || busy) return;
    setLoadingFile(true);
    try {
      setImported({ sheet: await parseFile(file), filename: file.name });
    } catch (error) {
      notify(errorText(error), true);
    } finally {
      setLoadingFile(false);
    }
  }

  async function createBatch(
    name: string,
    importedRows: ProductRow[],
    source: 'excel' | 'manual' = 'excel',
  ) {
    setSwitching(true);
    try {
      await persistCurrent();
      const next: Batch = {
        id: crypto.randomUUID(),
        name,
        createdAt: new Date().toISOString(),
        rows: importedRows.map((row) => ({
          ...row,
          inputWarnings: [...row.qualityWarnings],
          qualityWarnings: [],
        })),
        profile: preferences.profile,
        searchOptions: preferences.search,
      };
      await saveBatch(next);
      changeBatch(next);
      setProfile(next.profile);
      setSearchOptions(next.searchOptions!);
      setImported(null);
      setActiveId(null);
      setSelected(new Set());
      setFilter('all');
      setQuery('');
      setTab('workspace');
      setHistory((items) => [next, ...items.filter((item) => item.id !== next.id)]);
      notify(
        source === 'manual'
          ? 'Артикул добавлен. Начинаем поиск фотографий.'
          : `Импортировано ${importedRows.length} товарных позиций.`,
      );
    } finally {
      setSwitching(false);
    }
  }

  async function searchRows() {
    if (!batch || busy) return;
    const targets = selected.size
      ? rows.filter(
          (row) =>
            selected.has(row.id) &&
            row.status !== 'ready' &&
            row.status !== 'searching' &&
            !row.originalBlob,
        )
      : rows.filter(
          (row) =>
            ['pending', 'not_found', 'deferred', 'error'].includes(row.status) && !row.originalBlob,
        );
    if (!targets.length) {
      notify(
        'Все найденные позиции уже на проверке. Откройте карточку товара или выберите строки для повторного поиска.',
      );
      return;
    }
    await runSearch(targets);
  }

  async function importSupplierFolder(files: File[]) {
    const current = batchRef.current;
    if (!current || busy || !files.length) return;
    setPanelBusy(true);
    try {
      const { matched, unmatched, ambiguous, occupied } = matchSupplierPhotos(current.rows, files);
      const changes = new Map<string, Partial<ProductRow>>();
      let invalid = 0;
      for (const { row, file } of matched) {
        try {
          changes.set(row.id, await supplierPhotoPatch(row, file));
        } catch {
          invalid++;
        }
      }
      if (changes.size) {
        patchRows(changes);
        await persistCurrent();
      }
      notify(
        `Фото поставщика добавлено на проверку: ${changes.size}. Без совпадения: ${unmatched}, неоднозначных: ${ambiguous}, с фото или активным поиском: ${occupied}, неподдерживаемых или повреждённых: ${invalid}.`,
        !changes.size,
      );
    } catch (error) {
      notify(errorText(error), true);
    } finally {
      setPanelBusy(false);
    }
  }

  async function runSearch(
    requested: ProductRow[],
    options = restoreSearchOptions(batchRef.current?.searchOptions),
    refresh = false,
    byName = false,
  ) {
    const targets = requested.filter((row) => {
      const error = rowSearchError(row, byName);
      if (error) patchRow(row.id, { status: 'error', error });
      return !error;
    });
    if (!targets.length) {
      notify('Проверьте GTIN, SKU и название в карточках выбранных товаров.', true);
      return;
    }
    setOperation({
      kind: 'search',
      total: targets.length,
      done: 0,
      message: 'Проверяем подключение поиска…',
    });
    let runtimeConfig = configRef.current;
    if (!runtimeConfig) {
      runtimeConfig = await configPromiseRef.current;
      if (!runtimeConfig) {
        try {
          runtimeConfig = await (await fetch('/api/config')).json();
          configRef.current = runtimeConfig;
          if (runtimeConfig) setConfig(runtimeConfig);
        } catch {
          /* The error below leaves manual image preparation available. */
        }
      }
    }
    if (!runtimeConfig) {
      notify(
        'Не удалось проверить подключение поиска. Повторите запрос; загрузка своих фото доступна.',
        true,
      );
      setOperation(null);
      return;
    }
    if (runtimeConfig.accessProtected && !accessVerified) {
      requireAccess();
      notify('Подтвердите доступ к серверу перед поиском.', true);
      setOperation(null);
      return;
    }
    if (runtimeConfig.databaseConfigured) {
      setOperation({
        kind: 'search',
        total: targets.length,
        done: 0,
        message: 'Добавляем товары в общую очередь…',
      });
      stopRef.current = false;
      queueSubmittingRef.current = true;
      try {
        const prepared = targets.map((row): ProductRow => ({
          ...row,
          status: 'searching',
          error: undefined,
          searchJobId: undefined,
          searchRequestKey: crypto.randomUUID(),
          lastSearchOptions: options,
          searchRefresh: refresh,
          searchByName: byName,
          searchJobMessage: runtimeConfig.cloudWorkerConfigured
            ? 'В очереди · облачный поиск запускается автоматически'
            : 'В очереди · резервный облачный поиск',
        }));
        patchRows(new Map(prepared.map((row) => [row.id, row])));
        await persistCurrent();
        if (stopRef.current) {
          const current = batchRef.current;
          const previous = new Map(targets.map((row) => [row.id, row]));
          if (current)
            changeBatch({
              ...current,
              rows: current.rows.map((row) => previous.get(row.id) ?? row),
            });
          await persistCurrent();
          return;
        }
        const jobs = await submitQueuedRows(prepared);
        const changes = new Map<string, Partial<ProductRow>>();
        for (const [rowId, job] of jobs) {
          changes.set(rowId, {
            searchJobId: job.id,
            ...(job.workerAwake === false
              ? {
                  searchJobMessage: 'Задание сохранено · резервный поиск на Vercel',
                }
              : {}),
          });
        }
        patchRows(changes);
        await persistCurrent();
        if (stopRef.current) {
          await cancelQueuedSearches();
          return;
        }
        notify(
          runtimeConfig.cloudWorkerConfigured
            ? 'Облачный поиск запущен. Можно закрыть вкладку — поиск продолжится, результаты сохранятся.'
            : 'Товары добавлены в очередь. Поиск выполняется на Vercel; задания сохранятся.',
        );
      } catch (error) {
        if (error instanceof ApiRequestError && error.status === 401) requireAccess();
        notify(errorText(error), true);
      } finally {
        queueSubmittingRef.current = false;
        setOperation(null);
      }
      return;
    }
    stopRef.current = false;
    setOperation({ kind: 'search', total: targets.length, done: 0, message: 'Запускаем поиск…' });
    let completed = 0;
    try {
      for (const row of targets) {
        if (stopRef.current) break;
        const controller = new AbortController();
        controllerRef.current = controller;
        patchRow(row.id, { status: 'searching', error: undefined, searchByName: byName });
        setOperation({
          kind: 'search',
          total: targets.length,
          done: completed,
          message: `Ищем ${row.sku} · ${rowTitle(row)}`,
        });
        try {
          const response = await apiFetch('/api/search', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              sku: row.sku,
              internalCode: row.internalCode,
              ...rowSearchProduct(row, byName),
              searchOptions: options,
              refresh,
            }),
            signal: controller.signal,
          });
          const result: SearchResponse = await response.json();
          patchRow(row.id, {
            candidates: result.candidates,
            status: result.candidates.length
              ? 'review'
              : result.outcome === 'deferred'
                ? 'deferred'
                : 'not_found',
            qualityWarnings: result.warnings,
            searchDiagnostics: result.diagnostics,
            searchCoverage: result.coverage,
            lastSearchOptions: { ...options },
            selectedCandidateId: undefined,
            confirmed: false,
          });
        } catch (error) {
          if (error instanceof ApiRequestError && error.status === 401) requireAccess();
          patchRow(row.id, {
            status: controller.signal.aborted ? row.status : 'error',
            error: controller.signal.aborted ? undefined : errorText(error),
          });
          if (
            !controller.signal.aborted &&
            /пароль|MVP_ACCESS_PASSWORD|401|503|quota|квот/i.test(errorText(error))
          ) {
            notify(errorText(error), true);
            stopRef.current = true;
          }
        }
        completed++;
        await persistCurrent();
        setOperation((current) => (current ? { ...current, done: completed } : current));
      }
      if (!stopRef.current)
        notify('Поиск завершён. Проверьте найденные фотографии в карточках товаров.');
    } catch (error) {
      notify(errorText(error), true);
    } finally {
      controllerRef.current = null;
      setOperation(null);
    }
  }

  async function processRows() {
    if (!batch || busy) return;
    const targets = rows.filter(
      (row) =>
        row.originalBlob && row.status !== 'ready' && (!selected.size || selected.has(row.id)),
    );
    if (!targets.length) {
      notify('Сначала выберите исходные фотографии в карточках товаров.');
      return;
    }
    stopRef.current = false;
    setOperation({
      kind: 'process',
      total: targets.length,
      done: 0,
      message: 'Загружаем модель обработки…',
    });
    let completed = 0;
    try {
      const { processImage } = await import('@/lib/image-processing');
      for (const row of targets) {
        if (stopRef.current) break;
        patchRow(row.id, {
          status: 'processing',
          error: undefined,
          outputBlob: undefined,
          outputWidth: undefined,
          outputHeight: undefined,
          processingMethod: undefined,
          confirmed: false,
        });
        try {
          const result = await processImage(
            row.originalBlob!,
            { ...batch.profile, method: row.processingOverride ?? batch.profile.method },
            (message) =>
              setOperation({
                kind: 'process',
                total: targets.length,
                done: completed,
                message: `${row.sku} · ${message}`,
              }),
          );
          patchRow(row.id, {
            status: 'review',
            outputBlob: result.blob,
            outputWidth: result.width,
            outputHeight: result.height,
            processingMethod: result.method,
            qualityWarnings: result.warnings,
            confirmed: false,
          });
        } catch (error) {
          patchRow(row.id, { status: 'review', error: errorText(error) });
        }
        completed++;
        await persistCurrent();
      }
      if (!stopRef.current)
        notify('Фотографии подготовлены. Подтвердите результат перед экспортом.');
    } catch (error) {
      notify(errorText(error), true);
    } finally {
      setOperation(null);
    }
  }

  async function exportZip() {
    if (!batch || exporting || busy) return;
    setExporting(true);
    try {
      await exportBatch(batch);
      notify(`Архив подготовлен: ${ready} JPG и отчёт по всем ${rows.length} строкам.`);
    } catch (error) {
      notify(errorText(error), true);
    } finally {
      setExporting(false);
    }
  }

  async function template() {
    try {
      await downloadTemplate();
    } catch (error) {
      notify(errorText(error), true);
    }
  }
  async function openBatch(item: Batch) {
    if (busy) return;
    setSwitching(true);
    try {
      await persistCurrent();
      const latest = (await listBatches()).find((value) => value.id === item.id) || item;
      changeBatch(latest);
      setProfile(latest.profile);
      setSearchOptions(restoreSearchOptions(latest.searchOptions));
      setActiveId(null);
      setSelected(new Set());
      setQuery('');
      setFilter('all');
      setTab('workspace');
    } catch (error) {
      notify(errorText(error), true);
    } finally {
      setSwitching(false);
    }
  }
  function updateProfile(next: ExportProfile) {
    setProfile(next);
    rememberPreferences({ ...preferences, profile: next });
    const current = batchRef.current;
    if (current) {
      const changed = processingChanged(current.profile, next);
      const invalidated = changed && current.rows.some((row) => row.outputBlob);
      changeBatch({
        ...current,
        profile: next,
        rows: current.rows.map((row) => {
          const nextRow = {
            ...row,
            processingOverride:
              current.profile.method !== next.method ? undefined : row.processingOverride,
          };
          return changed && row.outputBlob
            ? {
                ...nextRow,
                outputBlob: undefined,
                outputWidth: undefined,
                outputHeight: undefined,
                processingMethod: undefined,
                confirmed: false,
                status: 'review',
                error: undefined,
              }
            : nextRow;
        }),
      });
      if (invalidated)
        notify(
          'Параметры JPG изменены. Исходники сохранены; подготовьте фото заново и подтвердите результат.',
        );
    }
  }
  function rememberPreferences(next: Preferences) {
    setPreferences(next);
    try {
      savePreferences(next);
    } catch {
      notify(
        'Настройки действуют сейчас, но браузер не разрешил сохранить их для следующего запуска.',
        true,
      );
    }
  }
  function updateSearchOptions(next: SearchOptions) {
    setSearchOptions(next);
    rememberPreferences({ ...preferences, search: next });
    if (batchRef.current) changeBatch({ ...batchRef.current, searchOptions: next });
  }
  async function checkSources() {
    if (checkingSources) return;
    setCheckingSources(true);
    setSourceStatus(null);
    setSourceStatusError(null);
    try {
      const response = await apiFetch('/api/search-status', { method: 'POST' });
      setSourceStatus(await response.json());
    } catch (error) {
      setSourceStatusError(errorText(error));
    } finally {
      setCheckingSources(false);
    }
  }
  function serviceState(id: string, configured: boolean) {
    const checked = sourceStatus?.services.find((service) => service.id === id);
    if (checked?.status === 'ok')
      return { status: 'Соединение подтверждено', enabled: true, message: checked.message };
    if (checked?.status === 'unavailable')
      return { status: 'Недоступен', enabled: false, message: checked.message };
    if (checked?.status === 'not_configured')
      return { status: 'Не подключён', enabled: false, message: checked.message };
    return {
      status: configured ? 'Настроен · не проверен' : 'Не подключён',
      enabled: false,
    };
  }
  function nextReview() {
    const current = batchRef.current;
    if (!current) return;
    const index = current.rows.findIndex((row) => row.id === activeId);
    const ordered = [...current.rows.slice(index + 1), ...current.rows.slice(0, index)];
    const next =
      ordered.find((row) => row.status === 'review') ??
      ordered.find((row) => row.status !== 'ready');
    if (next) setActiveId(next.id);
    else notify('Остальные позиции подтверждены. Можно скачать ZIP.');
  }

  return (
    <div className="app-shell">
      <input
        ref={fileRef}
        className="visually-hidden"
        type="file"
        accept=".xlsx,.csv"
        aria-label="Загрузить Excel или CSV"
        onChange={(event) => {
          void importFile(event.target.files?.[0]);
          event.target.value = '';
        }}
      />
      <header className="topbar">
        <a href="/" className="brand" aria-label="Shelf Studio">
          <span className="brand-mark">
            <Layers size={23} strokeWidth={1.8} />
          </span>
          <strong>
            shelf<span>studio</span>
          </strong>
          <span className="version-badge">MVP</span>
        </a>
        <div className="topbar-right">
          <span className="local-badge">
            <span className="status-dot" />
            Данные в этом браузере
          </span>
          <button
            className="icon-button"
            onClick={() => setHelpOpen(true)}
            aria-label="Как это работает"
          >
            <CircleHelp size={19} />
          </button>
          <button
            className="button secondary compact"
            onClick={() => setSettingsOpen(true)}
            disabled={busy}
          >
            <Settings2 size={16} />
            Настройки
          </button>
        </div>
      </header>

      <div className="body-layout">
        <nav className="sidebar" aria-label="Основная навигация">
          <span className="nav-label">РАБОЧЕЕ ПРОСТРАНСТВО</span>
          <button
            className={tab === 'workspace' ? 'nav-item active' : 'nav-item'}
            onClick={() => setTab('workspace')}
          >
            <ImageIcon size={18} />
            Подготовка фото
            <ChevronRight size={15} />
          </button>
          <button
            className={tab === 'history' ? 'nav-item active' : 'nav-item'}
            onClick={() => setTab('history')}
          >
            <FolderOpen size={18} />
            Мои партии<span className="nav-count">{history.length}</span>
          </button>
          <button
            className={tab === 'sources' ? 'nav-item active' : 'nav-item'}
            onClick={() => setTab('sources')}
          >
            <Globe size={18} />
            Источники
          </button>
          <div className="sidebar-footer">
            <div className="shelf-mini">
              <ShieldCheck size={20} />
              <strong>Профиль Shelf</strong>
            </div>
            <p>
              Белый фон.
              <br />
              Точные границы упаковки.
              <br />
              Сохранённые пропорции.
            </p>
            <button className="text-button" onClick={() => setSettingsOpen(true)} disabled={busy}>
              Параметры экспорта
              <ArrowRight size={14} />
            </button>
          </div>
        </nav>

        <main className="main-content">
          <div className="page-heading">
            <div>
              <span className="eyebrow">ИЗОБРАЖЕНИЯ ДЛЯ ПЛАНОГРАММ</span>
              <h1>
                {tab === 'history'
                  ? 'Мои партии'
                  : tab === 'sources'
                    ? 'Источники изображений'
                    : 'Подготовка фотографий'}
              </h1>
              <p>
                {tab === 'history'
                  ? 'Сохранённые партии и результаты обработки в этом браузере.'
                  : tab === 'sources'
                    ? 'Поиск по штрихкоду, дополнительные каталоги и проверка упаковки.'
                    : 'От списка товаров до готовых изображений для Shelf.'}
              </p>
            </div>
            {tab !== 'sources' && (
              <div className="page-heading-actions">
                <button
                  className="button secondary"
                  disabled={busy || loadingFile || !loaded}
                  onClick={() => setSingleProductOpen(true)}
                >
                  <Search size={17} />
                  Один артикул
                </button>
                <button
                  className="button primary"
                  disabled={busy || loadingFile}
                  onClick={() => fileRef.current?.click()}
                >
                  <Plus size={18} />
                  Новая партия
                </button>
              </div>
            )}
          </div>

          {tab === 'workspace' && (
            <>
              <div className="workflow-strip" aria-label="Этапы работы">
                {[
                  ['01', 'Добавить товары', FileSpreadsheet],
                  ['02', 'Найти и проверить', Search],
                  ['03', 'Подготовить JPG', ImageIcon],
                  ['04', 'Скачать ZIP', ArrowDownToLine],
                ].map(([number, label, Icon], index) => {
                  const StepIcon = Icon as typeof FileSpreadsheet;
                  return (
                    <div
                      className={`workflow-step ${index === 0 && !batch ? 'current' : ''}`}
                      key={number as string}
                    >
                      <span className="step-number">{number as string}</span>
                      <StepIcon size={17} />
                      <span>{label as string}</span>
                      {index < 3 && <ChevronRight size={15} className="step-arrow" />}
                    </div>
                  );
                })}
              </div>

              {!batch ? (
                <div className="empty-workspace">
                  <div
                    className={`dropzone ${dragging ? 'dragging' : ''}`}
                    onDragOver={(event) => {
                      event.preventDefault();
                      setDragging(true);
                    }}
                    onDragLeave={() => setDragging(false)}
                    onDrop={(event) => {
                      event.preventDefault();
                      setDragging(false);
                      void importFile(event.dataTransfer.files[0]);
                    }}
                  >
                    <div className="upload-illustration">
                      <div className="sheet-back" />
                      <div className="sheet-front">
                        <FileSpreadsheet size={45} strokeWidth={1.2} />
                        <span>.xlsx</span>
                      </div>
                      <span className="upload-bubble">
                        <CloudUpload size={22} />
                      </span>
                    </div>
                    <span className="eyebrow">НАЧНИТЕ С ТОВАРНОГО СПИСКА</span>
                    <h2>Ваш Excel. Готовые фотографии.</h2>
                    <p>
                      Перетащите файл сюда или выберите его на компьютере.
                      <br />
                      Сопоставьте колонки — остальное соберём в одной партии.
                    </p>
                    <button
                      className="button primary"
                      disabled={loadingFile || !loaded}
                      onClick={() => fileRef.current?.click()}
                    >
                      {loadingFile ? (
                        <Loader2 size={18} className="spin" />
                      ) : (
                        <CloudUpload size={18} />
                      )}
                      {loadingFile ? 'Читаем таблицу…' : 'Загрузить Excel'}
                    </button>
                    <span className="file-hint">
                      XLSX или CSV · до 10 МБ · до {MAX_IMPORT_ROWS} позиций
                    </span>
                    <button
                      className="text-button single-product-shortcut"
                      disabled={loadingFile || !loaded}
                      onClick={() => setSingleProductOpen(true)}
                    >
                      Ввести один артикул без Excel
                      <ArrowRight size={14} />
                    </button>
                  </div>
                  <div className="template-row">
                    <div className="template-icon">
                      <FileSpreadsheet size={21} />
                    </div>
                    <div>
                      <strong>Не уверены в структуре файла?</strong>
                      <p>Используйте шаблон с кодами, названиями и габаритами.</p>
                    </div>
                    <button className="button secondary" onClick={template}>
                      <Download size={16} />
                      Скачать шаблон
                    </button>
                  </div>
                  <div className="empty-notes">
                    <span>
                      <Check size={15} />
                      Размеры товара сохраняются отдельно
                    </span>
                    <span>
                      <Check size={15} />
                      Экспорт после проверки SKU
                    </span>
                    <span>
                      <Check size={15} />
                      Обработка в браузере без AI-токенов
                    </span>
                  </div>
                </div>
              ) : (
                <>
                  <div className="batch-summary">
                    <div className="batch-identity">
                      <span className="batch-icon">
                        <FileSpreadsheet size={23} />
                      </span>
                      <div>
                        <h2>{batch.name}</h2>
                        <p>
                          {formatDate(batch.createdAt)}
                          <span>·</span>
                          {saved ? 'Сохранено в браузере' : 'Сохраняем…'}
                        </p>
                      </div>
                    </div>
                    <div className="summary-stats">
                      <div>
                        <strong>{rows.length}</strong>
                        <span>всего SKU</span>
                      </div>
                      <div className="stat-review">
                        <strong>{review}</strong>
                        <span>на проверке</span>
                      </div>
                      <div className="stat-ready">
                        <strong>{ready}</strong>
                        <span>готово</span>
                      </div>
                    </div>
                  </div>
                  {config.serverReady === false && (
                    <div className="notice-inline danger">
                      <ShieldCheck size={17} />
                      <span>
                        Для поиска на опубликованном сайте задайте MVP_ACCESS_PASSWORD в окружении
                        сервера. Загрузка своих фото и обработка в браузере доступны.
                      </span>
                    </div>
                  )}
                  {!config.braveConfigured &&
                    !config.tavilyConfigured &&
                    config.serverReady !== false && (
                      <div className="source-notice">
                        <Globe size={17} />
                        <p>
                          {searchOptions.mode === 'moldova'
                            ? 'Режим «Молдова»: местные каталоги и Open Food Facts по EAN. При отказе магазина разрешённый веб-поиск проверяет только молдавские источники.'
                            : 'Рынок: Молдова. Работают прямые каталоги магазинов и производителей, региональные источники и базы EAN. Для общего веб-поиска подключите Brave Search или Tavily Free.'}
                        </p>
                        <button className="text-button" onClick={() => setTab('sources')}>
                          Источники
                          <ArrowRight size={14} />
                        </button>
                      </div>
                    )}
                  <div className="batch-toolbar">
                    <div className="toolbar-actions">
                      <button
                        className="button primary"
                        disabled={busy || loadingFile}
                        onClick={searchRows}
                      >
                        <Search size={16} />
                        Найти изображения
                        {selected.size > 0 && <span className="button-count">{selected.size}</span>}
                      </button>
                      <button
                        className="button secondary"
                        disabled={
                          busy || !rows.some((row) => row.originalBlob && row.status !== 'ready')
                        }
                        onClick={processRows}
                      >
                        <ImageIcon size={16} />
                        Подготовить JPG
                      </button>
                    </div>
                    <button
                      className="button secondary"
                      disabled={busy || exporting}
                      onClick={exportZip}
                    >
                      {exporting ? <Loader2 className="spin" size={16} /> : <Download size={16} />}
                      Скачать ZIP<span className="button-count">{ready}</span>
                    </button>
                  </div>
                  <div className="batch-search-controls">
                    <input
                      ref={(input) => {
                        supplierFolderRef.current = input;
                        input?.setAttribute('webkitdirectory', '');
                      }}
                      type="file"
                      multiple
                      hidden
                      aria-label="Папка с фото поставщика"
                      onChange={(event) => {
                        const files = Array.from(event.target.files ?? []);
                        event.target.value = '';
                        void importSupplierFolder(files);
                      }}
                    />
                    <button
                      className="text-button"
                      disabled={busy}
                      title="Названия файлов должны совпадать с SKU, внутренним кодом или GTIN"
                      onClick={() => supplierFolderRef.current?.click()}
                    >
                      Фото поставщика из папки
                    </button>
                    {config.databaseConfigured && <span>Общий каталог и очередь · Neon Free</span>}
                    <span>
                      Поиск:{' '}
                      <strong>
                        {searchOptions.mode === 'moldova' ? 'Молдова · быстрее' : 'Расширенный'}
                      </strong>
                    </span>
                    <button
                      className="text-button"
                      disabled={busy}
                      onClick={() => setSettingsOpen(true)}
                    >
                      Изменить параметры
                    </button>
                    {review > 0 && (
                      <button
                        className="text-button"
                        disabled={busy}
                        onClick={() => {
                          setActiveId(rows.find((row) => row.status === 'review')!.id);
                        }}
                      >
                        Проверить фотографии ({review}) <ArrowRight size={14} />
                      </button>
                    )}
                  </div>
                  {operation && (
                    <div className="operation-bar" role="status">
                      <div>
                        <Loader2 size={18} className="spin" />
                        <span>{operation.message}</span>
                        <strong>
                          {operation.done}/{operation.total}
                        </strong>
                        <button
                          className="button subtle compact"
                          onClick={() => {
                            stopRef.current = true;
                            setOperation((current) =>
                              current
                                ? { ...current, message: 'Останавливаем после текущего SKU…' }
                                : current,
                            );
                          }}
                        >
                          <Square size={12} />
                          Остановить
                        </button>
                      </div>
                      <progress max={operation.total} value={operation.done} />
                    </div>
                  )}
                  {config.databaseConfigured && rows.some((row) => row.status === 'searching') && (
                    <div className="notice-inline" role="status">
                      <Loader2 size={16} className="spin" />
                      <span>
                        В очереди или поиске:{' '}
                        {rows.filter((row) => row.status === 'searching').length}.{' '}
                        {config.cloudWorkerConfigured
                          ? 'Поиск работает в облаке. Можно закрыть вкладку и вернуться к результатам позже.'
                          : 'Резервный поиск выполняется на Vercel. Задания сохраняются в общей базе.'}
                      </span>
                      <button
                        className="text-button"
                        disabled={busy}
                        onClick={() => void cancelQueuedSearches()}
                      >
                        Отменить поиск
                      </button>
                    </div>
                  )}
                  <div className={`workspace-grid ${activeRow ? 'has-review' : ''}`}>
                    <section className="product-table-card" aria-label="Товары партии">
                      <div className="table-controls">
                        <div className="filter-tabs" role="group" aria-label="Фильтр статуса">
                          {(
                            [
                              ['all', 'Все', rows.length],
                              ['review', 'Проверка', review],
                              ['ready', 'Готово', ready],
                              ['unresolved', 'Не найдены / ошибки', unresolved],
                            ] as const
                          ).map(([value, label, count]) => (
                            <button
                              key={value}
                              className={filter === value ? 'active' : ''}
                              onClick={() => setFilter(value)}
                            >
                              {label}
                              <span>{count}</span>
                            </button>
                          ))}
                        </div>
                        <label className="search-input">
                          <Search size={16} />
                          <input
                            value={query}
                            onChange={(event) => setQuery(event.target.value)}
                            placeholder="SKU, EAN или название"
                            aria-label="Найти товар в партии"
                          />
                        </label>
                      </div>
                      <div className="table-scroll">
                        <table className="product-table">
                          <thead>
                            <tr>
                              <th className="check-cell">
                                <input
                                  type="checkbox"
                                  aria-label="Выбрать видимые товары"
                                  checked={
                                    filtered.length > 0 &&
                                    filtered.every((row) => selected.has(row.id))
                                  }
                                  onChange={(event) => {
                                    const next = new Set(selected);
                                    for (const row of filtered) {
                                      if (event.target.checked) next.add(row.id);
                                      else next.delete(row.id);
                                    }
                                    setSelected(next);
                                  }}
                                />
                              </th>
                              <th>ТОВАР</th>
                              <th>EAN / ГАБАРИТЫ</th>
                              <th>СТАТУС</th>
                              <th aria-label="Открыть" />
                            </tr>
                          </thead>
                          <tbody>
                            {filtered.map((row) => (
                              <tr key={row.id} className={activeId === row.id ? 'active-row' : ''}>
                                <td className="check-cell">
                                  <input
                                    type="checkbox"
                                    aria-label={`Выбрать ${row.sku}`}
                                    checked={selected.has(row.id)}
                                    onChange={(event) => {
                                      const next = new Set(selected);
                                      if (event.target.checked) next.add(row.id);
                                      else next.delete(row.id);
                                      setSelected(next);
                                    }}
                                  />
                                </td>
                                <td>
                                  <button
                                    className="product-cell"
                                    disabled={panelBusy}
                                    onClick={() => setActiveId(row.id)}
                                  >
                                    <div className="product-thumb">
                                      {row.outputBlob || row.originalBlob ? (
                                        <BlobImage
                                          blob={row.outputBlob || row.originalBlob}
                                          alt=""
                                        />
                                      ) : (
                                        <ImageIcon size={19} />
                                      )}
                                    </div>
                                    <div>
                                      <strong>{rowTitle(row)}</strong>
                                      <span>
                                        SKU {row.sku}
                                        {row.internalCode ? ` · Код ${row.internalCode}` : ''}
                                      </span>
                                    </div>
                                  </button>
                                </td>
                                <td>
                                  <span className="ean-value">{row.ean || '—'}</span>
                                  <span className="dimension-value">
                                    {row.widthMm && row.heightMm
                                      ? `${row.widthMm} × ${row.heightMm}${row.depthMm ? ` × ${row.depthMm}` : ''} мм`
                                      : 'Габариты не указаны'}
                                  </span>
                                </td>
                                <td>
                                  <Status status={row.status} />
                                </td>
                                <td>
                                  <button
                                    className="icon-button"
                                    disabled={panelBusy}
                                    onClick={() => setActiveId(row.id)}
                                    aria-label={`Открыть ${row.sku}`}
                                  >
                                    <ChevronRight size={18} />
                                  </button>
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                        {!filtered.length && (
                          <div className="table-empty">
                            <Search size={25} />
                            <p>По этому фильтру товаров нет.</p>
                            <button
                              className="text-button"
                              onClick={() => {
                                setQuery('');
                                setFilter('all');
                              }}
                            >
                              Сбросить фильтры
                            </button>
                          </div>
                        )}
                      </div>
                      <div className="table-footer">
                        <span>
                          {filtered.length} из {rows.length} позиций
                          {selected.size ? ` · выбрано ${selected.size}` : ''}
                        </span>
                        <span>JPG · белый фон · до {batch.profile.maxSide} px</span>
                      </div>
                    </section>
                    {activeRow && (
                      <ReviewPane
                        key={activeRow.id}
                        row={activeRow}
                        profile={batch.profile}
                        geminiConfigured={config.geminiConfigured}
                        databaseConfigured={config.databaseConfigured}
                        disabled={!!operation || activeRow.status === 'searching'}
                        onBusy={setPanelBusy}
                        onPatch={patchRow}
                        onCommit={commitRow}
                        onClose={() => setActiveId(null)}
                        onNotice={notify}
                        onNext={
                          rows.some((row) => row.id !== activeRow.id && row.status !== 'ready')
                            ? nextReview
                            : undefined
                        }
                        onSearch={(expanded, byName) =>
                          void runSearch(
                            [activeRow],
                            expanded ? { ...searchOptions, mode: 'expanded' } : searchOptions,
                            true,
                            byName,
                          )
                        }
                        searchMode={searchOptions.mode}
                      />
                    )}
                  </div>
                  <p className="workspace-footnote">
                    <ShieldCheck size={14} />В ZIP входят подтверждённые фотографии. Отчёт содержит
                    все исходные позиции.
                  </p>
                </>
              )}
            </>
          )}

          {tab === 'history' && (
            <section className="history-panel">
              {history.length ? (
                <div className="history-list">
                  {history.map((item) => (
                    <article className="history-card" key={item.id}>
                      <span className="batch-icon">
                        <FileSpreadsheet size={23} />
                      </span>
                      <div>
                        <h2>{item.name}</h2>
                        <p>
                          {formatDate(item.createdAt)} · {item.rows.length} SKU ·{' '}
                          {item.rows.filter((row) => row.status === 'ready').length} готово
                        </p>
                      </div>
                      <button
                        className="button secondary"
                        disabled={busy}
                        onClick={() => openBatch(item)}
                      >
                        Открыть
                        <ArrowRight size={16} />
                      </button>
                      <button
                        className="icon-button"
                        disabled={busy}
                        aria-label={`Удалить партию ${item.name}`}
                        onClick={() => setDeleteTarget(item)}
                      >
                        <Trash2 size={17} />
                      </button>
                    </article>
                  ))}
                </div>
              ) : (
                <div className="generic-empty">
                  <FolderOpen size={36} />
                  <h2>Здесь будут ваши партии</h2>
                  <p>Загрузите первый Excel. Результаты сохранятся в этом браузере.</p>
                  <button className="button primary" onClick={() => fileRef.current?.click()}>
                    <Plus size={16} />
                    Создать партию
                  </button>
                </div>
              )}
              <div className="storage-note">
                <Database size={20} />
                <div>
                  <strong>Хранение на этом устройстве</strong>
                  <p>
                    Партии и фотографии хранятся в IndexedDB. Очистка данных сайта удалит историю.
                    Скачивайте ZIP для резервной копии; облачную синхронизацию подключим отдельно.
                  </p>
                </div>
              </div>
            </section>
          )}

          {tab === 'sources' && (
            <>
              <section className="regional-source-panel" aria-label="Проверка соединения">
                <div className="section-label">
                  <h2>Состояние поиска без LLM</h2>
                  <button
                    className="button secondary"
                    disabled={checkingSources || config.serverReady === false}
                    onClick={() => void checkSources()}
                  >
                    {checkingSources ? <Loader2 size={16} className="spin" /> : <Check size={16} />}
                    {checkingSources ? 'Проверяем соединение…' : 'Проверить соединение'}
                  </button>
                </div>
                <p className="muted small">
                  Настроенный адрес ещё не означает, что сервис отвечает. Проверка доступности не
                  запускает поиск товаров и не обращается к Gemini.
                </p>
                {sourceStatusError && <p role="alert">{sourceStatusError}</p>}
                {sourceStatus && (
                  <p role="status" className="muted small">
                    Проверка завершена.{' '}
                    {sourceStatus.catalogSize !== undefined &&
                      `Товаров в каталоге: ${sourceStatus.catalogSize}. `}
                    {sourceStatus.cacheEntries !== undefined &&
                      `Записей в кэше: ${sourceStatus.cacheEntries}.`}
                  </p>
                )}
              </section>
              <div className="sources-grid">
                <SourceCard
                  name="Общий каталог · Neon Free"
                  type="ПОДТВЕРЖДЁННЫЕ ФОТО И ОЧЕРЕДЬ"
                  status={config.databaseConfigured ? 'Настроено' : 'Не подключён'}
                  enabled={!!config.databaseConfigured}
                  description="Подтверждённые фотографии используются до интернет-поиска. Задания сохраняются при закрытии вкладки."
                  detail={
                    config.cloudWorkerConfigured
                      ? 'Поиск запускается автоматически в Neon Functions Free. Ваш компьютер не нужен. После поиска исполнитель останавливается; сбои восстанавливаются по сохранённой очереди. Для подготовки JPEG и ZIP откройте сайт.'
                      : 'При недоступности Neon задания выполняет Vercel. Откройте сайт для восстановления отложенных заданий.'
                  }
                />
                <SourceCard
                  name="Open Food Facts"
                  type="БЕСПЛАТНЫЙ КАТАЛОГ"
                  status={config.serverReady === false ? 'Нужна настройка доступа' : 'Доступен'}
                  enabled={config.serverReady !== false}
                  description="Фотографии по EAN: Open Food Facts, Open Beauty Facts, Open Products Facts и Open Pet Food Facts. Покрытие каталогов различается; результат нужно проверить."
                  detail="Авторство и лицензия CC BY-SA сохраняются в отчёте."
                />
                <SourceCard
                  name="UPCitemdb"
                  type="ДОПОЛНИТЕЛЬНАЯ БАЗА ШТРИХКОДОВ"
                  status={
                    config.serverReady === false ? 'Нужна настройка доступа' : 'Без API-ключа'
                  }
                  enabled={config.serverReady !== false}
                  description="Дополнительная международная база EAN/UPC для товаров разных категорий. Фотографии сохраняют исходные ограничения использования."
                  detail="Бесплатный тариф: до 100 запросов в день, ограничение частоты. Платный переход отсутствует."
                />
                <SourceCard
                  name="Brave Search"
                  type="ОСНОВНОЙ ВЕБ-ПОИСК"
                  status={
                    !config.braveConfigured
                      ? 'Нужен API-ключ'
                      : config.braveFreeOnlyConfirmed
                        ? 'Ключ настроен · не проверен'
                        : 'Расход не подтверждён'
                  }
                  enabled={!!config.braveConfigured && !!config.braveFreeOnlyConfirmed}
                  description="Поиск по EAN и названиям RU / RO. Запускается, если прямые каталоги не дали точного совпадения."
                  detail="До двух запросов на SKU. Выключен до подтверждения запрета платного расхода в аккаунте ключа; служебная проверка не расходует Brave-кредиты."
                />
                <SourceCard
                  name="Tavily Free"
                  type="РЕЗЕРВНЫЙ ВЕБ-ПОИСК"
                  {...serviceState('tavily', !!config.tavilyConfigured)}
                  description="1 000 кредитов в месяц без карты. Один basic-запрос на SKU по умолчанию. Тариф и остаток проверяются до поиска."
                  detail="Резерв после Brave или при отсутствии его ключа. Нужен Researcher с выключенным pay-as-you-go; платный тариф или исчерпанная квота блокируют поиск."
                />
                <SourceCard
                  name="Gemini"
                  type="ДОПОЛНИТЕЛЬНАЯ AI-ПРОВЕРКА"
                  status={config.geminiConfigured ? 'Подключён' : 'Не подключён'}
                  enabled={config.geminiConfigured}
                  description="Сравнение видимых признаков упаковки с описанием товара. Используется по запросу и помогает выявить противоречия."
                  detail="Подключение: GEMINI_API_KEY. Доступность бесплатной квоты зависит от проекта и условий Google."
                />
              </div>
              <section className="regional-source-panel">
                <div className="section-label">
                  <h2>Прямые источники: Молдова и регион</h2>
                  <span>Поиск RU / RO и EAN</span>
                </div>
                <div className="regional-source-list">
                  {REGIONAL_SOURCES.map((source) => (
                    <div key={source.id}>
                      <strong>{source.name}</strong>
                      <a
                        href={`https://${source.domain}`}
                        target="_blank"
                        rel="noopener noreferrer"
                      >
                        {source.domain}
                      </a>
                      <span>{source.region}</span>
                    </div>
                  ))}
                </div>
                <p className="muted small">
                  Для этих источников ключ общего поискового API не требуется. Блокировки, изменения
                  сайта и отсутствие товара отображаются в диагностике конкретного поиска.
                </p>
              </section>
              <section className="regional-source-panel">
                <h2>Производители и дополнительные площадки</h2>
                <p className="muted small">
                  При подключённом веб-поиске запросы расширяются на оба языка и домены Молдовы,
                  России, Беларуси, Украины и Румынии. Следующие домены — ориентиры поиска по
                  индексу, отдельный прямой коннектор к каждому из них не заявляется.
                </p>
                <div className="indexed-source-tags">
                  {INDEXED_DOMAINS.map((domain) => (
                    <span key={domain}>{domain}</span>
                  ))}
                </div>
              </section>
              <div className="source-policy">
                <ShieldCheck size={24} />
                <div>
                  <h2>Соответствие и права проверяются отдельно</h2>
                  <p>
                    Совпадение EAN карточки помогает найти товар, но не гарантирует правильность
                    фотографии. Перед экспортом подтвердите вариант упаковки и право на
                    использование изображения.
                  </p>
                  <p>
                    Ключи подключаются через серверные переменные окружения. Их не нужно вводить в
                    браузер.
                  </p>
                </div>
              </div>
            </>
          )}
        </main>
      </div>

      {imported && (
        <ImportDialog
          sheet={imported.sheet}
          filename={imported.filename}
          onClose={() => setImported(null)}
          onImport={createBatch}
        />
      )}
      {singleProductOpen && (
        <SingleProductDialog
          onClose={() => setSingleProductOpen(false)}
          onCreate={async (row) => {
            await createBatch(`Артикул ${row.sku}`, [row], 'manual');
            setSingleProductOpen(false);
            setActiveId(row.id);
            await runSearch([row]);
          }}
        />
      )}
      {settingsOpen && (
        <Modal title="Параметры подготовки" wide onClose={() => setSettingsOpen(false)}>
          <p className="muted">
            Настройки применяются к текущей партии и запоминаются для новых. В сохранённых партиях
            остаются их собственные параметры.
          </p>
          <div className="settings-grid">
            <section aria-label="Настройки поиска">
              <h3 className="settings-section-heading">Поиск фотографий</h3>
              <div className="settings-fields">
                <label>
                  Режим поиска
                  <select
                    value={searchOptions.mode}
                    onChange={(event) =>
                      updateSearchOptions({
                        ...searchOptions,
                        mode: event.target.value as SearchOptions['mode'],
                      })
                    }
                  >
                    <option value="expanded">Расширенный — все подключённые каталоги</option>
                    <option value="moldova">Молдова — меньше запросов и ожидания</option>
                  </select>
                </label>
                <p className="muted small">
                  {searchOptions.mode === 'moldova'
                    ? 'METRO Moldova, Bonus, Linella, Bucuria и Open Food Facts по EAN. При отказе магазина включённый веб-поиск восстановит доступ к местным карточкам.'
                    : 'Молдова, региональные магазины, дополнительные базы EAN и веб-поиск, если он подключён.'}
                </p>
                {searchOptions.mode === 'expanded' && (
                  <label>
                    Рынок поставщика
                    <select
                      value={searchOptions.market ?? ''}
                      onChange={(event) => {
                        const market = event.target.value;
                        updateSearchOptions({
                          ...searchOptions,
                          market: isSupplierMarket(market) ? market : undefined,
                        });
                      }}
                    >
                      <option value="">Все подключённые источники</option>
                      {Object.entries(SUPPLIER_MARKETS).map(([code, { label }]) => (
                        <option key={code} value={code}>
                          {label}
                        </option>
                      ))}
                    </select>
                  </label>
                )}
                <label className="checkbox-label">
                  <input
                    type="checkbox"
                    checked={searchOptions.useCache ?? true}
                    onChange={(event) =>
                      updateSearchOptions({ ...searchOptions, useCache: event.target.checked })
                    }
                  />
                  <span>Использовать сохранённые результаты поиска</span>
                </label>
                <p className="muted small">
                  Кэш сокращает время повторного поиска. Кнопки «Повторить поиск» и «Расширить поиск
                  для SKU» в карточке всегда запрашивают свежие результаты.
                </p>
                <label className="checkbox-label">
                  <input
                    type="checkbox"
                    checked={searchOptions.useWeb}
                    onChange={(event) =>
                      updateSearchOptions({ ...searchOptions, useWeb: event.target.checked })
                    }
                  />
                  <span>Использовать бесплатный веб-поиск и резерв для недоступных магазинов</span>
                </label>
                <label>
                  Лимит веб-запросов на SKU
                  <select
                    value={searchOptions.webQueryLimit}
                    disabled={!searchOptions.useWeb}
                    onChange={(event) =>
                      updateSearchOptions({
                        ...searchOptions,
                        webQueryLimit: Number(event.target.value),
                      })
                    }
                  >
                    <option value={1}>1 запрос · экономный</option>
                    <option value={2}>2 запроса</option>
                    <option value={4}>4 запроса · полный</option>
                    <option value={6}>6 запросов</option>
                  </select>
                </label>
                <p className="muted small">
                  Brave — до двух запросов на SKU по умолчанию; Tavily — один запрос на SKU по
                  умолчанию с отдельным серверным пределом. Не более трёх карточек на SKU.{' '}
                  {config.braveConfigured || config.tavilyConfigured
                    ? 'Бесплатный веб-поиск настроен; состояние источников появится в диагностике.'
                    : 'Веб-поиск ещё не подключён: используются прямые каталоги и базы EAN.'}{' '}
                  Gemini запускается только кнопкой в карточке. Локальная модель удаления фона
                  относится к обработке фотографии и не участвует в поиске.
                </p>
              </div>
            </section>
            <section aria-label="Настройки JPG">
              <h3 className="settings-section-heading">JPG для Shelf</h3>
              <div className="settings-fields">
                <label>
                  Имена файлов
                  <select
                    value={profile.naming}
                    onChange={(event) =>
                      updateProfile({
                        ...profile,
                        naming: event.target.value as ExportProfile['naming'],
                      })
                    }
                  >
                    <option value="sku">По SKU</option>
                    <option value="internalCode">По внутреннему коду (при отсутствии — SKU)</option>
                  </select>
                </label>
                <label>
                  Максимальная длинная сторона
                  <select
                    value={profile.maxSide}
                    onChange={(event) =>
                      updateProfile({ ...profile, maxSide: Number(event.target.value) })
                    }
                  >
                    <option value={1200}>1200 px</option>
                    <option value={1600}>1600 px</option>
                    <option value={2400}>2400 px</option>
                  </select>
                </label>
                <label>
                  Качество JPEG
                  <select
                    value={profile.quality}
                    onChange={(event) =>
                      updateProfile({ ...profile, quality: Number(event.target.value) })
                    }
                  >
                    <option value={0.9}>90% · меньше размер файлов</option>
                    <option value={0.95}>95% · рекомендуется</option>
                    <option value={1}>100% · больше размер файлов</option>
                  </select>
                </label>
                <label>
                  Обработка фона
                  <select
                    value={profile.method}
                    onChange={(event) =>
                      updateProfile({
                        ...profile,
                        method: event.target.value as ExportProfile['method'],
                      })
                    }
                  >
                    <option value="ai">Нейросеть в браузере U²-Net — без токенов</option>
                    <option value="white">Обрезка светлого фона — без модели</option>
                  </select>
                </label>
              </div>
              <div className="notice-inline">
                <ImageIcon size={17} />
                <span>
                  Белый фон, прямоугольная обрезка по товару, пропорции сохраняются. Размеры не
                  увеличиваются искусственно. При смене размера, качества или метода готовые JPG
                  нужно подготовить и подтвердить заново; исходники сохраняются.
                </span>
              </div>
            </section>
          </div>
          <div className="settings-access">
            <h3>Доступ к серверу</h3>
            <p role="status">
              {config.serverReady === false
                ? 'Сервер не настроен'
                : !config.accessProtected
                  ? 'Локальный доступ'
                  : accessVerified
                    ? 'Доступ подтверждён'
                    : 'Требуется пароль'}
            </p>
            <p className="muted small">
              {config.accessProtected
                ? 'Сервер защищён паролем. Пароль хранится только в памяти этой вкладки.'
                : 'Локальный режим. Перед публичным размещением задайте MVP_ACCESS_PASSWORD.'}
            </p>
            <label className="field-label" htmlFor="access-password">
              Пароль приложения
            </label>
            <div className="inline-input">
              <input
                id="access-password"
                type="password"
                autoComplete="current-password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
              />
              <button
                className="button secondary"
                disabled={authBusy}
                onClick={() => void checkAccess()}
              >
                {authBusy ? 'Проверяем…' : 'Проверить доступ'}
              </button>
            </div>
          </div>
          <div className="modal-footer">
            <button className="button primary" onClick={() => setSettingsOpen(false)}>
              Готово
              <Check size={17} />
            </button>
          </div>
        </Modal>
      )}
      {helpOpen && (
        <Modal title="Как работает Shelf Studio" onClose={() => setHelpOpen(false)}>
          <ol className="help-list">
            <li>
              <strong>Добавьте товары.</strong>
              <p>
                Загрузите Excel/CSV или откройте «Один артикул». Укажите SKU, EAN или название, по
                возможности бренд и фасовку. Габариты — в миллиметрах.
              </p>
            </li>
            <li>
              <strong>Запустите поиск.</strong>
              <p>
                Режим «Молдова» сокращает число источников; расширенный охватывает всю подключённую
                базу. По умолчанию поиск выполняется без LLM и использует кэш. Для выбранного SKU
                кнопки повторного и расширенного поиска обходят кэш. Откройте карточку и выберите
                фото; можно загрузить собственное или добавить HTTPS-ссылку.
              </p>
            </li>
            <li>
              <strong>Подготовьте JPG.</strong>
              <p>
                Модель выделяет упаковку, фон становится белым, кадр обрезается прямоугольником по
                крайним точкам.
              </p>
            </li>
            <li>
              <strong>Проверьте и скачайте.</strong>
              <p>
                Проверьте этикетку, фасовку, крышку и дно. Подтвердите SKU и права, затем перейдите
                к следующей позиции кнопкой «Подтвердить и перейти дальше». ZIP содержит JPG, отчёт
                Excel и сведения об источниках.
              </p>
            </li>
          </ol>
          <div className="notice-inline">
            <Clock3 size={17} />
            <span>
              В MVP обработка выполняется в открытой вкладке. После закрытия вкладки сохранённые
              результаты останутся, незавершённые задачи можно запустить снова.
            </span>
          </div>
          <div className="modal-footer">
            <button className="button primary" onClick={() => setHelpOpen(false)}>
              Понятно
            </button>
          </div>
        </Modal>
      )}
      {deleteTarget && (
        <Modal title="Удалить сохранённую партию?" onClose={() => setDeleteTarget(null)}>
          <p>
            Партия «{deleteTarget.name}» и её фотографии будут удалены из этого браузера. Скачанные
            архивы сохранятся.
          </p>
          <div className="modal-footer">
            <button className="button secondary" onClick={() => setDeleteTarget(null)}>
              Отмена
            </button>
            <button
              className="button destructive"
              disabled={busy}
              onClick={async () => {
                if (busy) return;
                setSwitching(true);
                try {
                  await persistCurrent();
                  await deleteBatch(deleteTarget.id);
                  setHistory((current) => current.filter((item) => item.id !== deleteTarget.id));
                  if (batch?.id === deleteTarget.id) changeBatch(null);
                  setDeleteTarget(null);
                  notify('Партия удалена.');
                } catch (error) {
                  notify(errorText(error), true);
                } finally {
                  setSwitching(false);
                }
              }}
            >
              Удалить партию
            </button>
          </div>
        </Modal>
      )}
      {toast && (
        <div
          className={`toast ${toast.error ? 'toast-error' : ''}`}
          role={toast.error ? 'alert' : 'status'}
        >
          <span>{toast.message}</span>
          <button
            className="icon-button"
            aria-label="Закрыть уведомление"
            onClick={() => setToast(null)}
          >
            <X size={16} />
          </button>
        </div>
      )}
    </div>
  );
}

function Status({ status }: { status: RowStatus }) {
  return (
    <span className={`status-pill status-${status}`}>
      <span className={status === 'searching' || status === 'processing' ? 'pulse' : ''} />
      {STATUS_LABELS[status]}
    </span>
  );
}
function SourceCard({
  name,
  type,
  status,
  enabled,
  description,
  detail,
  message,
}: {
  name: string;
  type: string;
  status: string;
  enabled: boolean;
  description: string;
  detail: string;
  message?: string;
}) {
  return (
    <article className="source-card">
      <span className="eyebrow">{type}</span>
      <h2>{name}</h2>
      <span className={`provider-status ${enabled ? 'enabled' : ''}`}>
        <span />
        {status}
      </span>
      <p>{description}</p>
      <div className="source-card-detail">{detail}</div>
      {message && <p className="muted small">{message}</p>}
    </article>
  );
}
