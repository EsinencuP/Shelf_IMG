'use client';

import { useEffect, useState, type RefObject } from 'react';
import type { Candidate } from '@/lib/types';
import { apiFetch, candidateImageEndpoint } from '@/lib/client-api';
import BlobImage from './blob-image';

// Thumbnail failures must not flood the server's image concurrency limit.
let active = 0;
const waiting: (() => void)[] = [];
async function preview(job: () => Promise<void>) {
  if (active >= 2) await new Promise<void>((resolve) => waiting.push(resolve));
  else active++;
  try {
    await Promise.resolve();
    await job();
  } finally {
    const next = waiting.shift();
    if (next) next();
    else active--;
  }
}

export default function CandidatePhoto({
  candidate,
  prefetch,
  images,
}: {
  candidate: Candidate;
  prefetch: boolean;
  images: RefObject<Map<Candidate, Blob>>;
}) {
  const [blob, setBlob] = useState<Blob>();
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const retry = () => {
      setError('');
      setAttempt((value) => value + 1);
    };
    window.addEventListener('shelf-access-changed', retry);
    return () => window.removeEventListener('shelf-access-changed', retry);
  }, []);
  useEffect(() => {
    if (!prefetch) return;
    const controller = new AbortController();
    void preview(async () => {
      if (controller.signal.aborted) return;
      const cached = images.current.get(candidate);
      if (cached) {
        setBlob(cached);
        return;
      }
      try {
        const response = await apiFetch(candidateImageEndpoint(candidate), {
          signal: controller.signal,
        });
        const image = await response.blob();
        if (!controller.signal.aborted) {
          images.current.set(candidate, image);
          setBlob(image);
          setError('');
        }
      } catch (failure) {
        if (!controller.signal.aborted)
          setError(failure instanceof Error ? failure.message : 'Фото недоступно.');
      }
    });
    return () => controller.abort();
  }, [prefetch, candidate, images, attempt]);
  if (blob) return <BlobImage blob={blob} alt={candidate.title} />;
  return (
    <small role={error ? 'status' : undefined}>
      {error || (prefetch ? 'Загрузка фото…' : 'Открыть фотографию')}
    </small>
  );
}
