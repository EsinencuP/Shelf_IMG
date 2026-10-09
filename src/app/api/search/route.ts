import { boundedWork, errorResponse, guardRequest, readJson } from '@/lib/server/http';
import { searchProducts } from '@/lib/server/search';
import { validateProduct } from '@/lib/server/validation';

export const runtime = 'nodejs';
export const maxDuration = 60;
export async function POST(request: Request): Promise<Response> {
  try {
    guardRequest(request);
    const product = validateProduct(await readJson(request));
    return await boundedWork(async () =>
      Response.json(await searchProducts(product), { headers: { 'Cache-Control': 'no-store' } }),
    );
  } catch (error) {
    return errorResponse(error);
  }
}
