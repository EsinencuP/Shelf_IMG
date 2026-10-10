import type { ExportProfile } from './types';
import {
  compositeWhite,
  fitWithin,
  mainComponent,
  maskBounds,
  normalizePrediction,
  readImageHeader,
  resizeMask,
  u2netInput,
  whiteBackgroundMask,
  lostProductDetail,
} from './image-math';

const MODEL_SHA256 = '309c8469258dda742793dce0ebea8e6dd393174f89934733ecc8b14c76f4ddd8';
const MAX_BYTES = 4 * 1024 * 1024;
const MAX_PIXELS = 20_000_000;
const MAX_DIMENSION = 16_384;
let sessionPromise: Promise<import('onnxruntime-web').InferenceSession> | undefined;

function canvas(width: number, height: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const element = document.createElement('canvas');
  element.width = width;
  element.height = height;
  const context = element.getContext('2d', { willReadFrequently: true });
  if (!context) throw new Error('Браузер не поддерживает обработку изображений.');
  return [element, context];
}

async function getSession() {
  if (!sessionPromise) {
    sessionPromise = (async () => {
      const ort = await import('onnxruntime-web/wasm');
      ort.env.wasm.numThreads = 1;
      ort.env.wasm.proxy = true;
      ort.env.wasm.wasmPaths = '/onnx/';
      const response = await fetch('/models/u2netp.onnx', { signal: AbortSignal.timeout(30_000) });
      if (!response.ok)
        throw new Error('Локальная модель отсутствует: выполните npm run setup:model.');
      const model = await response.arrayBuffer();
      if (model.byteLength !== 4_574_861)
        throw new Error('Файл локальной модели повреждён. Выполните npm run setup:model.');
      const digest = await crypto.subtle.digest('SHA-256', model);
      const hash = Array.from(new Uint8Array(digest), (value) =>
        value.toString(16).padStart(2, '0'),
      ).join('');
      if (hash !== MODEL_SHA256) throw new Error('Контрольная сумма локальной модели не совпала.');
      return ort.InferenceSession.create(model, {
        executionProviders: ['wasm'],
        graphOptimizationLevel: 'all',
      });
    })().catch((error) => {
      sessionPromise = undefined;
      throw error;
    });
  }
  return sessionPromise;
}

async function aiMask(
  source: HTMLCanvasElement,
  width: number,
  height: number,
  warnings: string[],
  progress: (message: string) => void,
) {
  progress('Загрузка локальной модели U²-Net…');
  try {
    const [modelCanvas, modelContext] = canvas(320, 320);
    modelContext.fillStyle = '#ffffff';
    modelContext.fillRect(0, 0, 320, 320);
    modelContext.imageSmoothingQuality = 'high';
    modelContext.drawImage(source, 0, 0, 320, 320);
    const input = u2netInput(modelContext.getImageData(0, 0, 320, 320).data);
    modelCanvas.width = modelCanvas.height = 1;
    const session = await getSession();
    const ort = await import('onnxruntime-web/wasm');
    progress('Нейросеть выделяет упаковку на вашем устройстве…');
    const tensor = new ort.Tensor('float32', input, [1, 3, 320, 320]);
    let output: Awaited<ReturnType<typeof session.run>> | undefined;
    let normalized: Uint8Array;
    try {
      output = await session.run({ [session.inputNames[0]]: tensor });
      const prediction = output[session.outputNames[0]];
      if (
        !prediction ||
        prediction.data.length !== 320 * 320 ||
        !(prediction.data instanceof Float32Array)
      )
        throw new Error('Неожиданный формат маски U²-Net.');
      normalized = normalizePrediction(prediction.data);
    } finally {
      if (output) for (const result of Object.values(output)) result.dispose();
      tensor.dispose();
    }
    const cleaned = mainComponent(normalized, 320, 320);
    if (cleaned.otherFraction > 0.03)
      warnings.push(
        'Маска содержала несколько объектов: оставлена основная область. Проверьте крышку, ручку и полный комплект товара.',
      );
    warnings.push(
      'Проверьте контур, крышку и дно. Локальная модель может ошибаться на белой или прозрачной упаковке и сохранять тень.',
    );
    return resizeMask(cleaned.mask, 320, 320, width, height);
  } catch (error) {
    const detail = error instanceof Error ? error.message : 'Ошибка ONNX Runtime.';
    throw new Error(
      `Нейросеть не выполнила обработку. ${detail} Можно явно выбрать «Белый фон без нейросети».`,
    );
  }
}

