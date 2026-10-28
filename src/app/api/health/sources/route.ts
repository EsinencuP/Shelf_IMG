import { ApiError, boundedWork, errorResponse, guardRequest } from '@/lib/server/http';
import { probeSources } from '@/lib/server/probe-sources';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
// Three EANs and up to three Bucuria cards per EAN can exceed the default duration.
export const maxDuration = 300;

function authorize(request: Request) {
  guardRequest(request);
  // Unlike general development APIs, diagnostics always require a configured password.
  if (!process.env.MVP_ACCESS_PASSWORD?.trim())
    throw new ApiError(503, 'Задайте MVP_ACCESS_PASSWORD для проверки источников.');
}

export async function GET(request: Request) {
  try {
    authorize(request);
    return await boundedWork(async () =>
      Response.json(await probeSources(), { headers: { 'Cache-Control': 'no-store' } }),
    );
  } catch (error) {
    return errorResponse(error);
  }
}

// Next.js otherwise delegates HEAD to GET, which would consume source quotas.
export async function HEAD(request: Request) {
  try {
    authorize(request);
    return new Response(null, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    const response = errorResponse(error);
    return new Response(null, { status: response.status, headers: response.headers });
  }
}
