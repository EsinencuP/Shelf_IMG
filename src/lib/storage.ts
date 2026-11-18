import type { Batch, ProductRow } from './types';

const DB_NAME = 'shelf-product-images';
const STORE = 'batches';
const ROW_STORE = 'rows';
type BatchRecord = Omit<Batch, 'rows'> & { rowIds: string[] };
type RowRecord = { batchId: string; id: string; row: ProductRow };
const savedRows = new Map<string, Map<string, ProductRow>>();
const saving = new Map<string, number>();
let databasePromise: Promise<IDBDatabase> | undefined;

function storageError(error: unknown): Error {
  const name = error instanceof DOMException || error instanceof Error ? error.name : '';
  if (name === 'QuotaExceededError')
    return new Error(
      'Хранилище браузера заполнено. Сначала экспортируйте нужные партии в ZIP, затем удалите старые партии или освободите место на диске. Изменения не сохранены.',
    );
  if (name === 'SecurityError' || typeof indexedDB === 'undefined')
    return new Error(
      'Браузер запретил локальное хранилище IndexedDB. Разрешите хранение данных сайта и откройте приложение в обычном окне. Изменения не сохранены.',
    );
  return new Error(
    `Не удалось сохранить или прочитать локальную историю. Проверьте доступное место и настройки браузера.${error instanceof Error ? ` ${error.message}` : ''}`,
  );
}

function openDatabase(): Promise<IDBDatabase> {
  if (databasePromise) return databasePromise;
  databasePromise = new Promise<IDBDatabase>((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(storageError(new Error('IndexedDB недоступен.')));
      return;
    }
    const request = indexedDB.open(DB_NAME, 2);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE))
        request.result.createObjectStore(STORE, { keyPath: 'id' });
      if (!request.result.objectStoreNames.contains(ROW_STORE))
        request.result
          .createObjectStore(ROW_STORE, { keyPath: ['batchId', 'id'] })
          .createIndex('batchId', 'batchId');
    };
    request.onsuccess = () => {
      const database = request.result;
      database.onversionchange = () => {
        database.close();
        databasePromise = undefined;
        savedRows.clear();
      };
      resolve(database);
    };
    request.onerror = () => reject(storageError(request.error));
    request.onblocked = () =>
      reject(
        new Error(
          'Локальная история заблокирована другой вкладкой. Закройте остальные вкладки Shelf и повторите действие.',
        ),
      );
  }).catch((error) => {
    databasePromise = undefined;
    throw error;
  });
  return databasePromise;
}

/** Persist metadata and changed rows in one transaction. A legacy batch migrates on save. */
export async function saveBatch(batch: Batch): Promise<void> {
  const database = await openDatabase();
  return new Promise((resolve, reject) => {
    try {
      const transaction = database.transaction([STORE, ROW_STORE], 'readwrite');
      const { rows, ...metadata } = batch;
      const store = transaction.objectStore(ROW_STORE);
      const current = new Map(rows.map((row) => [row.id, row]));
      const pending = saving.get(batch.id) ?? 0;
      const previous = savedRows.get(batch.id);
      saving.set(batch.id, pending + 1);
      const settled = () => {
        const remaining = (saving.get(batch.id) ?? 1) - 1;
        if (remaining) saving.set(batch.id, remaining);
        else saving.delete(batch.id);
      };
      transaction.oncomplete = () => {
        savedRows.set(batch.id, current);
        settled();
        resolve();
      };
      transaction.onerror = () => reject(storageError(transaction.error));
      transaction.onabort = () => {
        settled();
        reject(storageError(transaction.error));
      };
      try {
        transaction.objectStore(STORE).put({
          ...metadata,
          rowIds: [...current.keys()],
        } satisfies BatchRecord);
        for (const [id, row] of current)
          if (pending || previous?.get(id) !== row)
            store.put({ batchId: batch.id, id, row } satisfies RowRecord);
        for (const id of previous?.keys() ?? []) if (!current.has(id)) store.delete([batch.id, id]);
      } catch (error) {
        transaction.abort();
        throw error;
      }
    } catch (error) {
      reject(storageError(error));
    }
  });
}

