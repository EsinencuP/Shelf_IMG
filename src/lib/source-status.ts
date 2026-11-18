import type { SearchDiagnostic, SourceStatus } from './types';

export const SOURCE_STATUS_LABELS: Record<SourceStatus, string> = {
  ok: 'Найдены фото',
  empty: 'Фото не найдены',
  blocked: 'Источник недоступен',
  timeout: 'Время ожидания истекло',
  quota: 'Лимит исчерпан',
  parse_error: 'Ошибка ответа',
  disabled: 'Отключён',
  relay_offline: 'Relay офлайн',
};
const reasons: Record<SourceStatus, string> = {
  ok: 'Источник вернул кандидатов; соответствие упаковке требует проверки.',
  empty: 'Источник успешно ответил, подходящие фотографии не найдены.',
  blocked: 'Источник недоступен: доступ запрещён или соединение не установлено.',
  timeout: 'Источник не ответил за отведённое время.',
  quota: 'Лимит запросов или бесплатная квота источника исчерпаны. Повторите позже.',
  parse_error: 'Ответ источника не удалось разобрать или он имеет неверный формат.',
  disabled: 'Источник отключён или не настроен.',
  relay_offline: 'Не удалось подключиться к настроенному relay.',
};
const isStatus = (value: unknown): value is SourceStatus =>
  typeof value === 'string' && Object.hasOwn(SOURCE_STATUS_LABELS, value);

export const sourceReason = (status: SourceStatus): string => reasons[status];

export function isSourceFailure(status: string): boolean {
  return ['blocked', 'timeout', 'quota', 'parse_error', 'relay_offline', 'unavailable'].includes(
    status,
  );
}

/** Accepts safe API errors and persisted legacy diagnostics; does not expose arbitrary exception text. */
export function sourceFailureDetails(error: unknown): {
  status: SourceStatus;
  reason: string;
  httpStatus?: number;
  retryAfterMs?: number;
} {
  const value = error && typeof error === 'object' ? (error as Record<string, unknown>) : {};
  const message = typeof value.message === 'string' ? value.message : '';
  const httpStatus =
    typeof value.httpStatus === 'number'
      ? value.httpStatus
      : Number(message.match(/\bHTTP\s+(\d{3})\b/i)?.[1]) ||
        (typeof value.status === 'number' ? value.status : undefined);
  let status: SourceStatus;
  if (isStatus(value.sourceStatus) && isSourceFailure(value.sourceStatus))
    status = value.sourceStatus;
  else if (
    httpStatus === 429 ||
    httpStatus === 432 ||
    httpStatus === 433 ||
    /квот.*исчерпан|лимит.*исчерпан/i.test(message)
  )
    status = 'quota';
  else if ([401, 403, 406, 451].includes(httpStatus ?? 0)) status = 'blocked';
  else if (
    value.name === 'TimeoutError' ||
    value.name === 'AbortError' ||
    httpStatus === 408 ||
    httpStatus === 504 ||
    /не ответил вовремя|время ожидания/i.test(message)
  )
    status = 'timeout';
  else if (
    value.name === 'SyntaxError' ||
    /некорректн.*(?:JSON|выдач|ответ|формат)|неверн.*формат|не удалось разобрать/i.test(message)
  )
    status = 'parse_error';
  else if (
    /нет ключа|нужен.*ключ|выключен|не подтвержд[её]н|некорректный ключ|ключ другого/i.test(message)
  )
    status = 'disabled';
  else status = 'blocked';
  const safeMessage =
    typeof value.status === 'number' || value.trustedDiagnostic === true ? message : '';
  const retryAfterMs = value.retryAfterMs;
  return {
    status,
    reason: safeMessage || reasons[status],
    ...(httpStatus ? { httpStatus } : {}),
    ...(typeof retryAfterMs === 'number' && retryAfterMs > 0 && Number.isFinite(retryAfterMs)
      ? { retryAfterMs: Math.min(retryAfterMs, 86_400_000) }
      : {}),
  };
}

/** Normalizes stored reports from earlier versions as well as current source responses. */
export function sourceDiagnostic(
  input: Omit<SearchDiagnostic, 'status'> & { status: string },
): SearchDiagnostic {
  let status: SourceStatus;
  let inferred: ReturnType<typeof sourceFailureDetails> | undefined;
  if (isStatus(input.status)) status = input.status;
  else if (['skipped', 'not_configured', 'not-configured'].includes(input.status))
    status = 'disabled';
  else {
    inferred = sourceFailureDetails({
      message: input.reason || input.message,
      httpStatus: input.httpStatus,
      trustedDiagnostic: true,
    });
    status = inferred.status;
  }
  if (
    input.status === 'ok' &&
    /HTTP\s+[45]\d{2}|некорректн|исчерпан|недоступ/i.test(input.reason || input.message || '')
  ) {
    inferred = sourceFailureDetails({
      message: input.reason || input.message,
      httpStatus: input.httpStatus,
      trustedDiagnostic: true,
    });
    status = inferred.status;
  }
  if (status === 'ok' && input.count === 0 && input.id !== 'barcode-identity') status = 'empty';
  if (input.status === 'not_configured' && !input.message && !input.reason)
    return {
      ...input,
      status: 'disabled',
      reason: 'Нет ключа или адреса сервиса.',
      message: 'Нет ключа или адреса сервиса.',
    };
  const reason = input.reason || input.message || inferred?.reason || reasons[status];
  return { ...input, ...inferred, status, reason, message: reason };
}
