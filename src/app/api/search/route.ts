import { boundedWork, errorResponse, guardRequest, readJson } from '@/lib/server/http';
import { searchProducts } from '@/lib/server/search';
import { validateProduct, validateSearchOptions } from '@/lib/server/validation';

export const runtime = 'nodejs';
export const maxDuration = 180;
export async function POST(request: Request): Promise<Response> {
  try {
    guardRequest(request);
    const body = await readJson(request);
    const product = validateProduct(body);
    const options = validateSearchOptions((body as Record<string, unknown>).searchOptions);
    return await boundedWork(async () =>
      Response.json(await searchProducts(product, options), {
        headers: { 'Cache-Control': 'no-store' },
      }),
    );
  } catch (error) {
    return errorResponse(error);
  }
}
