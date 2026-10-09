import sharp from 'sharp';
import { ApiError } from './http';

export function detectImageType(bytes: Uint8Array): 'image/jpeg' | 'image/png' | 'image/webp' | null {
  const buffer = Buffer.from(bytes);
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'image/jpeg';
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'image/png';
  if (buffer.length >= 12 && buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  return null;
}

export async function inspectImage(bytes: Uint8Array): Promise<{ mime: string; width: number; height: number }> {
  const mime = detectImageType(bytes);
  if (!mime) throw new ApiError(415, 'Поддерживаются JPEG, PNG и WebP. SVG и прочие форматы запрещены.');
  try {
    const metadata = await sharp(Buffer.from(bytes), { limitInputPixels: 20_000_000, animated: false }).metadata();
    if (!metadata.width || !metadata.height || (metadata.pages || 1) > 1 || metadata.width * metadata.height > 20_000_000) throw new Error('Invalid dimensions');
    return { mime, width: metadata.width, height: metadata.height };
  } catch { throw new ApiError(422, 'Файл повреждён, анимирован или превышает 20 млн пикселей.'); }
}
