import sharp from 'sharp';
import { ApiError } from './http';
import { MAX_IMAGE_BYTES } from './public-fetch';
import { detectImageType } from './source-photo';
export { detectImageType } from './source-photo';

export async function inspectImage(
  bytes: Uint8Array,
): Promise<{ mime: string; width: number; height: number }> {
  const mime = detectImageType(bytes);
  if (!mime)
    throw new ApiError(415, 'Поддерживаются JPEG, PNG и WebP. SVG и прочие форматы запрещены.');
  try {
    const image = sharp(Buffer.from(bytes), {
      limitInputPixels: 20_000_000,
      animated: false,
      failOn: 'warning',
    });
    const metadata = await image.metadata();
    if (
      !metadata.width ||
      !metadata.height ||
      (metadata.pages || 1) > 1 ||
      metadata.width * metadata.height > 20_000_000
    )
      throw new Error('Invalid dimensions');
    await image.stats();
    return { mime, width: metadata.width, height: metadata.height };
  } catch {
    throw new ApiError(422, 'Файл повреждён, анимирован или превышает 20 млн пикселей.');
  }
}

function extraRasterType(bytes: Buffer): boolean {
  if (bytes.length >= 6 && /^GIF8[79]a$/.test(bytes.toString('ascii', 0, 6))) return true;
  if (
    bytes.length >= 4 &&
    (bytes.subarray(0, 4).equals(Buffer.from([73, 73, 42, 0])) ||
      bytes.subarray(0, 4).equals(Buffer.from([77, 77, 0, 42])))
  )
    return true;
  if (bytes.length >= 16 && bytes.toString('ascii', 4, 8) === 'ftyp') {
    const boxSize = bytes.readUInt32BE(0);
    if (boxSize < 16 || boxSize > Math.min(bytes.length, 128)) return false;
    const brands = [bytes.toString('ascii', 8, 12)];
    for (let offset = 16; offset + 4 <= boxSize; offset += 4)
      brands.push(bytes.toString('ascii', offset, offset + 4));
    return brands.includes('avif') && !brands.includes('avis');
  }
  return false;
}

/** Lossless normalization for static catalogue formats the browser pipeline cannot read. */
export async function normalizeSourceImage(
  bytes: Uint8Array,
): Promise<{ body: Buffer; mime: string; converted: boolean }> {
  const buffer = Buffer.from(bytes);
  if (!buffer.length || buffer.length > MAX_IMAGE_BYTES)
    throw new ApiError(413, 'Фото должно занимать не больше 4 МБ.');
  const supported = detectImageType(buffer);
  if (supported) {
    await inspectImage(buffer);
    return { body: buffer, mime: supported, converted: false };
  }
  if (!extraRasterType(buffer))
    throw new ApiError(
      415,
      'Допускаются JPEG, PNG, WebP, AVIF, статический GIF и TIFF. SVG запрещён.',
    );
  try {
    const input = sharp(buffer, { limitInputPixels: 20000000, animated: false });
    const metadata = await input.metadata();
    if (
      !metadata.width ||
      !metadata.height ||
      (metadata.pages || 1) !== 1 ||
      metadata.width * metadata.height > 20000000
    )
      throw new ApiError(422, 'Требуется статическое изображение до 20 млн пикселей.');
    const body = await input.rotate().png({ compressionLevel: 9 }).toBuffer();
    if (body.length > MAX_IMAGE_BYTES)
      throw new ApiError(
        413,
        'После преобразования фото превышает 4 МБ. Выберите более компактный исходник.',
      );
    await inspectImage(body);
    return { body, mime: 'image/png', converted: true };
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(
      422,
      'Не удалось прочитать статическое изображение. Файл повреждён или формат не поддерживается.',
    );
  }
}
