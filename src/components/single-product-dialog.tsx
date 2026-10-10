'use client';

import { useState } from 'react';
import { Loader2, Search } from 'lucide-react';
import {
  createManualProduct,
  EMPTY_MANUAL_PRODUCT,
  type ManualProductInput,
} from '@/lib/manual-product';
import type { ProductRow } from '@/lib/types';
import Modal from './modal';

const FIELDS: {
  field: keyof ManualProductInput;
  label: string;
  placeholder?: string;
  limit?: number;
  decimal?: boolean;
}[] = [
  { field: 'sku', label: 'SKU / артикул', placeholder: 'Например, 00123', limit: 120 },
  { field: 'ean', label: 'EAN / штрихкод', placeholder: '8, 12, 13 или 14 цифр', limit: 32 },
  { field: 'nameRu', label: 'Наименование RU', placeholder: 'Бренд, вариант, объём', limit: 300 },
  { field: 'nameRo', label: 'Наименование RO', placeholder: 'Denumirea produsului', limit: 300 },
  { field: 'brand', label: 'Бренд', limit: 80 },
  {
    field: 'quantity',
    label: 'Объём / масса',
    placeholder: 'Например, 500 мл или 400 г',
    limit: 80,
  },
  { field: 'internalCode', label: 'Внутренний код', limit: 120 },
  { field: 'widthMm', label: 'Ширина, мм', decimal: true },
  { field: 'heightMm', label: 'Высота, мм', decimal: true },
  { field: 'depthMm', label: 'Глубина, мм', decimal: true },
];

export default function SingleProductDialog({
  onClose,
  onCreate,
}: {
  onClose: () => void;
  onCreate: (row: ProductRow) => Promise<void>;
}) {
  const [values, setValues] = useState<ManualProductInput>({ ...EMPTY_MANUAL_PRODUCT });
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError('');
    setSubmitting(true);
    try {
      await onCreate(createManualProduct(values));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Не удалось добавить товар.');
    } finally {
      setSubmitting(false);
    }
  }
  return (
    <Modal
      title="Проверить один артикул"
      onClose={() => {
        if (!submitting) onClose();
      }}
      wide
    >
      <p className="muted">
        Введите SKU и EAN или название товара. Создадим отдельную партию и сразу запустим поиск.
        Остальные поля необязательны.
      </p>
      <form onSubmit={submit}>
        <div className="single-product-grid">
          {FIELDS.map(({ field, label, placeholder, limit, decimal }) => (
            <label key={field}>
              <span>
                {label}
                {field === 'sku' && <small>Обязательно</small>}
              </span>
              <input
                type="text"
                value={values[field]}
                autoFocus={field === 'sku'}
                required={field === 'sku'}
                maxLength={limit ?? 30}
                inputMode={field === 'ean' ? 'numeric' : decimal ? 'decimal' : 'text'}
                placeholder={placeholder}
                disabled={submitting}
                onChange={(event) =>
                  setValues((current) => ({ ...current, [field]: event.target.value }))
                }
              />
            </label>
          ))}
        </div>
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
        <div className="modal-footer">
          <button
            type="button"
            className="button secondary"
            disabled={submitting}
            onClick={onClose}
          >
            Отмена
          </button>
          <button type="submit" className="button primary" disabled={submitting}>
            {submitting ? <Loader2 size={17} className="spin" /> : <Search size={17} />}
            {submitting ? 'Добавляем товар…' : 'Найти фотографии'}
          </button>
        </div>
      </form>
    </Modal>
  );
}
