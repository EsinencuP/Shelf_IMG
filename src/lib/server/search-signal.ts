import { AsyncLocalStorage } from 'node:async_hooks';
import { setTimeout as sleep } from 'node:timers/promises';

const searchSignal = new AsyncLocalStorage<AbortSignal>();

export function inSearch<T>(signal: AbortSignal, work: () => T): T {
  return searchSignal.run(signal, work);
}

export function currentSearchSignal(explicit?: AbortSignal | null): AbortSignal | undefined {
  const active = searchSignal.getStore();
  return explicit && active && explicit !== active
    ? AbortSignal.any([explicit, active])
    : (explicit ?? active);
}

export async function abortable<T>(task: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return task;
  let onAbort: () => void;
  try {
    return await new Promise<T>((resolve, reject) => {
      onAbort = () => reject(signal.reason);
      signal.addEventListener('abort', onAbort, { once: true });
      task.then(resolve, reject);
      if (signal.aborted) onAbort();
    });
  } finally {
    signal.removeEventListener('abort', onAbort!);
  }
}

export async function waitForSource(ms: number, signal = currentSearchSignal()): Promise<void> {
  signal?.throwIfAborted();
  if (ms > 0) {
    try {
      await sleep(ms, undefined, { signal });
    } catch (error) {
      signal?.throwIfAborted();
      throw error;
    }
  }
}
