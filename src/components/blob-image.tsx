'use client';

import { useEffect, useState } from 'react';

export default function BlobImage({ blob, alt, className = '' }: { blob?: Blob; alt: string; className?: string }) {
  const [url, setUrl] = useState('');
  useEffect(() => {
    if (!blob) return;
    const nextUrl = URL.createObjectURL(blob);
    setUrl(nextUrl);
    return () => URL.revokeObjectURL(nextUrl);
  }, [blob]);
  return url ? <img src={url} alt={alt} className={className} /> : null;
}
