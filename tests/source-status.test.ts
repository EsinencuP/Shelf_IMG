import { describe, expect, it } from 'vitest';
import { ApiError } from '@/lib/server/http';
import {
  isSourceFailure,
  sourceDiagnostic,
  sourceFailureDetails,
  SOURCE_STATUS_LABELS,
} from '@/lib/source-status';
import type { SourceStatus } from '@/lib/types';

describe('unified source status', () => {
  it.each(Object.keys(SOURCE_STATUS_LABELS) as SourceStatus[])(
    'keeps %s and supplies a reason even with zero images',
    (status) => {
      const diagnostic = sourceDiagnostic({
        id: 'shop',
        source: 'Shop',
        status,
        count: status === 'ok' ? 2 : 0,
        elapsedMs: 5,
      });
      expect(diagnostic.status).toBe(status);
      expect(diagnostic.reason?.length).toBeGreaterThan(0);
      expect(diagnostic.message).toBe(diagnostic.reason);
    },
  );

  it.each([
    [new ApiError(502, 'Источник ответил HTTP 403.'), 'blocked', 403],
    [new ApiError(429, 'Квота источника исчерпана.'), 'quota', 429],
    [new ApiError(504, 'Источник не ответил вовремя.'), 'timeout', 504],
    [new ApiError(502, 'Источник вернул некорректный JSON.'), 'parse_error', 502],
    [new ApiError(503, 'Brave выключен: бесплатный расход не подтверждён.'), 'disabled', 503],
    [new DOMException('upstream secret', 'TimeoutError'), 'timeout', undefined],
    [new SyntaxError('upstream secret'), 'parse_error', undefined],
    [new Error('API_TOKEN=secret'), 'blocked', undefined],
    [{ sourceStatus: 'relay_offline' }, 'relay_offline', undefined],
  ] as const)('classifies a failure as %s', (error, status, httpStatus) => {
    expect(sourceFailureDetails(error)).toMatchObject({ status });
    expect(sourceFailureDetails(error).httpStatus).toBe(httpStatus);
    expect(sourceFailureDetails(error).reason).not.toContain('secret');
  });

  it('distinguishes a successful empty result from every failure', () => {
    expect(
      sourceDiagnostic({ id: 'shop', source: 'Shop', status: 'ok', count: 0, elapsedMs: 1 }).status,
    ).toBe('empty');
    for (const status of ['blocked', 'quota', 'timeout', 'parse_error', 'relay_offline']) {
      expect(isSourceFailure(status)).toBe(true);
      expect(
        sourceDiagnostic({ id: 'shop', source: 'Shop', status, count: 0, elapsedMs: 1 }).status,
      ).toBe(status);
    }
    expect(isSourceFailure('empty')).toBe(false);
    expect(isSourceFailure('disabled')).toBe(false);
  });

  it('normalizes old saved statuses without losing their original reasons', () => {
    const base = { id: 'shop', source: 'Shop', count: 0, elapsedMs: 1 };
    expect(
      sourceDiagnostic({ ...base, status: 'unavailable', message: 'Источник ответил HTTP 403.' }),
    ).toMatchObject({ status: 'blocked', httpStatus: 403, reason: 'Источник ответил HTTP 403.' });
    expect(sourceDiagnostic({ ...base, status: 'not_configured' })).toMatchObject({
      status: 'disabled',
      reason: 'Нет ключа или адреса сервиса.',
    });
    expect(
      sourceDiagnostic({ ...base, status: 'skipped', message: 'Веб-поиск выключен.' }),
    ).toMatchObject({ status: 'disabled', reason: 'Веб-поиск выключен.' });
    expect(
      sourceDiagnostic({ ...base, status: 'ok', count: 2, message: 'HTTP 429' }),
    ).toMatchObject({ status: 'quota', count: 2 });
  });
});
