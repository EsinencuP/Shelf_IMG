import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { SearchDiagnostic } from '../src/lib/types';

export interface BaselineSample {
  environment: string;
  ean: string;
  round: number;
  httpStatus: number;
  httpElapsedMs: number;
  elapsedMs?: number;
  region?: string;
  requestId?: string;
  sources: SearchDiagnostic[];
}

/** Nearest-rank percentile; at small N the p95 can equal the maximum. */
export function percentile(values: readonly number[], fraction: number): number | null {
  if (!Number.isFinite(fraction) || fraction <= 0 || fraction > 1)
    throw new Error('Invalid percentile');
  if (values.some((value) => !Number.isFinite(value) || value < 0))
    throw new Error('Invalid duration');
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.ceil(fraction * sorted.length) - 1];
}

const timings = (values: number[]) => ({
  n: values.length,
  p50Ms: percentile(values, 0.5),
  p95Ms: percentile(values, 0.95),
  maxMs: percentile(values, 1),
});

export function summarizeBaseline(samples: BaselineSample[]) {
  return [...new Set(samples.map((sample) => sample.environment))].map((environment) => {
    const rows = samples.filter((sample) => sample.environment === environment);
    const valid = rows.filter((row) => row.httpStatus === 200 && row.elapsedMs !== undefined);
    const sources = [...new Set(rows.flatMap((row) => row.sources.map((source) => source.id)))].map(
      (id) => {
        const entries = rows.flatMap((row) =>
          row.sources.filter((source) => source.id === id && source.status !== 'disabled'),
        );
        return {
          id,
          ...timings(entries.map((source) => source.elapsedMs)),
          http403: entries.filter((source) => source.httpStatus === 403).length,
          timeout: entries.filter((source) => source.status === 'timeout').length,
        };
      },
    );
    return {
      environment,
      requests: rows.length,
      httpFailures: rows.filter((row) => row.httpStatus !== 200).length,
      missingTiming: rows.filter((row) => row.httpStatus === 200 && row.elapsedMs === undefined)
        .length,
      server: timings(valid.map((row) => row.elapsedMs!)),
      http: timings(rows.map((row) => row.httpElapsedMs)),
      sources,
    };
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const data = JSON.parse(readFileSync(process.argv[2] ?? 'docs/baseline-data.json', 'utf8')) as {
    samples: BaselineSample[];
  };
  for (const result of summarizeBaseline(data.samples)) {
    console.log(result.environment);
    console.table([
      { metric: 'server', ...result.server },
      { metric: 'http', ...result.http },
    ]);
    console.table(result.sources);
  }
}
