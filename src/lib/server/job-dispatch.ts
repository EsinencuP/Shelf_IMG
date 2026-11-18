import { after } from 'next/server';
import { cloudWorkerConfigured, wakeCloudWorker } from './cloud-dispatch';
import { runQueuedJob } from './cloud-worker';

export async function dispatchJobs(ids: string[]): Promise<boolean> {
  const awake = cloudWorkerConfigured() && (await wakeCloudWorker());
  if (!awake && ids.length) {
    after(async () => {
      await Promise.allSettled(ids.slice(0, 3).map(runQueuedJob));
    });
  }
  return !!awake;
}
