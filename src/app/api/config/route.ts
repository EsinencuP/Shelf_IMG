import type { AppConfig } from '@/lib/types';
import { crawlerConfigured } from '@/lib/server/page-discovery';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export async function GET(): Promise<Response> {
  const enabled = process.env.NODE_ENV !== 'production' || !!process.env.MVP_ACCESS_PASSWORD;
  const config: AppConfig = {
    braveConfigured: false,
    searxngConfigured: enabled && !!process.env.SEARXNG_URL,
    tavilyConfigured: enabled && !!process.env.TAVILY_API_KEY,
    crawl4aiConfigured: enabled && crawlerConfigured(),
    geminiConfigured: enabled && !!process.env.GEMINI_API_KEY,
    accessProtected: !!process.env.MVP_ACCESS_PASSWORD,
    serverReady: enabled,
  };
  return Response.json(config, { headers: { 'Cache-Control': 'no-store' } });
}
