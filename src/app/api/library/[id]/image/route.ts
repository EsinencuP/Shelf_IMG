import { ApiError, guardRequest, errorResponse } from '@/lib/server/http';
import { database } from '@/lib/server/database';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    guardRequest(request);
    const { id } = await context.params;
    if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(id))
      throw new ApiError(422, 'Некорректный идентификатор фото.');
    const { rows } = await database().query<{ image: Buffer }>(
      'SELECT image FROM shelf_library WHERE id=$1',
      [id],
    );
    if (!rows[0]) throw new ApiError(404, 'Фото не найдено.');
    return new Response(new Uint8Array(rows[0].image), {
      headers: {
        'Content-Type': 'image/jpeg',
        'Cache-Control': 'private, no-store',
        'X-Content-Type-Options': 'nosniff',
      },
    });
  } catch (error) {
    return errorResponse(error);
  }
}
