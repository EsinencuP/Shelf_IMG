'use client';

import { useState } from 'react';
import { ArrowRight, AlertCircle } from 'lucide-react';
import type { ColumnMapping, ImportField, ParsedSheet, ProductRow } from '@/lib/types';
import { createRows, suggestMapping } from '@/lib/import';
import Modal from './modal';

const FIELDS: { field: ImportField; label: string; note?: string }[] = [
  { field: 'sku', label: 'SKU / артикул', note: 'Обязательно' },
  { field: 'internalCode', label: 'Внутренний код' }, { field: 'ean', label: 'EAN / штрихкод' },
  { field: 'nameRu', label: 'Наименование RU', note: 'Нужно RU или RO' }, { field: 'nameRo', label: 'Наименование RO' },
  { field: 'brand', label: 'Бренд' }, { field: 'quantity', label: 'Объём / масса' },
  { field: 'widthMm', label: 'Ширина, мм' }, { field: 'heightMm', label: 'Высота, мм' }, { field: 'depthMm', label: 'Глубина, мм' },
];

export default function ImportDialog({ sheet, filename, onClose, onImport }: { sheet: ParsedSheet; filename: string; onClose: () => void; onImport: (name: string, rows: ProductRow[]) => void }) {
  const [mapping, setMapping] = useState<ColumnMapping>(() => suggestMapping(sheet.headers));
  const [name, setName] = useState(filename.replace(/\.[^.]+$/, ''));
  const [error, setError] = useState('');
  function submit() {
    try { const rows = createRows(sheet, mapping); if (!rows.length) throw new Error('В таблице не найдено товарных строк.'); onImport(name.trim() || 'Новая партия', rows); }
    catch (reason) { setError(reason instanceof Error ? reason.message : 'Не удалось импортировать таблицу.'); }
  }
  return <Modal title="Проверьте колонки Excel" onClose={onClose} wide>
    <p className="muted">{filename} · лист «{sheet.name}» · {sheet.rows.length} строк. Габариты должны быть указаны в миллиметрах.</p>
    <label className="field-label" htmlFor="batch-name">Название партии</label><input id="batch-name" className="wide-input" value={name} onChange={event => setName(event.target.value)} maxLength={120} />
    <div className="mapping-grid">{FIELDS.map(({ field, label, note }) => <label key={field}><span>{label}{note && <small>{note}</small>}</span><select aria-label={label} value={mapping[field] ?? ''} onChange={event => setMapping(current => ({ ...current, [field]: event.target.value === '' ? undefined : Number(event.target.value) }))}><option value="">Не использовать</option>{sheet.headers.map((header, index) => <option key={index} value={index}>{header || `Колонка ${index + 1}`}</option>)}</select></label>)}</div>
    {sheet.warnings.length > 0 && <div className="notice-inline"><AlertCircle size={17} /><span>{sheet.warnings.join(' ')}</span></div>}
    <div className="section-label"><h3>Первые строки</h3><span>Предпросмотр</span></div><div className="table-scroll import-preview"><table><thead><tr>{sheet.headers.map((header, index) => <th key={index}>{header}</th>)}</tr></thead><tbody>{sheet.rows.slice(0, 3).map((row, index) => <tr key={index}>{sheet.headers.map((_, column) => <td key={column}>{row[column]}</td>)}</tr>)}</tbody></table></div>
    {error && <p className="form-error" role="alert">{error}</p>}
    <div className="modal-footer"><button className="button secondary" onClick={onClose}>Отмена</button><button className="button primary" disabled={mapping.sku === undefined || (mapping.nameRu === undefined && mapping.nameRo === undefined)} onClick={submit}>Импортировать {sheet.rows.length} SKU<ArrowRight size={17} /></button></div>
  </Modal>;
}
