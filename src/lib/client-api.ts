'use client';
import type { Candidate } from './types';

let authorization = '';
export class ApiRequestError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
  }
}

export function setAccessPassword(password: string) {
  authorization = password
    ? `Basic ${btoa(String.fromCharCode(...new TextEncoder().encode(`admin:${password}`)))}`
    : '';
  if (typeof window !== 'undefined') window.dispatchEvent(new Event('shelf-access-changed'));
}
export function candidateImageEndpoint(item: Pick<Candidate, 'imageUrl' | 'pageUrl'>): string {
  return item.imageUrl.startsWith('/api/library/')
    ? item.imageUrl
    : `/api/image?${new URLSearchParams({ url: item.imageUrl, ...(item.pageUrl ? { page: item.pageUrl } : {}) })}`;
}
export async function apiFetch(url: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers);
  if (authorization) headers.set('Authorization', authorization);
  const response = await fetch(url, { ...init, headers, credentials: 'same-origin' });
  if (!response.ok) {
    let message = `Запрос завершился с кодом ${response.status}.`;
    try {
      const body = await response.json();
      if (typeof body.error === 'string') message = body.error;
    } catch {
      /* Non-JSON gateway responses. */
    }
    if (response.status === 401) message = 'Для доступа укажите пароль в настройках приложения.';
    throw new ApiRequestError(message, response.status);
  }
  return response;
}
