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
import { apiFetch } from '@/lib/client-api';
import { safeFileStem, downloadBlob } from '@/lib/export';
import BlobImage from './blob-image';

export default function ReviewPane({
  row,
  profile,
  geminiConfigured,
  onPatch,
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
  disabled: boolean;
  onPatch: (id: string, patch: Partial<ProductRow>) => void;
  onClose: () => void;
  onNotice: (message: string, error?: boolean) => void;
  onBusy: (busy: boolean) => void;
  onNext?: () => void;
  onSearch: (expanded: boolean) => void;
  searchMode: 'moldova' | 'expanded';
}) {
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState('');
  const [url, setUrl] = useState('');
  const headingRef = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    setUrl('');
    headingRef.current?.focus({ preventScroll: false });
  }, [row.id]);
  const vision = row.vision;
  function working(value: boolean) {
    setBusy(value);
    onBusy(value);
  }
  const candidate = row.candidates.find((item) => item.id === row.selectedCandidateId);
  const validIdentity = !!row.sku.trim() && !!(row.nameRu.trim() || row.nameRo.trim());
  const locked = busy || disabled;
  const patch = (value: Partial<ProductRow>) => onPatch(row.id, value);

  async function chooseCandidate(item: Candidate) {
    working(true);
    setProgress('Загружаем исходную фотографию…');
    try {
      const response = await apiFetch(`/api/image?url=${encodeURIComponent(item.imageUrl)}`);
      const blob = await response.blob();
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

  async function upload(file?: File) {
    if (!file) return;
    if (
      !['image/jpeg', 'image/png', 'image/webp'].includes(file.type) ||
      file.size > 4 * 1024 * 1024
    ) {
      onNotice('Загрузите JPG, PNG или WebP размером до 4 МБ.', true);
      return;
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
      originalBlob: file,
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
        title: row.nameRu || row.nameRo,
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
      <p className="review-name">{row.nameRu || row.nameRo}</p>
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
        <div className="notice-inline">
          <AlertCircle size={15} />
          <span>{row.inputWarnings.join(' ')}</span>
        </div>
      )}
      {!row.originalBlob && row.error && (
        <div className="notice-inline danger">
          <AlertCircle size={15} />
          <span>{row.error}</span>
        </div>
      )}
      {!row.originalBlob && row.qualityWarnings.length > 0 && (
        <div className="notice-inline">
          <AlertCircle size={15} />
          <span>{row.qualityWarnings.join(' ')}</span>
        </div>
      )}

      {
        <details className="search-diagnostics" hidden={!row.searchDiagnostics?.length}>
          <summary>
            Поиск по источникам (
            {row.searchDiagnostics?.filter(
              (item) => item.status === 'ok' || item.status === 'unavailable',
            ).length ?? 0}{' '}
            проверено)
          </summary>
          <ul>
            {row.searchDiagnostics?.map((source) => (
              <li key={source.id}>
                <span>{source.source}</span>
                <strong>
                  {source.status === 'ok'
                    ? `${source.count} фото`
                    : source.status === 'not_configured'
                      ? 'Нет ключа'
                      : source.status === 'skipped'
                        ? source.message?.includes('Отключён') ||
                          source.message?.includes('выключен')
                          ? 'Отключён'
                          : 'Не требуется'
                        : 'Недоступен'}
                </strong>
                {source.message && <small>{source.message}</small>}
              </li>
            ))}
          </ul>
        </details>
      }
      {!row.originalBlob && (
        <>
          <div className="review-actions">
            <button className="button secondary" disabled={locked} onClick={() => onSearch(false)}>
              <Search size={15} />
              {row.searchDiagnostics?.length ? 'Повторить поиск' : 'Найти фотографии'}
            </button>
            {searchMode === 'moldova' && (
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
                .map((item) => (
                  <button
                    key={item.id}
                    className="candidate-card"
                    disabled={locked}
                    onClick={() => chooseCandidate(item)}
                  >
                    <div className="candidate-photo">
                      <img
                        src={item.imageUrl}
                        alt={item.title}
                        loading="lazy"
                        referrerPolicy="no-referrer"
                      />
                    </div>
                    <span>{item.source}</span>
                    <strong>{item.title}</strong>
                    <small className={item.gtinExact ? 'good-text' : 'muted'}>
                      {item.gtinExact ? 'EAN карточки совпадает' : 'Требуется проверка'}
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
              <option value="ai">Локальная нейросеть</option>
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
                    onClick={() => {
                      patch({ status: 'ready', confirmed: true });
                      onNotice('Изображение подтверждено и добавлено в экспорт.');
                    }}
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
                      onClick={() => {
                        patch({ status: 'ready', confirmed: true });
                        onNext();
                        onNotice('Изображение подтверждено. Открыт следующий SKU.');
                      }}
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
              accept="image/jpeg,image/png,image/webp"
              disabled={locked}
              onChange={(event) => {
                void upload(event.target.files?.[0]);
                event.target.value = '';
              }}
            />
          </label>
          <span className="muted small">JPG, PNG или WebP · до 4 МБ</span>
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
