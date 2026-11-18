import { createHash, randomUUID } from 'node:crypto';
import type { Candidate } from '../types';
import { database, databaseConfigured } from './database';
import { normalizeGtin, type SearchProduct } from './validation';
import { matchCandidate } from './matching';
import { ApiError } from './http';

export function productKey(product: SearchProduct): string {
  return product.ean
    ? 'gtin:' + normalizeGtin(product.ean)
    : 'name:' +
        createHash('sha256')
          .update(
            JSON.stringify(
              [product.nameRu, product.nameRo, product.brand, product.quantity].map((v) =>
                v.trim().toLowerCase(),
              ),
            ),
          )
          .digest('hex');
}
export async function findApproved(product: SearchProduct): Promise<Candidate[]> {
  if (!databaseConfigured()) return [];
  const { rows } = await database().query<{ id: string; candidate: Candidate }>(
    'SELECT id,candidate FROM shelf_library WHERE product_key=$1 ORDER BY created_at DESC LIMIT 4',
    [productKey(product)],
  );
  return rows
    .map((row) => ({
      ...row.candidate,
      id: row.id,
      imageUrl: `/api/library/${row.id}/image`,
      source: 'Общий каталог · подтверждено ранее',
      warnings: ['Ранее подтверждённая фотография. Проверьте актуальность упаковки.'],
    }))
    .map((candidate) => matchCandidate(product, candidate))
    .filter((match) => !match.rejected)
    .map((match) => match.candidate);
}
export async function saveApproved(
  product: SearchProduct,
  candidate: Candidate,
  image: Buffer,
): Promise<string> {
  const id = randomUUID();
  const hash = createHash('sha256').update(image).digest('hex');
  const key = productKey(product);
  // Bound storage on the free plan. Never silently discard existing approved images.
  const client = await database().connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(874136)');
    const existing = await client.query<{ id: string }>(
      'SELECT id FROM shelf_library WHERE product_key=$1 AND image_hash=$2',
      [key, hash],
    );
    const { rows } = await client.query<{ bytes: string }>(
      'SELECT coalesce(sum(octet_length(image)),0)::text AS bytes FROM shelf_library',
    );
    if (!existing.rows.length && Number(rows[0].bytes) + image.length > 200_000_000)
      throw new ApiError(
        507,
        'Каталог достиг лимита 200 МБ. Фото сохранено в текущей партии; общая база не пополнена.',
      );
    const saved = await client.query<{ id: string }>(
      `INSERT INTO shelf_library(id,product_key,product,candidate,image,image_hash) VALUES($1,$2,$3,$4,$5,$6)
      ON CONFLICT(product_key,image_hash) WHERE image_hash IS NOT NULL DO UPDATE SET candidate=excluded.candidate,product=excluded.product,created_at=now()
      RETURNING id`,
      [id, key, product, candidate, image, hash],
    );
    await client.query('COMMIT');
    return saved.rows[0].id;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
