import type { AppConfig } from '@/lib/types';
import { braveFreeOnlyConfirmed } from '@/lib/server/web-discovery';
import { cloudWorkerConfigured } from '@/lib/server/cloud-dispatch';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export async function GET() {
  const enabled = process.env.NODE_ENV !== 'production' || !!process.env.MVP_ACCESS_PASSWORD;
  const config: AppConfig = {
    braveConfigured: enabled && !!process.env.BRAVE_SEARCH_API_KEY,
    tavilyConfigured: enabled && !!process.env.TAVILY_API_KEY,
    braveFreeOnlyConfirmed: enabled && braveFreeOnlyConfirmed(),
    geminiConfigured: enabled && !!process.env.GEMINI_API_KEY,
    accessProtected: !!process.env.MVP_ACCESS_PASSWORD,
    serverReady: enabled,
    databaseConfigured: enabled && !!process.env.DATABASE_URL,
    cloudWorkerConfigured: enabled && cloudWorkerConfigured(),
    build: {
      commit: process.env.SHELF_BUILD_COMMIT || null,
      fingerprint: process.env.SHELF_BUILD_FINGERPRINT || null,
      deploymentId: process.env.VERCEL_DEPLOYMENT_ID || null,
    },
  };
  return Response.json(config, { headers: { 'Cache-Control': 'no-store' } });
}
