// Server-to-server credentials never reach the browser.
export const cloudWorkerConfigured = () =>
  !!process.env.SHELF_WORKER_URL && !!process.env.SHELF_WORKER_SECRET;

export async function wakeCloudWorker(): Promise<boolean> {
  if (!cloudWorkerConfigured()) return false;
  try {
    const url = new URL(process.env.SHELF_WORKER_URL!);
    if (url.protocol !== 'https:' || !url.hostname.endsWith('.neon.tech')) return false;
    const response = await fetch(new URL('wake', url), {
      method: 'POST',
      headers: { 'x-secret': process.env.SHELF_WORKER_SECRET! },
      redirect: 'manual',
      signal: AbortSignal.timeout(8000),
    });
    return response.ok;
  } catch {
    // The persisted job survives a failed wake. Status polling and cron retry it.
    return false;
  }
}
