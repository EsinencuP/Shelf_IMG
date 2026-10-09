/** Pure pixel operations shared by the browser processor and numerical tests. */
export interface Bounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export function maskBounds(
  mask: ArrayLike<number>,
  width: number,
  height: number,
  threshold = 8,
): Bounds | null {
  if (mask.length !== width * height) throw new Error('Размер маски не совпадает с изображением.');
  let left = width,
    top = height,
    right = -1,
    bottom = -1;
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      if (mask[y * width + x] < threshold) continue;
      left = Math.min(left, x);
      right = Math.max(right, x);
      top = Math.min(top, y);
      bottom = Math.max(bottom, y);
    }
  return right < left
    ? null
    : { x: left, y: top, width: right - left + 1, height: bottom - top + 1 };
}

export function fitWithin(
  width: number,
  height: number,
  maxSide: number,
): { width: number; height: number } {
  if (![width, height, maxSide].every((n) => Number.isFinite(n) && n > 0))
    throw new Error('Некорректный размер изображения.');
  const scale = Math.min(1, maxSide / Math.max(width, height));
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

/** Match rembg's image/max(image), channel mean/std and NCHW preprocessing. */
export function u2netInput(rgba: Uint8ClampedArray): Float32Array {
  if (rgba.length % 4) throw new Error('Некорректные RGB-пиксели.');
  const count = rgba.length / 4;
  let maximum = 1;
  for (let i = 0; i < rgba.length; i += 4)
    maximum = Math.max(maximum, rgba[i], rgba[i + 1], rgba[i + 2]);
  const mean = [0.485, 0.456, 0.406],
    std = [0.229, 0.224, 0.225];
  const result = new Float32Array(count * 3);
  for (let i = 0; i < count; i++)
    for (let c = 0; c < 3; c++) {
      result[c * count + i] = (rgba[i * 4 + c] / maximum - mean[c]) / std[c];
    }
  return result;
}

export function normalizePrediction(values: ArrayLike<number>): Uint8Array {
  let minimum = Infinity,
    maximum = -Infinity;
  for (let i = 0; i < values.length; i++) {
    if (!Number.isFinite(values[i])) throw new Error('Нейросеть вернула некорректную маску.');
    minimum = Math.min(minimum, values[i]);
    maximum = Math.max(maximum, values[i]);
  }
  if (maximum - minimum < 1e-6)
    throw new Error('Нейросеть не выделила товар. Выберите другое фото или обычный режим.');
  return Uint8Array.from(values, (value) =>
    Math.round((255 * (value - minimum)) / (maximum - minimum)),
  );
}

/** Half-pixel bilinear interpolation, clamped at the source edges. */
export function resizeMask(
  mask: Uint8Array,
  width: number,
  height: number,
  targetWidth: number,
  targetHeight: number,
): Uint8Array {
  if (mask.length !== width * height) throw new Error('Некорректная маска.');
  const result = new Uint8Array(targetWidth * targetHeight);
  for (let y = 0; y < targetHeight; y++) {
    const sy = Math.max(0, Math.min(height - 1, ((y + 0.5) * height) / targetHeight - 0.5));
    const y0 = Math.floor(sy),
      y1 = Math.min(height - 1, y0 + 1),
      fy = sy - y0;
    for (let x = 0; x < targetWidth; x++) {
      const sx = Math.max(0, Math.min(width - 1, ((x + 0.5) * width) / targetWidth - 0.5));
      const x0 = Math.floor(sx),
        x1 = Math.min(width - 1, x0 + 1),
        fx = sx - x0;
      const upper = mask[y0 * width + x0] * (1 - fx) + mask[y0 * width + x1] * fx;
      const lower = mask[y1 * width + x0] * (1 - fx) + mask[y1 * width + x1] * fx;
      result[y * targetWidth + x] = Math.round(upper * (1 - fy) + lower * fy);
    }
  }
  return result;
}

/** Keep original product RGB; only alpha/background changes. Output is fully opaque. */
export function compositeWhite(
  rgba: Uint8ClampedArray,
  mask: Uint8Array,
): Uint8ClampedArray<ArrayBuffer> {
  if (rgba.length !== mask.length * 4) throw new Error('Размер маски не совпадает с изображением.');
  const result = new Uint8ClampedArray(rgba.length);
  for (let i = 0; i < mask.length; i++) {
    const alpha = mask[i] / 255;
    for (let c = 0; c < 3; c++)
      result[i * 4 + c] = Math.round(rgba[i * 4 + c] * alpha + 255 * (1 - alpha));
    result[i * 4 + 3] = 255;
  }
  return result;
}

/** Flood only near-white background connected to an image border; enclosed white stays. */
export function whiteBackgroundMask(
  rgba: Uint8ClampedArray,
  width: number,
  height: number,
): Uint8Array {
  const count = width * height;
  if (rgba.length !== count * 4) throw new Error('Некорректные пиксели.');
  const mask = new Uint8Array(count).fill(255);
  const queue = new Uint32Array(count);
  let head = 0,
    tail = 0;
  const add = (index: number) => {
    if (mask[index] === 0) return;
    const p = index * 4,
      r = rgba[p],
      g = rgba[p + 1],
      b = rgba[p + 2];
    if (Math.min(r, g, b) < 238 || Math.max(r, g, b) - Math.min(r, g, b) > 18) return;
    mask[index] = 0;
    queue[tail++] = index;
  };
  for (let x = 0; x < width; x++) {
    add(x);
    add((height - 1) * width + x);
  }
  for (let y = 0; y < height; y++) {
    add(y * width);
    add(y * width + width - 1);
  }
  if (tail === 0)
    throw new Error(
      'Обычный режим требует белого фона по краям. Используйте нейросеть или другое фото.',
    );
  while (head < tail) {
    const index = queue[head++],
      x = index % width;
    if (x > 0) add(index - 1);
    if (x + 1 < width) add(index + 1);
    if (index >= width) add(index - width);
    if (index + width < count) add(index + width);
  }
  return mask;
}

/** Discard disconnected mask specks; don't infer a missing product region. */
export function mainComponent(
  mask: Uint8Array,
  width: number,
  height: number,
): { mask: Uint8Array; otherFraction: number } {
  const seen = new Uint8Array(mask.length),
    queue = new Uint32Array(mask.length);
  let largest: number[] = [],
    other = 0;
  for (let start = 0; start < mask.length; start++) {
    if (seen[start] || mask[start] < 64) continue;
    let head = 0,
      tail = 1;
    queue[0] = start;
    seen[start] = 1;
    const indices: number[] = [];
    const add = (index: number) => {
      if (!seen[index] && mask[index] >= 64) {
        seen[index] = 1;
        queue[tail++] = index;
      }
    };
    while (head < tail) {
      const index = queue[head++],
        x = index % width;
      indices.push(index);
      if (x > 0) add(index - 1);
      if (x + 1 < width) add(index + 1);
      if (index >= width) add(index - width);
      if (index + width < mask.length) add(index + width);
    }
    if (indices.length > largest.length) {
      other += largest.length;
      largest = indices;
    } else other += indices.length;
  }
  if (largest.length < mask.length * 0.003)
    throw new Error('Товар слишком мал или маска ненадёжна. Выберите другое фото.');
  const result = new Uint8Array(mask.length);
  for (const index of largest) result[index] = mask[index] >= 245 ? 255 : mask[index];
  return { mask: result, otherFraction: other / (largest.length + other) };
}

export interface ImageHeader {
  mime: 'image/png' | 'image/jpeg' | 'image/webp';
  width: number;
  height: number;
}

/** Read dimensions before decode, so a compressed oversized image is rejected early. */
export function readImageHeader(bytes: Uint8Array): ImageHeader {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (
    bytes.length >= 24 &&
    bytes[0] === 137 &&
    bytes[1] === 80 &&
    bytes[2] === 78 &&
    bytes[3] === 71
  ) {
    if (view.getUint32(4) !== 0x0d0a1a0a || view.getUint32(12) !== 0x49484452)
      throw new Error('Некорректный PNG.');
    for (let offset = 8; offset + 12 <= bytes.length;) {
      const length = view.getUint32(offset);
      if (offset + length + 12 > bytes.length) throw new Error('Повреждённый PNG.');
      if (view.getUint32(offset + 4) === 0x6163544c)
        throw new Error('Анимированные изображения не поддерживаются.');
      offset += length + 12;
    }
    return { mime: 'image/png', width: view.getUint32(16), height: view.getUint32(20) };
  }
  if (bytes.length >= 4 && bytes[0] === 255 && bytes[1] === 216) {
    let offset = 2;
    while (offset + 4 < bytes.length) {
      if (bytes[offset++] !== 255) throw new Error('Повреждённый JPEG.');
      while (bytes[offset] === 255) offset++;
      if (offset >= bytes.length) throw new Error('Повреждённый JPEG.');
      const marker = bytes[offset++];
      if (marker === 0xd9 || marker === 0xda) break;
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
      if (offset + 2 > bytes.length) throw new Error('Повреждённый JPEG.');
      const length = view.getUint16(offset);
      if (length < 2 || offset + length > bytes.length) throw new Error('Повреждённый JPEG.');
      if (
        [0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(
          marker,
        )
      ) {
        if (length < 8) throw new Error('Повреждённый JPEG.');
        return {
          mime: 'image/jpeg',
          height: view.getUint16(offset + 3),
          width: view.getUint16(offset + 5),
        };
      }
      offset += length;
    }
  }
  if (bytes.length >= 30 && view.getUint32(0) === 0x52494646 && view.getUint32(8) === 0x57454250) {
    const type = view.getUint32(12);
    if (type === 0x56503858) {
      if (bytes[20] & 2) throw new Error('Анимированные изображения не поддерживаются.');
      return {
        mime: 'image/webp',
        width: 1 + bytes[24] + (bytes[25] << 8) + (bytes[26] << 16),
        height: 1 + bytes[27] + (bytes[28] << 8) + (bytes[29] << 16),
      };
    }
    if (type === 0x5650384c && bytes[20] === 0x2f) {
      return {
        mime: 'image/webp',
        width: 1 + bytes[21] + ((bytes[22] & 63) << 8),
        height: 1 + (bytes[22] >> 6) + (bytes[23] << 2) + ((bytes[24] & 15) << 10),
      };
    }
    if (type === 0x56503820 && bytes[23] === 0x9d && bytes[24] === 1 && bytes[25] === 0x2a) {
      return {
        mime: 'image/webp',
        width: view.getUint16(26, true) & 0x3fff,
        height: view.getUint16(28, true) & 0x3fff,
      };
    }
  }
  throw new Error('Нужен обычный JPEG, PNG или WebP. SVG, GIF и анимации не поддерживаются.');
}
