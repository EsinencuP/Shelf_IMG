'use client';

import { useEffect, useRef, useState } from 'react';
import { ArrowDownToLine, ArrowRight, Check, ChevronRight, CircleHelp, Clock3, CloudUpload, Database, Download, FileSpreadsheet, FolderOpen, Globe, ImageIcon, Layers, Loader2, Plus, Search, Settings2, ShieldCheck, Square, Trash2, X } from 'lucide-react';
import type { AppConfig, Batch, ExportProfile, ParsedSheet, ProductRow, RowStatus, SearchResponse } from '@/lib/types';
import { DEFAULT_PROFILE, STATUS_LABELS } from '@/lib/types';
import { parseFile, downloadTemplate } from '@/lib/import';
import { deleteBatch, listBatches, saveBatch } from '@/lib/storage';
import { exportBatch } from '@/lib/export';
import { apiFetch, setAccessPassword } from '@/lib/client-api';
import ImportDialog from './import-dialog';
import ReviewPane from './review-pane';
import BlobImage from './blob-image';
import Modal from './modal';

type Tab = 'workspace' | 'history' | 'sources';
type Filter = 'all' | 'review' | 'ready' | 'unresolved';
const formatDate = (value: string) => new Intl.DateTimeFormat('ru', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }).format(new Date(value));
const errorText = (reason: unknown) => reason instanceof Error ? reason.message : 'Не удалось выполнить действие.';

