import type { Batch } from './types';

const DB_NAME = 'shelf-product-images';
const STORE = 'batches';
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
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE))
        request.result.createObjectStore(STORE, { keyPath: 'id' });
    };
    request.onsuccess = () => {
      const database = request.result;
      database.onversionchange = () => {
        database.close();
        databasePromise = undefined;
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

/** Saves the entire batch with structured cloning, including image Blobs. */
export async function saveBatch(batch: Batch): Promise<void> {
  const database = await openDatabase();
  return new Promise((resolve, reject) => {
    try {
      const transaction = database.transaction(STORE, 'readwrite');
      transaction.objectStore(STORE).put(batch);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(storageError(transaction.error));
      transaction.onabort = () => reject(storageError(transaction.error));
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
      const transaction = database.transaction(STORE, 'readwrite');
      const store = transaction.objectStore(STORE);
      const request = store.getAll();
      let batches: Batch[] = [];
      request.onsuccess = () => {
        batches = (request.result as Batch[])
          .map((batch) => {
            let changed = false;
            const rows = batch.rows.map((row) => {
              if (row.status !== 'searching' && row.status !== 'processing') return row;
              changed = true;
              const warning =
                row.status === 'processing'
                  ? 'Обработка прервалась при закрытии приложения. Проверьте результат и при необходимости запустите её снова.'
                  : 'Поиск прервался при закрытии приложения. Его можно запустить снова.';
              return {
                ...row,
                status:
                  row.status === 'processing' || row.candidates.length || row.originalBlob
                    ? ('review' as const)
                    : ('pending' as const),
                qualityWarnings: [...new Set([...row.qualityWarnings, warning])],
              };
            });
            const recovered = changed ? { ...batch, rows } : batch;
            if (changed) store.put(recovered);
            return recovered;
          })
          .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
      };
      transaction.oncomplete = () => resolve(batches);
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
      const transaction = database.transaction(STORE, 'readwrite');
      transaction.objectStore(STORE).delete(id);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(storageError(transaction.error));
      transaction.onabort = () => reject(storageError(transaction.error));
    } catch (error) {
      reject(storageError(error));
    }
  });
}
