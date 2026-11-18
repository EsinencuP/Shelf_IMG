import { probeSources } from '@/lib/server/probe-sources';
import { searchProducts } from '@/lib/server/search';
import type { SearchProduct } from '@/lib/server/validation';
import type { SearchOptions } from '@/lib/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 180;

type Control = { product: SearchProduct; market?: SearchOptions['market']; marketName?: string };
const nutella = { ean: '3017620422003', nameRu: 'Ореховая паста Nutella 400 г', nameRo: 'Cremă Nutella 400 g', brand: 'Ferrero', quantity: '400 г' };
const controls: Record<string, Control> = {
  nutella: { product: nutella },
  jlc: { product: { ean: '4840053004404', nameRu: 'Творог JLC 0% 500 г', nameRo: 'Brânză JLC 0% 500 g', brand: 'JLC', quantity: '500 г' } },
  name: { product: { ean: '', nameRu: 'Конфеты ROSHEN Konafetto', nameRo: '', brand: 'ROSHEN', quantity: '' } },
  ukraine: { product: nutella, market: 'UA', marketName: 'Горіхова паста Nutella 400 г' },
};

const headers = { 'Cache-Control': 's-maxage=600', 'X-Robots-Tag': 'noindex, nofollow' };

function enabled() {
  return process.env.VERCEL_ENV === 'preview' && process.env.VERCEL_GIT_COMMIT_REF === 'codex/shelf-source-qa';
}

export function HEAD() {
  return new Response(null, { status: enabled() ? 204 : 404, headers });
}

export async function GET(request: Request) {
  if (!enabled()) return new Response(null, { status: 404 });
  const details = {
    region: process.env.VERCEL_REGION ?? null,
    build: process.env.VERCEL_GIT_COMMIT_SHA ?? null,
    base: '111f5515cc10c4d657e9baa7dacc0d5725fbd0b2',
    generatedAt: new Date().toISOString(),
  };
  if (details.region !== 'fra1')
    return Response.json({ ...details, error: 'QA route did not run in Frankfurt.' }, { status: 503, headers });
  const key = new URL(request.url).searchParams.get('case') ?? 'probe';
  if (key === 'probe')
    return Response.json({ ...details, case: key, ...await probeSources({ env: {}, timeoutMs: 5_000 }) }, { headers });
  if (!Object.hasOwn(controls, key)) return new Response(null, { status: 404 });
  if (process.env.SHELF_WORKER_URL || process.env.RELAY_URL)
    return Response.json({ ...details, error: 'QA preview has an external egress configured.' }, { status: 409, headers });
  const control = controls[key];
  const options: SearchOptions = {
    mode: control.market ? 'expanded' : 'moldova',
    useWeb: false,
    useCache: false,
    webQueryLimit: 1,
    market: control.market,
    marketName: control.marketName,
  };
  const result = await searchProducts(control.product, options, true, request.signal);
  return Response.json({
    ...details,
    case: key,
    gtin: control.product.ean,
    outcome: result.outcome,
    coverage: result.coverage,
    elapsedMs: result.elapsedMs,
    firstUsablePhotoMs: result.firstUsablePhotoMs ?? null,
    candidates: result.candidates.map(({ source, sourceMarket, gtin, matchStatus, sourcePhotoCheck }) => ({
      source, sourceMarket, gtin, matchStatus,
      photo: sourcePhotoCheck ? {
        sha256: sourcePhotoCheck.sha256,
        width: sourcePhotoCheck.width,
        height: sourcePhotoCheck.height,
        mime: sourcePhotoCheck.mime,
      } : null,
    })),
    diagnostics: result.diagnostics?.map(({ id, count, status, httpStatus, elapsedMs, reason, attempts }) => ({
      id, count, status, httpStatus, elapsedMs, reason,
      attempts: attempts?.map(({ status, count, httpStatus, elapsedMs }) => ({ status, count, httpStatus, elapsedMs })),
    })),
  }, { headers });
}