export async function processImage(
  blob: Blob,
  profile: ExportProfile,
  onProgress?: (message: string) => void,
): Promise<{ blob: Blob; width: number; height: number; warnings: string[]; method: string }> {
  const progress = onProgress ?? (() => {});
  if (!blob.size || blob.size > MAX_BYTES) throw new Error('Фото должно занимать не больше 4 МБ.');
  if (!Number.isInteger(profile.maxSide) || profile.maxSide < 64 || profile.maxSide > 4096)
    throw new Error('Длинная сторона должна быть целым числом от 64 до 4096 пикселей.');
  if (!Number.isFinite(profile.quality) || profile.quality < 0.5 || profile.quality > 1)
    throw new Error('Качество JPEG должно быть от 0,5 до 1.');
  if (profile.method !== 'ai' && profile.method !== 'white')
    throw new Error('Неизвестный режим обработки.');
  progress('Проверка исходного изображения…');
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const header = readImageHeader(bytes);
  if (header.width < 32 || header.height < 32 || header.width * header.height > MAX_PIXELS)
    throw new Error('Допустимое фото: минимум 32 × 32 пикселя и не больше 20 мегапикселей.');
  if (header.width > MAX_DIMENSION || header.height > MAX_DIMENSION)
    throw new Error('Сторона исходного фото не должна превышать 16 384 пикселя.');
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(new Blob([bytes], { type: header.mime }));
  } catch {
    throw new Error(
      'Не удалось прочитать фото. Файл повреждён или формат не поддерживается браузером.',
    );
  }
  const width = bitmap.width,
    height = bitmap.height;
  if (width * height > MAX_PIXELS) {
    bitmap.close();
    throw new Error('Фото превышает 20 мегапикселей.');
  }
  const [source, sourceContext] = canvas(width, height);
  const warnings: string[] = [];
  try {
    sourceContext.drawImage(bitmap, 0, 0);
    bitmap.close();
    const rgba = sourceContext.getImageData(0, 0, width, height).data;
    let transparentPixels = 0;
    for (let i = 3; i < rgba.length; i += 4) if (rgba[i] < 250) transparentPixels++;
    let mask: Uint8Array, method: string;
    if (transparentPixels > 0) {
      mask = new Uint8Array(width * height);
      for (let i = 0; i < mask.length; i++) mask[i] = rgba[i * 4 + 3];
      method = 'alpha';
      warnings.push('Использована исходная прозрачность: повторная сегментация не выполнялась.');
    } else if (profile.method === 'white') {
      progress('Удаление белого фона, соединённого с краями…');
      mask = whiteBackgroundMask(rgba, width, height);
      method = 'white';
      warnings.push(
        'Обычный режим подходит для чистого белого фона. Проверьте белые края товара и оставшуюся тень.',
      );
    } else {
      mask = await aiMask(source, width, height, warnings, progress);
      if (lostProductDetail(rgba, mask, width, height))
        throw new Error(
          'Нейросеть удалила значительную часть рисунка или упаковки на белом фоне. Результат отклонён. Выберите обрезку светлого фона для этой фотографии или другой исходник.',
        );
      method = 'u2netp';
    }
    const bounds = maskBounds(mask, width, height);
    if (!bounds)
      throw new Error('Товар не обнаружен: изображение пустое или слишком похоже на фон.');
    let foreground = 0;
    for (let i = 0; i < mask.length; i++) if (mask[i] >= 128) foreground++;
    if (foreground < width * height * 0.003)
      throw new Error('Товар слишком мал или маска ненадёжна. Выберите другое фото.');
    if (foreground > width * height * 0.985)
      warnings.push(
        'Фон почти не отделён или товар занимает весь исходник. Проверьте результат вручную.',
      );
    if (
      bounds.x === 0 ||
      bounds.y === 0 ||
      bounds.x + bounds.width === width ||
      bounds.y + bounds.height === height
    )
      warnings.push('Товар касается края исходного фото: упаковка может быть обрезана.');
    if (Math.max(bounds.width, bounds.height) < 500 || Math.min(bounds.width, bounds.height) < 120)
      warnings.push('Низкая детализация упаковки. Разрешение не увеличивалось.');
    progress('Белый фон и плотная прямоугольная обрезка…');
    const composite = compositeWhite(rgba, mask);
    sourceContext.putImageData(new ImageData(composite, width, height), 0, 0);
    const target = fitWithin(bounds.width, bounds.height, profile.maxSide);
    const [output, outputContext] = canvas(target.width, target.height);
    outputContext.fillStyle = '#ffffff';
    outputContext.fillRect(0, 0, target.width, target.height);
    outputContext.imageSmoothingQuality = 'high';
    outputContext.drawImage(
      source,
      bounds.x,
      bounds.y,
      bounds.width,
      bounds.height,
      0,
      0,
      target.width,
      target.height,
    );
    const jpeg = await new Promise<Blob>((resolve, reject) =>
      output.toBlob(
        (value) => (value ? resolve(value) : reject(new Error('Браузер не смог создать JPEG.'))),
        'image/jpeg',
        profile.quality,
      ),
    );
    output.width = output.height = 1;
    return { blob: jpeg, width: target.width, height: target.height, warnings, method };
  } finally {
    bitmap.close();
    source.width = source.height = 1;
  }
}

export function downloadBlob(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob),
    link = document.createElement('a');
  link.href = url;
  link.download = name;
  link.style.display = 'none';
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}
