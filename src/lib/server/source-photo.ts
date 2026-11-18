import { createHash } from 'node:crypto';
import type { Candidate, SourcePhotoCheck } from '../types';
import { normalizeSourceImage } from './image';
import { publicGet, MAX_IMAGE_BYTES } from './public-fetch';
import { sourceFailure } from './source-policy';
import { abortable, currentSearchSignal } from './search-signal';

export async function checkSourcePhoto(candidate: Candidate): Promise<SourcePhotoCheck> {
  const signal = currentSearchSignal(AbortSignal.timeout(5_000));
  const result = await publicGet(candidate.imageUrl, {
    maxBytes: MAX_IMAGE_BYTES,
    timeoutMs: 5_000,
    signal,
    referer: candidate.pageUrl || undefined,
  });
  if (result.status !== 200)
    throw await sourceFailure(
      candidate.imageUrl,
      result,
      `Фото недоступно (HTTP ${result.status}).`,
    );
  signal?.throwIfAborted();
  const { width, height, mime } = await abortable(normalizeSourceImage(result.body), signal);
  return {
    sha256: createHash('sha256').update(result.body).digest('hex'),
    width,
    height,
    mime,
    checkedAt: new Date().toISOString(),
  };
}