/** Recovers interrupted work on browser reload; completed image data stays intact. */
export async function listBatches(): Promise<Batch[]> {
  const database = await openDatabase();
  return new Promise((resolve, reject) => {
    try {
      const transaction = database.transaction([STORE, ROW_STORE], 'readwrite');
      const store = transaction.objectStore(STORE);
      const rowStore = transaction.objectStore(ROW_STORE);
      const request = store.getAll();
      const rowRequest = rowStore.getAll();
      let batches: Batch[] = [];
      const loaded = new Map<string, Map<string, ProductRow>>();
      rowRequest.onsuccess = () => {
        for (const { batchId, id, row } of rowRequest.result as RowRecord[]) {
          let rows = loaded.get(batchId);
          if (!rows) loaded.set(batchId, (rows = new Map()));
          rows.set(id, row);
        }
        const records = request.result as (Batch | BatchRecord)[];
        if (
          records.some(
            (record) =>
              'rowIds' in record && record.rowIds.some((id) => !loaded.get(record.id)?.has(id)),
          )
        ) {
          transaction.abort();
          return;
        }
        batches = records
          .map((record) => {
            const normalized = 'rowIds' in record;
            const persisted = loaded.get(record.id);
            let batch: Batch;
            if (normalized) {
              const { rowIds, ...metadata } = record;
              batch = { ...metadata, rows: rowIds.map((id) => persisted!.get(id)!) };
            } else {
              batch = record;
            }
            let changed = false;
            const rows = batch.rows.map((row) => {
              if (row.status !== 'searching' && row.status !== 'processing') return row;
              if (row.status === 'searching' && (row.searchJobId || row.searchRequestKey))
                return row;
              changed = true;
              const warning =
                row.status === 'processing'
                  ? 'Обработка прервалась при закрытии приложения. Проверьте результат и при необходимости запустите её снова.'
                  : 'Поиск прервался при закрытии приложения. Его можно запустить снова.';
              const recovered = {
                ...row,
                status:
                  row.status === 'processing' || row.candidates.length || row.originalBlob
                    ? ('review' as const)
                    : ('pending' as const),
                qualityWarnings: [...new Set([...row.qualityWarnings, warning])],
              };
              if (normalized)
                rowStore.put({ batchId: batch.id, id: row.id, row: recovered } satisfies RowRecord);
              return recovered;
            });
            const recovered = changed ? { ...batch, rows } : batch;
            if (changed && !normalized) store.put(recovered);
            if (normalized) loaded.set(batch.id, new Map(rows.map((row) => [row.id, row])));
            return recovered;
          })
          .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
      };
      transaction.oncomplete = () => {
        for (const [id, rows] of loaded) savedRows.set(id, rows);
        resolve(batches);
      };
      transaction.onerror = () => reject(storageError(transaction.error));
      transaction.onabort = () => reject(storageError(transaction.error));
    } catch (error) {
      reject(storageError(error));
    }
  });
}

export async function deleteBatch(id: string): Promise<void> {
  const database = await openDatabase();
  return new Promise((resolve, reject) => {
    try {
      const transaction = database.transaction([STORE, ROW_STORE], 'readwrite');
      transaction.objectStore(STORE).delete(id);
      const rows = transaction.objectStore(ROW_STORE);
      const request = rows.index('batchId').openKeyCursor(IDBKeyRange.only(id));
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor) return;
        rows.delete(cursor.primaryKey);
        cursor.continue();
      };
      transaction.oncomplete = () => {
        savedRows.delete(id);
        resolve();
      };
      transaction.onerror = () => reject(storageError(transaction.error));
      transaction.onabort = () => reject(storageError(transaction.error));
    } catch (error) {
      reject(storageError(error));
    }
  });
}
