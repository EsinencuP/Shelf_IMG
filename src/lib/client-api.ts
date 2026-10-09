'use client';

let authorization = '';
export function setAccessPassword(password: string) {
  authorization = password ? `Basic ${btoa(String.fromCharCode(...new TextEncoder().encode(`shelf:${password}`)))}` : '';
}
export async function apiFetch(url: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers);
  if (authorization) headers.set('Authorization', authorization);
  const response = await fetch(url, { ...init, headers, credentials: 'same-origin' });
  if (!response.ok) {
    let message = `Запрос завершился с кодом ${response.status}.`;
    try { const body = await response.json(); if (typeof body.error === 'string') message = body.error; } catch { /* Non-JSON gateway responses. */ }
    if (response.status === 401) message = 'Для доступа укажите пароль в настройках приложения.';
    throw new Error(message);
  }
  return response;
}
