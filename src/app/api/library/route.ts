import sharp from 'sharp';
import { ApiError, guardRequest, errorResponse, readBody } from '@/lib/server/http';
import { validateProduct, normalizeGtin } from '@/lib/server/validation';
import { saveApproved } from '@/lib/server/library';
import { inspectImage } from '@/lib/server/image';
import type { Candidate } from '@/lib/types';
export const runtime = 'nodejs';
export async function POST(request: Request) {
  try {
    guardRequest(request);
    if (!request.headers.get('content-type')?.includes('application/json'))
      throw new ApiError(415, 'Ожидается JSON.');
    let body: Record<string, unknown>;
    try {
      body = JSON.parse(Buffer.from(await readBody(request, 3_000_000)).toString('utf8'));
    } catch (error) {
      if (error instanceof ApiError) throw error;
      throw new ApiError(400, 'Некорректный JSON.');
    }
    if (!body || typeof body !== 'object' || Array.isArray(body))
      throw new ApiError(422, 'Ожидаются данные подтверждённого товара.');
    const product = validateProduct(body.product);
    if (body.confirmed !== true || body.rightsConfirmed !== true)
      throw new ApiError(422, 'Подтвердите товар и право использования фото.');
    if (
      typeof body.image !== 'string' ||
      body.image.length > 2_800_000 ||
      !/^[A-Za-z0-9+/]*={0,2}$/.test(body.image)
    )
      throw new ApiError(422, 'Некорректное изображение.');
    const supplied = Buffer.from(body.image, 'base64');
    await inspectImage(supplied);
    const image = await sharp(supplied)
      .rotate()
      .flatten({ background: '#ffffff' })
      .resize({ width: 1600, height: 1600, fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 90 })
      .toBuffer();
    if (image.length > 2_097_152)
      throw new ApiError(413, 'Для общего каталога фото должно быть до 2 МБ.');
    const raw = body.candidate;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw))
      throw new ApiError(422, 'Укажите источник фото.');
    const entry = raw as Record<string, unknown>;
    const field = (key: string) => {
      const value = entry[key] ?? '';
      if (typeof value !== 'string' || value.length > 1200)
        throw new ApiError(422, 'Некорректный источник фото.');
      return value;
    };
    const pageUrl = field('pageUrl');
    if (pageUrl && !/^https?:\/\//i.test(pageUrl))
      throw new ApiError(422, 'Некорректная ссылка источника.');
    if (!['open_license', 'unknown', 'user_owned'].includes(field('rights')))
      throw new ApiError(422, 'Некорректные права фото.');
    const thumbnail = await sharp(image)
      .resize({ width: 96, height: 96, fit: 'inside' })
      .jpeg({ quality: 65 })
      .toBuffer();
    const candidate: Candidate = {
      id: '',
      title: product.nameRu || product.nameRo || field('title'),
      brand: product.brand,
      quantity: product.quantity,
      gtin: product.ean || undefined,
      gtinExact: !!normalizeGtin(product.ean),
      imageUrl: '',
      pageUrl,
      source: field('source'),
      rights: field('rights') as Candidate['rights'],
      license: field('license'),
      warnings: [],
      previewUrl: 'data:image/jpeg;base64,' + thumbnail.toString('base64'),
    };
    const id = await saveApproved(product, candidate, image);
    return Response.json({ id }, { status: 201, headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    return errorResponse(error);
  }
}