export default function Workspace() {
  const [tab, setTab] = useState<Tab>('workspace');
  const [batch, setBatch] = useState<Batch | null>(null);
  const [history, setHistory] = useState<Batch[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [config, setConfig] = useState<AppConfig>({ braveConfigured: false, geminiConfigured: false, accessProtected: false });
  const [imported, setImported] = useState<{ sheet: ParsedSheet; filename: string } | null>(null);
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
  const [password, setPassword] = useState('');
  const [authBusy, setAuthBusy] = useState(false);
  const [saved, setSaved] = useState(true);
  const [toast, setToast] = useState<{ message: string; error: boolean } | null>(null);
  const [operation, setOperation] = useState<{ kind: 'search' | 'process'; total: number; done: number; message: string } | null>(null);
  const [exporting, setExporting] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const batchRef = useRef<Batch | null>(null);
  const stopRef = useRef(false);
  const controllerRef = useRef<AbortController | null>(null);
  const busy = !!operation;

  function notify(message: string, error = false) { setToast({ message, error }); }
  function changeBatch(value: Batch | null) { batchRef.current = value; setBatch(value); }
  function patchRow(id: string, patch: Partial<ProductRow>) {
    const current = batchRef.current;
    if (!current) return;
    changeBatch({ ...current, rows: current.rows.map(row => row.id === id ? { ...row, ...patch } : row) });
  }
  async function persistCurrent() { if (batchRef.current) await saveBatch(batchRef.current); }

  useEffect(() => {
    let alive = true;
    listBatches().then(items => { if (!alive) return; setHistory(items); if (items[0]) { batchRef.current = items[0]; setBatch(items[0]); setProfile(items[0].profile); } }).catch(error => { if (alive) setToast({ message: errorText(error), error: true }); }).finally(() => { if (alive) setLoaded(true); });
    fetch('/api/config').then(response => response.json()).then(value => { if (alive) setConfig(value); }).catch(() => { if (alive) setToast({ message: 'Не удалось проверить источники. Загрузка своих фото доступна.', error: true }); });
    return () => { alive = false; controllerRef.current?.abort(); };
  }, []);

  useEffect(() => {
    if (!batch || !loaded) return;
    setSaved(false);
    const timer = window.setTimeout(() => {
      saveBatch(batch).then(() => { setSaved(true); setHistory(current => [batch, ...current.filter(item => item.id !== batch.id)].sort((a, b) => b.createdAt.localeCompare(a.createdAt))); }).catch(reason => notify(errorText(reason), true));
    }, 350);
    return () => window.clearTimeout(timer);
  }, [batch, loaded]);

  useEffect(() => { if (!toast) return; const timer = setTimeout(() => setToast(null), toast.error ? 18000 : 6000); return () => clearTimeout(timer); }, [toast]);

  const rows = batch?.rows ?? [];
  const ready = rows.filter(row => row.status === 'ready' && row.confirmed && row.rightsConfirmed && row.outputBlob).length;
  const review = rows.filter(row => row.status === 'review').length;
  const unresolved = rows.filter(row => ['not_found', 'error'].includes(row.status)).length;
  const activeRow = rows.find(row => row.id === activeId);
  const filtered = rows.filter(row => {
    if (filter === 'ready' && row.status !== 'ready') return false;
    if (filter === 'review' && row.status !== 'review') return false;
    if (filter === 'unresolved' && !['not_found', 'error'].includes(row.status)) return false;
    return `${row.sku} ${row.internalCode} ${row.ean} ${row.nameRu} ${row.nameRo}`.toLowerCase().includes(query.toLowerCase());
  });

  async function importFile(file?: File) {
    if (!file || busy) return;
    setLoadingFile(true);
    try { setImported({ sheet: await parseFile(file), filename: file.name }); }
    catch (error) { notify(errorText(error), true); }
    finally { setLoadingFile(false); }
  }

  function createBatch(name: string, importedRows: ProductRow[]) {
    const next: Batch = { id: crypto.randomUUID(), name, createdAt: new Date().toISOString(), rows: importedRows, profile };
    changeBatch(next); setImported(null); setActiveId(null); setSelected(new Set()); setFilter('all'); setQuery(''); setTab('workspace');
    notify(`Импортировано ${importedRows.length} товарных позиций.`);
  }

  async function searchRows() {
    if (!batch || busy) return;
    const targets = selected.size ? rows.filter(row => selected.has(row.id) && row.status !== 'ready' && !row.originalBlob) : rows.filter(row => ['pending', 'not_found', 'error'].includes(row.status) && !row.originalBlob);
    if (!targets.length) { notify('Все найденные позиции уже на проверке. Откройте карточку товара или выберите строки для повторного поиска.'); return; }
    stopRef.current = false;
    setOperation({ kind: 'search', total: targets.length, done: 0, message: 'Запускаем поиск…' });
    let completed = 0;
    try {
      for (const row of targets) {
        if (stopRef.current) break;
        const controller = new AbortController(); controllerRef.current = controller;
        patchRow(row.id, { status: 'searching', error: undefined });
        setOperation({ kind: 'search', total: targets.length, done: completed, message: `Ищем ${row.sku} · ${row.nameRu || row.nameRo}` });
        try {
          const response = await apiFetch('/api/search', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sku: row.sku, internalCode: row.internalCode, ean: row.ean, nameRu: row.nameRu, nameRo: row.nameRo, brand: row.brand, quantity: row.quantity }), signal: controller.signal });
          const result: SearchResponse = await response.json();
          patchRow(row.id, { candidates: result.candidates, status: result.candidates.length ? 'review' : 'not_found', qualityWarnings: result.warnings, selectedCandidateId: undefined, confirmed: false });
        } catch (error) {
          patchRow(row.id, { status: controller.signal.aborted ? row.status : 'error', error: controller.signal.aborted ? undefined : errorText(error) });
          if (!controller.signal.aborted && /пароль|MVP_ACCESS_PASSWORD|401|503|quota|квот/i.test(errorText(error))) { notify(errorText(error), true); stopRef.current = true; }
        }
        completed++; await persistCurrent();
        setOperation(current => current ? { ...current, done: completed } : current);
      }
      if (!stopRef.current) notify('Поиск завершён. Проверьте найденные фотографии в карточках товаров.');
    } catch (error) { notify(errorText(error), true); }
    finally { controllerRef.current = null; setOperation(null); }
  }

  async function processRows() {
    if (!batch || busy) return;
    const targets = rows.filter(row => row.originalBlob && row.status !== 'ready' && (!selected.size || selected.has(row.id)));
    if (!targets.length) { notify('Сначала выберите исходные фотографии в карточках товаров.'); return; }
    stopRef.current = false; setOperation({ kind: 'process', total: targets.length, done: 0, message: 'Загружаем модель обработки…' });
    let completed = 0;
    try {
      const { processImage } = await import('@/lib/image-processing');
      for (const row of targets) {
        if (stopRef.current) break;
        patchRow(row.id, { status: 'processing', error: undefined });
        try {
          const result = await processImage(row.originalBlob!, batch.profile, message => setOperation({ kind: 'process', total: targets.length, done: completed, message: `${row.sku} · ${message}` }));
          patchRow(row.id, { status: 'review', outputBlob: result.blob, outputWidth: result.width, outputHeight: result.height, processingMethod: result.method, qualityWarnings: result.warnings, confirmed: false });
        } catch (error) { patchRow(row.id, { status: 'review', error: errorText(error) }); }
        completed++; await persistCurrent();
      }
      if (!stopRef.current) notify('Фотографии подготовлены. Подтвердите результат перед экспортом.');
    } catch (error) { notify(errorText(error), true); }
    finally { setOperation(null); }
  }

  async function exportZip() {
    if (!batch || exporting || busy) return;
    setExporting(true);
    try { await exportBatch(batch); notify(`Архив подготовлен: ${ready} JPG и отчёт по всем ${rows.length} строкам.`); }
    catch (error) { notify(errorText(error), true); }
    finally { setExporting(false); }
  }

  async function template() { try { await downloadTemplate(); } catch (error) { notify(errorText(error), true); } }
  function openBatch(item: Batch) { if (busy) return; changeBatch(item); setProfile(item.profile); setActiveId(null); setSelected(new Set()); setQuery(''); setFilter('all'); setTab('workspace'); }
  function updateProfile(next: ExportProfile) { setProfile(next); if (batchRef.current) changeBatch({ ...batchRef.current, profile: next }); }

  return <div className="app-shell">
    <input ref={fileRef} className="visually-hidden" type="file" accept=".xlsx,.csv" aria-label="Загрузить Excel или CSV" onChange={event => { void importFile(event.target.files?.[0]); event.target.value = ''; }} />
    <header className="topbar"><a href="/" className="brand" aria-label="Shelf Studio"><span className="brand-mark"><Layers size={23} strokeWidth={1.8} /></span><strong>shelf<span>studio</span></strong><span className="version-badge">MVP</span></a><div className="topbar-right"><span className="local-badge"><span className="status-dot" />Данные в этом браузере</span><button className="icon-button" onClick={() => setHelpOpen(true)} aria-label="Как это работает"><CircleHelp size={19} /></button><button className="button secondary compact" onClick={() => setSettingsOpen(true)} disabled={busy}><Settings2 size={16} />Настройки</button></div></header>

    <div className="body-layout"><nav className="sidebar" aria-label="Основная навигация"><span className="nav-label">РАБОЧЕЕ ПРОСТРАНСТВО</span><button className={tab === 'workspace' ? 'nav-item active' : 'nav-item'} onClick={() => setTab('workspace')}><ImageIcon size={18} />Подготовка фото<ChevronRight size={15} /></button><button className={tab === 'history' ? 'nav-item active' : 'nav-item'} onClick={() => setTab('history')}><FolderOpen size={18} />Мои партии<span className="nav-count">{history.length}</span></button><button className={tab === 'sources' ? 'nav-item active' : 'nav-item'} onClick={() => setTab('sources')}><Globe size={18} />Источники</button><div className="sidebar-footer"><div className="shelf-mini"><ShieldCheck size={20} /><strong>Профиль Shelf</strong></div><p>Белый фон.<br />Точные границы упаковки.<br />Сохранённые пропорции.</p><button className="text-button" onClick={() => setSettingsOpen(true)} disabled={busy}>Параметры экспорта<ArrowRight size={14} /></button></div></nav>

    <main className="main-content">
      <div className="page-heading"><div><span className="eyebrow">ИЗОБРАЖЕНИЯ ДЛЯ ПЛАНОГРАММ</span><h1>{tab === 'history' ? 'Мои партии' : tab === 'sources' ? 'Источники изображений' : 'Подготовка фотографий'}</h1><p>{tab === 'history' ? 'Сохранённые партии и результаты обработки в этом браузере.' : tab === 'sources' ? 'Поиск по штрихкоду, дополнительные каталоги и проверка упаковки.' : 'От списка товаров до готовых изображений для Shelf.'}</p></div>{tab !== 'sources' && <button className="button primary" disabled={busy || loadingFile} onClick={() => fileRef.current?.click()}><Plus size={18} />Новая партия</button>}</div>

      {tab === 'workspace' && <>
        <div className="workflow-strip" aria-label="Этапы работы">{[['01', 'Загрузить Excel', FileSpreadsheet], ['02', 'Найти и проверить', Search], ['03', 'Подготовить JPG', ImageIcon], ['04', 'Скачать ZIP', ArrowDownToLine]].map(([number, label, Icon], index) => { const StepIcon = Icon as typeof FileSpreadsheet; return <div className={`workflow-step ${index === 0 && !batch ? 'current' : ''}`} key={number as string}><span className="step-number">{number as string}</span><StepIcon size={17} /><span>{label as string}</span>{index < 3 && <ChevronRight size={15} className="step-arrow" />}</div>; })}</div>

        {!batch ? <div className="empty-workspace"><div className={`dropzone ${dragging ? 'dragging' : ''}`} onDragOver={event => { event.preventDefault(); setDragging(true); }} onDragLeave={() => setDragging(false)} onDrop={event => { event.preventDefault(); setDragging(false); void importFile(event.dataTransfer.files[0]); }}><div className="upload-illustration"><div className="sheet-back" /><div className="sheet-front"><FileSpreadsheet size={45} strokeWidth={1.2} /><span>.xlsx</span></div><span className="upload-bubble"><CloudUpload size={22} /></span></div><span className="eyebrow">НАЧНИТЕ С ТОВАРНОГО СПИСКА</span><h2>Ваш Excel. Готовые фотографии.</h2><p>Перетащите файл сюда или выберите его на компьютере.<br />Сопоставьте колонки — остальное соберём в одной партии.</p><button className="button primary" disabled={loadingFile || !loaded} onClick={() => fileRef.current?.click()}>{loadingFile ? <Loader2 size={18} className="spin" /> : <CloudUpload size={18} />}{loadingFile ? 'Читаем таблицу…' : 'Загрузить Excel'}</button><span className="file-hint">XLSX или CSV · до 10 МБ · до 500 позиций</span></div><div className="template-row"><div className="template-icon"><FileSpreadsheet size={21} /></div><div><strong>Не уверены в структуре файла?</strong><p>Используйте шаблон с кодами, названиями и габаритами.</p></div><button className="button secondary" onClick={template}><Download size={16} />Скачать шаблон</button></div><div className="empty-notes"><span><Check size={15} />Размеры товара сохраняются отдельно</span><span><Check size={15} />Экспорт после проверки SKU</span><span><Check size={15} />Локальная обработка без AI-токенов</span></div></div> : <>
          <div className="batch-summary"><div className="batch-identity"><span className="batch-icon"><FileSpreadsheet size={23} /></span><div><h2>{batch.name}</h2><p>{formatDate(batch.createdAt)}<span>·</span>{saved ? 'Сохранено в браузере' : 'Сохраняем…'}</p></div></div><div className="summary-stats"><div><strong>{rows.length}</strong><span>всего SKU</span></div><div className="stat-review"><strong>{review}</strong><span>на проверке</span></div><div className="stat-ready"><strong>{ready}</strong><span>готово</span></div></div></div>
          {!config.braveConfigured && <div className="source-notice"><Globe size={17} /><p>Без ключа доступен поиск продуктов питания по EAN в Open Food Facts. Для других категорий добавьте фото или подключите общий поиск.</p><button className="text-button" onClick={() => setTab('sources')}>Источники<ArrowRight size={14} /></button></div>}
          <div className="batch-toolbar"><div className="toolbar-actions"><button className="button primary" disabled={busy || loadingFile} onClick={searchRows}><Search size={16} />Найти изображения{selected.size > 0 && <span className="button-count">{selected.size}</span>}</button><button className="button secondary" disabled={busy || !rows.some(row => row.originalBlob && row.status !== 'ready')} onClick={processRows}><ImageIcon size={16} />Подготовить JPG</button></div><button className="button secondary" disabled={busy || exporting} onClick={exportZip}>{exporting ? <Loader2 className="spin" size={16} /> : <Download size={16} />}Скачать ZIP<span className="button-count">{ready}</span></button></div>
          {operation && <div className="operation-bar" role="status"><div><Loader2 size={18} className="spin" /><span>{operation.message}</span><strong>{operation.done}/{operation.total}</strong><button className="button subtle compact" onClick={() => { stopRef.current = true; controllerRef.current?.abort(); }}><Square size={12} />Остановить</button></div><progress max={operation.total} value={operation.done} /></div>}
          <div className={`workspace-grid ${activeRow ? 'has-review' : ''}`}><section className="product-table-card" aria-label="Товары партии"><div className="table-controls"><div className="filter-tabs" role="group" aria-label="Фильтр статуса">{([['all', 'Все', rows.length], ['review', 'Проверка', review], ['ready', 'Готово', ready], ['unresolved', 'Не найдены / ошибки', unresolved]] as const).map(([value, label, count]) => <button key={value} className={filter === value ? 'active' : ''} onClick={() => setFilter(value)}>{label}<span>{count}</span></button>)}</div><label className="search-input"><Search size={16} /><input value={query} onChange={event => setQuery(event.target.value)} placeholder="SKU, EAN или название" aria-label="Найти товар в партии" /></label></div>
          <div className="table-scroll"><table className="product-table"><thead><tr><th className="check-cell"><input type="checkbox" aria-label="Выбрать видимые товары" checked={filtered.length > 0 && filtered.every(row => selected.has(row.id))} onChange={event => { const next = new Set(selected); for (const row of filtered) { if (event.target.checked) next.add(row.id); else next.delete(row.id); } setSelected(next); }} /></th><th>ТОВАР</th><th>EAN / ГАБАРИТЫ</th><th>СТАТУС</th><th aria-label="Открыть" /></tr></thead><tbody>{filtered.map(row => <tr key={row.id} className={activeId === row.id ? 'active-row' : ''}><td className="check-cell"><input type="checkbox" aria-label={`Выбрать ${row.sku}`} checked={selected.has(row.id)} onChange={event => { const next = new Set(selected); if (event.target.checked) next.add(row.id); else next.delete(row.id); setSelected(next); }} /></td><td><button className="product-cell" onClick={() => setActiveId(row.id)}><div className="product-thumb">{row.outputBlob || row.originalBlob ? <BlobImage blob={row.outputBlob || row.originalBlob} alt="" /> : <ImageIcon size={19} />}</div><div><strong>{row.nameRu || row.nameRo}</strong><span>SKU {row.sku}{row.internalCode ? ` · Код ${row.internalCode}` : ''}</span></div></button></td><td><span className="ean-value">{row.ean || '—'}</span><span className="dimension-value">{row.widthMm && row.heightMm ? `${row.widthMm} × ${row.heightMm}${row.depthMm ? ` × ${row.depthMm}` : ''} мм` : 'Габариты не указаны'}</span></td><td><Status status={row.status} /></td><td><button className="icon-button" onClick={() => setActiveId(row.id)} aria-label={`Открыть ${row.sku}`}><ChevronRight size={18} /></button></td></tr>)}</tbody></table>{!filtered.length && <div className="table-empty"><Search size={25} /><p>По этому фильтру товаров нет.</p><button className="text-button" onClick={() => { setQuery(''); setFilter('all'); }}>Сбросить фильтры</button></div>}</div><div className="table-footer"><span>{filtered.length} из {rows.length} позиций{selected.size ? ` · выбрано ${selected.size}` : ''}</span><span>JPG · белый фон · до {batch.profile.maxSide} px</span></div></section>
          {activeRow && <ReviewPane key={activeRow.id} row={activeRow} profile={batch.profile} geminiConfigured={config.geminiConfigured} disabled={busy} onPatch={patchRow} onClose={() => setActiveId(null)} onNotice={notify} />}</div>
          <p className="workspace-footnote"><ShieldCheck size={14} />В ZIP входят подтверждённые фотографии. Отчёт содержит все исходные позиции.</p>
        </>}
      </>}

      {tab === 'history' && <section className="history-panel">{history.length ? <div className="history-list">{history.map(item => <article className="history-card" key={item.id}><span className="batch-icon"><FileSpreadsheet size={23} /></span><div><h2>{item.name}</h2><p>{formatDate(item.createdAt)} · {item.rows.length} SKU · {item.rows.filter(row => row.status === 'ready').length} готово</p></div><button className="button secondary" disabled={busy} onClick={() => openBatch(item)}>Открыть<ArrowRight size={16} /></button><button className="icon-button" disabled={busy} aria-label={`Удалить партию ${item.name}`} onClick={() => setDeleteTarget(item)}><Trash2 size={17} /></button></article>)}</div> : <div className="generic-empty"><FolderOpen size={36} /><h2>Здесь будут ваши партии</h2><p>Загрузите первый Excel. Результаты сохранятся в этом браузере.</p><button className="button primary" onClick={() => fileRef.current?.click()}><Plus size={16} />Создать партию</button></div>}<div className="storage-note"><Database size={20} /><div><strong>Хранение на этом устройстве</strong><p>Партии и фотографии хранятся в IndexedDB. Очистка данных сайта удалит историю. Скачивайте ZIP для резервной копии; облачную синхронизацию подключим отдельно.</p></div></div></section>}

      {tab === 'sources' && <><div className="sources-grid"><SourceCard name="Open Food Facts" type="БЕСПЛАТНЫЙ КАТАЛОГ" status="Доступен" enabled description="Фотографии продуктов питания по точному EAN. Каталог не охватывает все категории и рынки; результат нужно проверить." detail="Авторство и лицензия CC BY-SA сохраняются в отчёте." /><SourceCard name="Brave Search" type="ОБЩИЙ ПОИСК ИЗОБРАЖЕНИЙ" status={config.braveConfigured ? 'Подключён' : 'Нужен API-ключ'} enabled={config.braveConfigured} description="Поиск в интернете по штрихкоду и названиям RU / RO. Фотографии сторонних сайтов требуют проверки прав." detail="Подключение: BRAVE_SEARCH_API_KEY на сервере. Запросы расходуют квоту провайдера." /><SourceCard name="Gemini" type="ДОПОЛНИТЕЛЬНАЯ AI-ПРОВЕРКА" status={config.geminiConfigured ? 'Подключён' : 'Не подключён'} enabled={config.geminiConfigured} description="Сравнение видимых признаков упаковки с описанием товара. Используется по запросу и помогает выявить противоречия." detail="Подключение: GEMINI_API_KEY. Доступность бесплатной квоты зависит от проекта и условий Google." /></div><div className="source-policy"><ShieldCheck size={24} /><div><h2>Соответствие и права проверяются отдельно</h2><p>Совпадение EAN карточки помогает найти товар, но не гарантирует правильность фотографии. Перед экспортом подтвердите вариант упаковки и право на использование изображения.</p><p>Ключи подключаются через серверные переменные окружения. Их не нужно вводить в браузер.</p></div></div></>}
    </main></div>

    {imported && <ImportDialog sheet={imported.sheet} filename={imported.filename} onClose={() => setImported(null)} onImport={createBatch} />}
    {settingsOpen && <Modal title="Параметры подготовки" onClose={() => setSettingsOpen(false)}><p className="muted">Профиль для Shelf: непрозрачный JPG на белом фоне, обрезка по границам товара.</p><div className="settings-fields"><label>Имена файлов<select value={profile.naming} onChange={event => updateProfile({ ...profile, naming: event.target.value as ExportProfile['naming'] })}><option value="sku">По SKU</option><option value="internalCode">По внутреннему коду (при отсутствии — SKU)</option></select></label><label>Максимальная длинная сторона<select value={profile.maxSide} onChange={event => updateProfile({ ...profile, maxSide: Number(event.target.value) })}><option value={1200}>1200 px</option><option value={1600}>1600 px</option><option value={2400}>2400 px</option></select></label><label>Обработка фона<select value={profile.method} onChange={event => updateProfile({ ...profile, method: event.target.value as ExportProfile['method'] })}><option value="ai">Локальная нейросеть U²-Net — без токенов</option><option value="white">Обрезка светлого фона — без модели</option></select></label></div><div className="notice-inline"><ImageIcon size={17} /><span>Размеры не увеличиваются искусственно. Изменение профиля применяется при следующей обработке фото.</span></div><div className="settings-access"><h3>Доступ к серверу</h3><p className="muted small">{config.accessProtected ? 'Сервер защищён паролем. Пароль хранится только в памяти этой вкладки.' : 'Локальный режим. Перед публичным размещением задайте MVP_ACCESS_PASSWORD.'}</p><label className="field-label" htmlFor="access-password">Пароль приложения</label><div className="inline-input"><input id="access-password" type="password" autoComplete="current-password" value={password} onChange={event => setPassword(event.target.value)} /><button className="button secondary" disabled={authBusy} onClick={async () => { setAuthBusy(true); try { setAccessPassword(password); await apiFetch('/api/session'); notify('Доступ к серверу подтверждён.'); setPassword(''); } catch (error) { notify(errorText(error), true); } finally { setAuthBusy(false); } }}>Подключиться</button></div></div><div className="modal-footer"><button className="button primary" onClick={() => setSettingsOpen(false)}>Готово<Check size={17} /></button></div></Modal>}
    {helpOpen && <Modal title="Как работает Shelf Studio" onClose={() => setHelpOpen(false)}><ol className="help-list"><li><strong>Загрузите Excel или CSV.</strong><p>Проверьте колонки SKU, EAN, названия и габариты в миллиметрах.</p></li><li><strong>Запустите поиск.</strong><p>Откройте карточку товара и выберите фотографию. Можно добавить своё фото или HTTPS-ссылку.</p></li><li><strong>Подготовьте JPG.</strong><p>Модель выделяет упаковку, фон становится белым, кадр обрезается прямоугольником по крайним точкам.</p></li><li><strong>Проверьте и скачайте.</strong><p>Подтвердите SKU и права. ZIP содержит JPG, отчёт Excel и сведения об источниках.</p></li></ol><div className="notice-inline"><Clock3 size={17} /><span>В MVP обработка выполняется в открытой вкладке. После закрытия вкладки сохранённые результаты останутся, незавершённые задачи можно запустить снова.</span></div><div className="modal-footer"><button className="button primary" onClick={() => setHelpOpen(false)}>Понятно</button></div></Modal>}
    {deleteTarget && <Modal title="Удалить сохранённую партию?" onClose={() => setDeleteTarget(null)}><p>Партия «{deleteTarget.name}» и её фотографии будут удалены из этого браузера. Скачанные архивы сохранятся.</p><div className="modal-footer"><button className="button secondary" onClick={() => setDeleteTarget(null)}>Отмена</button><button className="button destructive" onClick={async () => { try { await deleteBatch(deleteTarget.id); setHistory(current => current.filter(item => item.id !== deleteTarget.id)); if (batch?.id === deleteTarget.id) changeBatch(null); setDeleteTarget(null); notify('Партия удалена.'); } catch (error) { notify(errorText(error), true); } }}>Удалить партию</button></div></Modal>}
    {toast && <div className={`toast ${toast.error ? 'toast-error' : ''}`} role={toast.error ? 'alert' : 'status'}><span>{toast.message}</span><button className="icon-button" aria-label="Закрыть уведомление" onClick={() => setToast(null)}><X size={16} /></button></div>}
  </div>;
}

function Status({ status }: { status: RowStatus }) { return <span className={`status-pill status-${status}`}><span className={status === 'searching' || status === 'processing' ? 'pulse' : ''} />{STATUS_LABELS[status]}</span>; }
function SourceCard({ name, type, status, enabled, description, detail }: { name: string; type: string; status: string; enabled: boolean; description: string; detail: string }) {
  return <article className="source-card"><span className="eyebrow">{type}</span><h2>{name}</h2><span className={`provider-status ${enabled ? 'enabled' : ''}`}><span />{status}</span><p>{description}</p><div className="source-card-detail">{detail}</div></article>;
}
