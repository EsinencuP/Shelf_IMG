import { expect, it } from 'vitest';
import data from '../docs/baseline-data.json';
import logs from '../docs/baseline-runtime-logs.json';

it('correlates every measured Vercel search and source duration with captured runtime logs', () => {
  const samples = data.samples.filter((sample) => sample.environment === 'vercel');
  const byId = new Map(logs.records.map((record) => [record.requestId, record]));
  expect(samples).toHaveLength(21);
  expect(byId.size).toBe(21);
  for (const sample of samples) {
    const record = byId.get(sample.requestId!);
    expect(record).toBeDefined();
    expect(record?.elapsedMs).toBe(sample.elapsedMs);
    expect(record?.region).toBe('fra1');
    expect(record?.httpStatus).toBe(sample.httpStatus);
    expect(record?.sources).toEqual(
      sample.sources.map(({ id, status, count, elapsedMs, ...source }) => ({
        id,
        status,
        count,
        elapsedMs,
        ...('httpStatus' in source ? { httpStatus: source.httpStatus } : {}),
      })),
    );
  }
});
