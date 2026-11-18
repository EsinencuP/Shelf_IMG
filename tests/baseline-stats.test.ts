import { expect, it } from 'vitest';
import { percentile, summarizeBaseline, type BaselineSample } from '../scripts/baseline-stats';
it('uses nearest rank for p50 and p95 without modifying observations', () => {
  const values = Array.from({ length: 21 }, (_, i) => 21 - i);
  expect(percentile(values, 0.5)).toBe(11);
  expect(percentile(values, 0.95)).toBe(20);
  expect(values[0]).toBe(21);
  expect(percentile([7], 0.95)).toBe(7);
  expect(percentile([], 0.95)).toBeNull();
});
it('rejects invalid durations and percentile definitions', () => {
  for (const value of [-1, NaN, Infinity]) expect(() => percentile([value], 0.95)).toThrow();
  for (const value of [0, -1, 2, NaN]) expect(() => percentile([1], value)).toThrow();
});
it('separates missing measurements and HTTP failures from successful search durations', () => {
  const base: BaselineSample = {
    environment: 'local',
    ean: '3017620422003',
    round: 1,
    httpStatus: 200,
    httpElapsedMs: 30,
    elapsedMs: 20,
    firstUsablePhotoMs: 12,
    sources: [
      { id: 'a', source: 'A', status: 'blocked', count: 0, elapsedMs: 10, httpStatus: 403 },
      { id: 'b', source: 'B', status: 'disabled', count: 0, elapsedMs: 0 },
    ],
  };
  const [result] = summarizeBaseline([
    base,
    { ...base, elapsedMs: undefined, firstUsablePhotoMs: undefined },
    { ...base, httpStatus: 504 },
  ]);
  expect(result.server).toMatchObject({ n: 1, p50Ms: 20 });
  expect(result.firstPhoto).toMatchObject({ n: 1, p95Ms: 12 });
  expect(result).toMatchObject({ requests: 3, httpFailures: 1, missingTiming: 1 });
  expect(result.sources.find((row) => row.id === 'a')).toMatchObject({ n: 3, http403: 3 });
  expect(result.sources.find((row) => row.id === 'b')).toMatchObject({ n: 0, p50Ms: null });
});
