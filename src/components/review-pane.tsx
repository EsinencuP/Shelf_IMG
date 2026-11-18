'use client';

import { useEffect, useRef, useState } from 'react';
import {
  AlertCircle,
  Check,
  Download,
  ExternalLink,
  ImagePlus,
  Loader2,
  ScanLine,
  X,
  ArrowRight,
  Search,
} from 'lucide-react';
import type { Candidate, ExportProfile, ProductRow, VisionResult } from '@/lib/types';
import { apiFetch, candidateImageEndpoint } from '@/lib/client-api';
import { safeFileStem, downloadBlob } from '@/lib/export';
import BlobImage from './blob-image';
import CandidatePhoto from './candidate-photo';
import { isSourceFailure, sourceDiagnostic, SOURCE_STATUS_LABELS } from '@/lib/source-status';
import { canSearchByName, rowSearchError, rowSearchProduct, rowTitle } from '@/lib/row-search';

export default function ReviewPane({
  row,
  profile,
  geminiConfigured,
  databaseConfigured,
  onPatch,
  onCommit,
  onClose,
  onNotice,
  disabled,
  onBusy,
  onNext,
  onSearch,
  searchMode,
}: {
  row: ProductRow;
  profile: ExportProfile;
  geminiConfigured: boolean;
  databaseConfigured?: boolean;
  disabled: boolean;
  onPatch: (id: string, patch: Partial<ProductRow>) => void;
  onCommit: (id: string, patch: Partial<ProductRow>) => Promise<void>;
  onClose: () => void;
  onNotice: (message: string, error?: boolean) => void;
  onBusy: (busy: boolean) => void;
  onNext?: () => void;
  onSearch: (expanded: boolean, byName?: boolean) => void;
  searchMode: 'moldova' | 'expanded';
}) {
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState('');
  const [url, setUrl] = useState('');
  const headingRef = useRef<HTMLHeadingElement>(null);
  const candidateImages = useRef(new Map<Candidate, Blob>());
  useEffect(() => {
    setUrl('');
    headingRef.current?.focus({ preventScroll: false });
  }, [row.id]);
  useEffect(() => {
    const images = candidateImages.current;
    return () => images.clear();
  }, [row.candidates]);
  const vision = row.vision;
  function working(value: boolean) {
    setBusy(value);
    onBusy(value);
  }
  const candidate = row.candidates.find((item) => item.id === row.selectedCandidateId);
  const sourceDiagnostics = (row.searchDiagnostics ?? []).map(sourceDiagnostic);
  const inputError = rowSearchError(row);
  const nameSearch = canSearchByName(row);
  const validIdentity = !inputError || nameSearch;
  const locked = busy || disabled;
  const patch = (value: Partial<ProductRow>) => onPatch(row.id, value);

  async function chooseCandidate(item: Candidate) {
    working(true);
    setProgress('Загружаем исходную фотографию…');
    try {
      const blob =
        candidateImages.current.get(item) ??
        (await (await apiFetch(candidateImageEndpoint(item))).blob());
      patch({
        originalBlob: blob,
        outputBlob: undefined,
        selectedCandidateId: item.id,
        status: 'review',
        confirmed: false,
        rightsConfirmed: item.rights === 'open_license',
        error: undefined,
        qualityWarnings: [],
        vision: undefined,
        processingOverride: undefined,
      });
    } catch (error) {
      onNotice(error instanceof Error ? error.message : 'Не удалось загрузить фотографию.', true);
    } finally {
      working(false);
      setProgress('');
    }
  }

  async function approve(next = false) {
    if (!row.outputBlob || !row.rightsConfirmed || !validIdentity || vision?.verdict === 'conflict')
      return;
    working(true);
    setProgress('Сохраняем подтверждённое изображение…');
    let savedId: string | undefined;
    let saveError: string | undefined;
    try {
      if (databaseConfigured && candidate) {
        const bytes = new Uint8Array(await row.outputBlob.arrayBuffer());
        if (bytes.length > 2_097_152)
          throw new Error('Фото больше 2 МБ: экспорт доступен, общая база не пополнена.');
        const parts: string[] = [];
        for (let i = 0; i < bytes.length; i += 8192)
          parts.push(String.fromCharCode(...bytes.subarray(i, i + 8192)));
        const response = await apiFetch('/api/library', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            product: rowSearchProduct(row, nameSearch),
            candidate,
            confirmed: true,
            rightsConfirmed: true,
            image: btoa(parts.join('')),
          }),
        });
        savedId = (await response.json()).id;
      }
    } catch (error) {
      saveError = error instanceof Error ? error.message : 'Не удалось сохранить в общий каталог.';
    }
    try {
      await onCommit(row.id, { status: 'ready', confirmed: true, libraryId: savedId });
    } catch (error) {
      onNotice(
        error instanceof Error ? error.message : 'Не удалось сохранить подтверждение.',
        true,
      );
      return;
    } finally {
      working(false);
      setProgress('');
    }
    onNotice(
      saveError
        ? 'Фото добавлено в экспорт. Общий каталог: ' + saveError
        : databaseConfigured
          ? 'Фото подтверждено, сохранено в общий каталог и добавлено в экспорт.'
          : 'Изображение подтверждено и добавлено в экспорт.',
      !!saveError,
    );
    if (next) onNext?.();
  }

  async function upload(file?: File) {
    if (!file) return;
    if (
      ![
        'image/jpeg',
        'image/png',
        'image/webp',
        'image/avif',
        'image/gif',
        'image/tiff',
        'image/x-tiff',
      ].includes(file.type) ||
      file.size > 4 * 1024 * 1024
    ) {
      onNotice('Загрузите JPG, PNG, WebP, AVIF, статический GIF или TIFF размером до 4 МБ.', true);
      return;
    }
    let original: Blob = file;
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) {
      working(true);
      setProgress('Преобразуем формат фотографии в облаке…');
      try {
        const response = await apiFetch('/api/image', {
          method: 'POST',
          headers: { 'Content-Type': 'application/octet-stream' },
          body: file,
        });
        original = await response.blob();
      } catch (error) {
        onNotice(error instanceof Error ? error.message : 'Не удалось преобразовать фото.', true);
        return;
      } finally {
        working(false);
        setProgress('');
      }
    }
    const item: Candidate = {
      id: crypto.randomUUID(),
      title: file.name,
      imageUrl: '',
      pageUrl: '',
      source: 'Загружено пользователем',
      rights: 'user_owned',
      gtinExact: false,
      warnings: ['Соответствие SKU подтверждается пользователем.'],
    };
    patch({
      candidates: [...row.candidates, item],
      selectedCandidateId: item.id,
      originalBlob: original,
      outputBlob: undefined,
      status: 'review',
      confirmed: false,
      rightsConfirmed: false,
      error: undefined,
      qualityWarnings: [],
      vision: undefined,
      processingOverride: undefined,
    });
  }

  async function addUrl() {
    try {
      const parsed = new URL(url);
      if (parsed.protocol !== 'https:')
        throw new Error('Используйте HTTPS-ссылку на JPG, PNG или WebP.');
      const item: Candidate = {
        id: crypto.randomUUID(),
        title: rowTitle(row),
        imageUrl: parsed.href,
        pageUrl: parsed.href,
        source: 'Добавлено по ссылке',
        rights: 'unknown',
        gtinExact: false,
        warnings: ['Проверьте товар и право использования фотографии.'],
      };
      working(true);
      setProgress('Загружаем фотографию по ссылке…');
      const response = await apiFetch(`/api/image?url=${encodeURIComponent(item.imageUrl)}`);
      patch({
        candidates: [...row.candidates, item],
        selectedCandidateId: item.id,
        originalBlob: await response.blob(),
        outputBlob: undefined,
        status: 'review',
        confirmed: false,
        rightsConfirmed: false,
        error: undefined,
        qualityWarnings: [],
        vision: undefined,
        processingOverride: undefined,
      });
      setUrl('');
    } catch (error) {
      onNotice(error instanceof Error ? error.message : 'Не удалось добавить фотографию.', true);
    } finally {
      working(false);
      setProgress('');
    }
  }

  async function process() {
    if (!row.originalBlob) return;
    working(true);
    setProgress('Подготавливаем изображение…');
    patch({
      status: 'processing',
      error: undefined,
      outputBlob: undefined,
      outputWidth: undefined,
      outputHeight: undefined,
      processingMethod: undefined,
      confirmed: false,
    });
    try {
      const { processImage } = await import('@/lib/image-processing');
      const result = await processImage(
        row.originalBlob,
        { ...profile, method: row.processingOverride ?? profile.method },
        setProgress,
      );
      patch({
        outputBlob: result.blob,
        outputWidth: result.width,
        outputHeight: result.height,
        processingMethod: result.method,
        qualityWarnings: result.warnings,
        status: 'review',
        confirmed: false,
      });
    } catch (error) {
      patch({
        status: 'review',
        error: error instanceof Error ? error.message : 'Ошибка обработки фотографии.',
      });
    } finally {
      working(false);
      setProgress('');
    }
  }

  async function verify() {
    if (!row.originalBlob) return;
    working(true);
    setProgress('Проверяем признаки упаковки…');
    try {
      const form = new FormData();
      form.set('image', row.originalBlob, 'product.jpg');
      form.set(
        'product',
        JSON.stringify({
          ean: row.ean,
          nameRu: row.nameRu,
          nameRo: row.nameRo,
          brand: row.brand,
          quantity: row.quantity,
        }),
      );
      const response = await apiFetch('/api/verify', { method: 'POST', body: form });
      const result: VisionResult = await response.json();
      patch({
        vision: result,
        ...(result.verdict === 'conflict' ? { confirmed: false, status: 'review' as const } : {}),
      });
    } catch (error) {
      onNotice(error instanceof Error ? error.message : 'Не удалось проверить изображение.', true);
    } finally {
      working(false);
      setProgress('');
    }
  }

  function download() {
    if (!row.outputBlob) return;
    downloadBlob(
      row.outputBlob,
      `${safeFileStem(profile.naming === 'sku' ? row.sku : row.internalCode || row.sku)}.jpg`,
    );
  }

  return (
    <aside className="review-pane" aria-label="Проверка изображения товара">
      <div className="review-heading">
        <div>
          <span className="eyebrow">ПРОВЕРКА ТОВАРА</span>
          <h2 ref={headingRef} tabIndex={-1}>
            {row.sku}
          </h2>
        </div>
        <button
          className="icon-button"
          disabled={locked}
          onClick={onClose}
          aria-label="Закрыть карточку"
        >
          <X size={19} />
        </button>
      </div>
      {onNext && (
        <button className="text-button review-next" disabled={locked} onClick={onNext}>
          Следующий SKU <ArrowRight size={14} />
        </button>
      )}
      <p className="review-name">{rowTitle(row)}</p>
      {row.nameRu && row.nameRo && <p className="muted small">{row.nameRo}</p>}
      <div className="product-attributes">
        <span>
          EAN <strong>{row.ean || 'не указан'}</strong>
        </span>
        {row.quantity && (
          <span>
            Объём <strong>{row.quantity}</strong>
          </span>
        )}
        {row.widthMm && row.heightMm && (
          <span>
            Габариты{' '}
            <strong>
              {row.widthMm} × {row.heightMm}
              {row.depthMm ? ` × ${row.depthMm}` : ''} мм
            </strong>
          </span>
        )}
      </div>
      {!!row.inputWarnings?.length && (
        <details className="search-diagnostics">
          <summary>Проверка данных Excel ({row.inputWarnings.length})</summary>
          <p>{row.inputWarnings.join(' ')}</p>
        </details>
      )}
      {!row.originalBlob && row.error && (
        <div className="notice-inline danger">
          <AlertCircle size={15} />
          <span>{row.error}</span>
        </div>
      )}
      {row.searchJobMessage && (
        <div className="notice-inline" role="status">
          <Loader2 size={15} className="spin" />
          <span>{row.searchJobMessage}. Вкладку можно закрыть.</span>
        </div>
      )}
      {!row.originalBlob && row.qualityWarnings.length > 0 && (
        <div className="notice-inline">
          <AlertCircle size={15} />
          <span>{row.qualityWarnings.join(' ')}</span>
        </div>
      )}

      {
        <details className="search-diagnostics" hidden={!sourceDiagnostics.length}>
          <summary>
            Поиск по источникам (
            {sourceDiagnostics.filter((item) => item.status !== 'disabled').length} проверено,{' '}
            {sourceDiagnostics.filter((item) => isSourceFailure(item.status)).length} ошибок)
          </summary>
          <ul>
            {sourceDiagnostics.map((source) => (
              <li key={source.id} data-source-status={source.status}>
                <span>{source.source}</span>
                <strong>
                  {source.status === 'ok'
                    ? source.id === 'barcode-identity'
                      ? 'Название найдено'
                      : `${source.count} фото`
                    : SOURCE_STATUS_LABELS[source.status]}
                </strong>
                <small>{source.reason}</small>
              </li>
            ))}
          </ul>
        </details>
      }
      {!row.originalBlob && (
        <>
          {row.searchCoverage === 'partial' && row.candidates.length > 0 && (
            <p className="muted small">
              Поиск неполный. Некоторые источники пропущены или недоступны.
            </p>
          )}
          <div className="review-actions">
            <button
              className="button secondary"
              disabled={locked || (!!inputError && !nameSearch)}
              onClick={() => onSearch(false, nameSearch)}
            >
              <Search size={15} />
              {nameSearch
                ? 'Искать по названию'
                : row.searchDiagnostics?.length
                  ? 'Повторить поиск'
                  : 'Найти фотографии'}
            </button>
            {searchMode === 'moldova' && !inputError && (
              <button className="text-button" disabled={locked} onClick={() => onSearch(true)}>
                Расширить поиск для SKU
              </button>
            )}
          </div>
          <div className="section-label">
            <h3>Найденные фотографии</h3>
            <span>{row.candidates.length}</span>
          </div>
          {row.candidates.length ? (
            <div className="candidate-grid">
              {row.candidates
                .filter((item) => item.imageUrl)
                .map((item, index) => (
                  <button
                    key={item.id}
                    className="candidate-card"
                    disabled={locked}
                    onClick={() => chooseCandidate(item)}
                  >
                    <div className="candidate-photo">
                      <CandidatePhoto
                        candidate={item}
                        prefetch={index < 3}
                        images={candidateImages}
                      />
                    </div>
                    <span>{item.source}</span>
                    <strong>{item.title}</strong>
                    <small className={item.gtinExact ? 'good-text' : 'muted'}>
                      {item.matchStatus === 'metadata_conflict'
                        ? 'EAN совпадает · конфликт данных'
                        : item.gtinExact
                          ? 'EAN карточки совпадает'
                          : 'Требуется проверка'}
                    </small>
                  </button>
                ))}
            </div>
          ) : (
            <div className="review-empty">
              <ImagePlus size={28} />
              <p>Добавьте фотографию или запустите поиск.</p>
            </div>
          )}
        </>
      )}

      {row.originalBlob && (
        <>
          <div className="comparison">
            <div>
              <span>Исходник</span>
              <div className="comparison-image">
                <BlobImage blob={row.originalBlob} alt="Исходная фотография товара" />
              </div>
            </div>
            <div>
              <span>Для Shelf</span>
              <div className="comparison-image">
                {row.outputBlob ? (
                  <BlobImage blob={row.outputBlob} alt="Подготовленный JPG на белом фоне" />
                ) : (
                  <div className="preview-placeholder">
                    <ScanLine size={27} />
                    <small>После обработки</small>
                  </div>
                )}
              </div>
            </div>
          </div>
          <div className="source-line">
            {candidate?.pageUrl ? (
              <a href={candidate.pageUrl} target="_blank" rel="noopener noreferrer">
                {candidate.source}
                <ExternalLink size={13} />
              </a>
            ) : (
              <span>{candidate?.source || 'Собственная фотография'}</span>
            )}
            {candidate?.license && <small>{candidate.license}</small>}
          </div>
          {candidate?.warnings.length ? (
            <div className="notice-inline">
              <AlertCircle size={15} />
              <span>{candidate.warnings.join(' ')}</span>
            </div>
          ) : null}
          <div className="review-actions">
            <button className="button secondary" disabled={locked} onClick={() => process()}>
              <ScanLine size={16} />
              {row.outputBlob ? 'Обработать снова' : 'Подготовить JPG'}
            </button>
            {geminiConfigured && (
              <button className="button subtle" disabled={locked} onClick={verify}>
                Проверить Gemini
              </button>
            )}
          </div>
          <label className="photo-method">
            Обработка этой фотографии
            <select
              value={row.processingOverride ?? ''}
              disabled={locked}
              onChange={(event) =>
                patch({
                  processingOverride: event.target.value
                    ? (event.target.value as ExportProfile['method'])
                    : undefined,
                  outputBlob: undefined,
                  outputWidth: undefined,
                  outputHeight: undefined,
                  processingMethod: undefined,
                  confirmed: false,
                  status: 'review',
                  error: undefined,
                })
              }
            >
              <option value="">Как в настройках партии</option>
              <option value="white">Обрезка светлого фона — сохранить упаковку</option>
              <option value="ai">Нейросеть в браузере</option>
            </select>
          </label>
          <button
            className="text-button"
            disabled={locked}
            onClick={() =>
              patch({
                originalBlob: undefined,
                outputBlob: undefined,
                confirmed: false,
                rightsConfirmed: false,
                status: 'review',
                selectedCandidateId: undefined,
                qualityWarnings: [],
                error: undefined,
                vision: undefined,
                processingOverride: undefined,
              })
            }
          >
            Выбрать другую фотографию
          </button>
          {vision && (
            <div className={`vision-result ${vision.verdict === 'conflict' ? 'danger' : ''}`}>
              <strong>
                {vision.verdict === 'consistent'
                  ? 'Признаки согласуются'
                  : vision.verdict === 'conflict'
                    ? 'Найдено противоречие'
                    : 'Недостаточно данных'}
              </strong>
              <p>{vision.reasons.join(' ')}</p>
              <small>
                AI-проверка помогает принять решение; проверьте фотографию самостоятельно.
              </small>
            </div>
          )}
          {row.qualityWarnings.length > 0 && (
            <div className="notice-inline">
              <AlertCircle size={15} />
              <span>{row.qualityWarnings.join(' ')}</span>
            </div>
          )}
          {row.error && (
            <div className="notice-inline danger">
              <AlertCircle size={15} />
              <span>{row.error}</span>
            </div>
          )}
          {row.outputBlob && (
            <div className="approval-box">
              <label className="checkbox-label">
                <input
                  type="checkbox"
                  checked={!!row.rightsConfirmed}
                  disabled={locked || row.status === 'ready'}
                  onChange={(event) => patch({ rightsConfirmed: event.target.checked })}
                />
                <span>
                  Есть право использовать и обрабатывать фото
                  {candidate?.rights === 'open_license' ? ` (${candidate.license})` : ''}.
                </span>
              </label>
              <p>Проверьте вариант, объём, крышку и дно. Этикетка должна соответствовать SKU.</p>
              {row.status === 'ready' ? (
                <>
                  <div className="approved">
                    <Check size={17} />
                    Подтверждено · {row.outputWidth} × {row.outputHeight} px
                  </div>
                  <div className="review-actions">
                    <button className="button secondary" onClick={download}>
                      <Download size={16} />
                      Скачать JPG
                    </button>
                    <button
                      className="text-button"
                      disabled={locked}
                      onClick={() => patch({ status: 'review', confirmed: false })}
                    >
                      Отменить подтверждение
                    </button>
                  </div>
                </>
              ) : (
                <>
                  <button
                    className="button primary full"
                    disabled={
                      locked ||
                      !validIdentity ||
                      !row.rightsConfirmed ||
                      vision?.verdict === 'conflict'
                    }
                    onClick={() => void approve()}
                  >
                    <Check size={17} />
                    Подтвердить для экспорта
                  </button>
                  {onNext && (
                    <button
                      className="button secondary full"
                      disabled={
                        locked ||
                        !validIdentity ||
                        !row.rightsConfirmed ||
                        vision?.verdict === 'conflict'
                      }
                      onClick={() => void approve(true)}
                    >
                      Подтвердить и перейти дальше <ArrowRight size={16} />
                    </button>
                  )}
                </>
              )}
            </div>
          )}
        </>
      )}

      {busy && (
        <div className="processing-note" role="status">
          <Loader2 size={17} className="spin" />
          {progress}
        </div>
      )}
      {!row.originalBlob && (
        <div className="manual-source">
          <label className={`upload-photo ${locked ? 'disabled' : ''}`}>
            <ImagePlus size={18} />
            Загрузить свою фотографию
            <input
              type="file"
              accept="image/jpeg,image/png,image/webp,image/avif,image/gif,image/tiff,image/x-tiff"
              disabled={locked}
              onChange={(event) => {
                void upload(event.target.files?.[0]);
                event.target.value = '';
              }}
            />
          </label>
          <span className="muted small">JPG, PNG, WebP, AVIF, GIF или TIFF · до 4 МБ</span>
          <label className="field-label" htmlFor="image-url">
            Или прямая ссылка на изображение
          </label>
          <div className="inline-input">
            <input
              id="image-url"
              type="url"
              value={url}
              onChange={(event) => setUrl(event.target.value)}
              placeholder="https://…/product.jpg"
              disabled={locked}
            />
            <button className="button secondary" onClick={addUrl} disabled={locked || !url.trim()}>
              Добавить
            </button>
          </div>
        </div>
      )}
    </aside>
  );
}
