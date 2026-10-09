import type { AppConfig } from '@/lib/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export async function GET(): Promise<Response> {
  const enabled = process.env.NODE_ENV !== 'production' || !!process.env.MVP_ACCESS_PASSWORD;
  const config: AppConfig = {
    braveConfigured: enabled && !!process.env.BRAVE_SEARCH_API_KEY,
    geminiConfigured: enabled && !!process.env.GEMINI_API_KEY,
    accessProtected: !!process.env.MVP_ACCESS_PASSWORD,
    serverReady: enabled,
  };
  return Response.json(config, { headers: { 'Cache-Control': 'no-store' } });
}
