import { createHash } from 'node:crypto';
import type { Candidate } from '../types';
import { ApiError } from './http';
import { publicGet, MAX_IMAGE_BYTES } from './public-fetch';
import { sourceFailure } from './source-policy';

export function detectImageType(
  bytes: Uint8Array,
): 'image/jpeg' | 'image/png' | 'image/webp' | null {
  const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff)
    return 'image/jpeg';
  if (
    buffer.length >= 8 &&
    buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  )
    return 'image/png';
  if (
    buffer.length >= 12 &&
    buffer.toString('ascii', 0, 4) === 'RIFF' &&
    buffer.toString('ascii', 8, 12) === 'WEBP'
  )
    return 'image/webp';
  return null;
}

/** Network check usable in both the Next.js and Neon worker runtimes. */
export async function checkSourcePhoto(candidate: Candidate): Promise<string> {
  const result = await publicGet(candidate.imageUrl, {
    maxBytes: MAX_IMAGE_BYTES,
    timeoutMs: 5_000,
    signal: AbortSignal.timeout(5_000),
    referer: candidate.pageUrl || undefined,
  });
  if (result.status !== 200)
    throw await sourceFailure(
      candidate.imageUrl,
      result,
      `Фото недоступно (HTTP ${result.status}).`,
    );
  if (!detectImageType(result.body))
    throw new ApiError(502, 'Источник вернул некорректный формат фотографии.');
  return createHash('sha256').update(result.body).digest('hex');
}
