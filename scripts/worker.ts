import { claimJob, finishJob, renewJob } from '../src/lib/server/jobs';
import { database } from '../src/lib/server/database';
import { searchProducts } from '../src/lib/server/search';

let stop = false;
process.on('SIGINT', () => {
  stop = true;
});
process.on('SIGTERM', () => {
  stop = true;
});
console.log('Shelf worker started. Stop with Ctrl+C.');
// Idle polling keeps Neon compute active. Exit after 10 minutes idle to preserve Free compute.
let idleSince = Date.now();
while (!stop && Date.now() - idleSince < 600_000) {
  try {
    const job = await claimJob();
    if (!job) {
      await new Promise((resolve) => setTimeout(resolve, 15_000));
      continue;
    }
    idleSince = Date.now();
    const heartbeat = setInterval(() => {
      renewJob(job).catch(() => {});
    }, 30_000);
    try {
      await finishJob(job, await searchProducts(job.product, job.options, job.refresh));
    } catch {
      await finishJob(
        job,
        undefined,
        'Поиск временно недоступен. Автоматический повтор ограничен тремя попытками.',
      );
    } finally {
      clearInterval(heartbeat);
    }
    console.log('Job finished:', job.id);
  } catch {
    console.error('Database unavailable; retry in 30 seconds.');
    await new Promise((resolve) => setTimeout(resolve, 30_000));
  }
}
await database().end();
console.log('Shelf worker stopped. Restart npm run worker for the next batch.');
