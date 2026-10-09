import { ApiError, boundedWork, errorResponse, guardRequest, readBody } from '@/lib/server/http';
import { validateProduct } from '@/lib/server/validation';
import { verifyImage } from '@/lib/server/vision';

export const runtime = 'nodejs';
export const maxDuration = 30;
export async function POST(request: Request): Promise<Response> {
  try {
    guardRequest(request);
    if (!request.headers.get('content-type')?.startsWith('multipart/form-data')) throw new ApiError(415, 'Ожидается multipart/form-data.');
    if (!process.env.GEMINI_API_KEY) throw new ApiError(503, 'Gemini не настроен.');
    const body = await readBody(request, 3_100_000);
    const parsed = await new Response(new Uint8Array(body), { headers: { 'Content-Type': request.headers.get('content-type')! } }).formData();
    const image = parsed.get('image');
    const attributes = parsed.get('product');
    if (!(image instanceof File) || image.size > 3_000_000 || !image.size) throw new ApiError(422, 'Ожидается изображение до 3 МБ.');
    if (typeof attributes !== 'string' || attributes.length > 3000) throw new ApiError(422, 'Некорректные атрибуты товара.');
    let input: unknown;
    try { input = JSON.parse(attributes); } catch { throw new ApiError(422, 'Атрибуты товара должны быть JSON.'); }
    const product = validateProduct(input);
    return await boundedWork(async () => Response.json(await verifyImage(product, new Uint8Array(await image.arrayBuffer())), { headers: { 'Cache-Control': 'no-store' } }));
  } catch (error) { return errorResponse(error); }
}
