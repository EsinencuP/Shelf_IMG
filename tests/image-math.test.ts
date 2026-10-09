import { test } from 'vitest';
import assert from 'node:assert/strict';
import { compositeWhite, fitWithin, mainComponent, maskBounds, normalizePrediction, readImageHeader, resizeMask, u2netInput, whiteBackgroundMask } from '../src/lib/image-math';

test('tight bounds include all extreme product pixels and no margins', () => {
  const mask = new Uint8Array(7 * 9);
  mask[2 * 7 + 2] = 255; mask[7 * 7 + 4] = 255;
  assert.deepEqual(maskBounds(mask, 7, 9), { x: 2, y: 2, width: 3, height: 6 });
  assert.equal(maskBounds(new Uint8Array(20), 4, 5), null);
});

test('resize preserves aspect ratio and never upscales', () => {
  assert.deepEqual(fitWithin(800, 1600, 1200), { width: 600, height: 1200 });
  assert.deepEqual(fitWithin(200, 100, 1600), { width: 200, height: 100 });
  assert.throws(() => fitWithin(0, 100, 1600));
});

test('compositing keeps opaque packaging RGB and produces an opaque white background', () => {
  const pixels = new Uint8ClampedArray([15, 28, 72, 255, 0, 0, 0, 0, 25, 45, 65, 255]);
  assert.deepEqual(Array.from(compositeWhite(pixels, new Uint8Array([255, 0, 128]))), [15, 28, 72, 255, 255, 255, 255, 255, 140, 150, 160, 255]);
});

test('border flood removes exterior white but preserves an enclosed white label', () => {
  const width = 7, height = 7, pixels = new Uint8ClampedArray(width * height * 4).fill(255);
  for (let y = 1; y < 6; y++) for (let x = 1; x < 6; x++) {
    if (x !== 1 && x !== 5 && y !== 1 && y !== 5) continue;
    const p = (y * width + x) * 4;
    pixels[p] = 25; pixels[p + 1] = 100; pixels[p + 2] = 180;
  }
  const mask = whiteBackgroundMask(pixels, width, height);
  assert.equal(mask[0], 0); assert.equal(mask[3 * width + 3], 255);
  assert.deepEqual(maskBounds(mask, width, height), { x: 1, y: 1, width: 5, height: 5 });
});

test('an all-white source produces no product; a colored background is rejected', () => {
  const pixels = new Uint8ClampedArray(100 * 4).fill(255);
  assert.equal(maskBounds(whiteBackgroundMask(pixels, 10, 10), 10, 10), null);
  for (let i = 0; i < pixels.length; i += 4) pixels[i] = 10;
  assert.throws(() => whiteBackgroundMask(pixels, 10, 10), /белого фона/);
});

test('U2Net normalization uses per-image maximum and planar CHW channel order', () => {
  const result = u2netInput(new Uint8ClampedArray([100, 50, 0, 255, 50, 100, 100, 255]));
  const expected = [(1 - .485) / .229, (.5 - .485) / .229, (.5 - .456) / .224, (1 - .456) / .224, (0 - .406) / .225, (1 - .406) / .225];
  expected.forEach((value, i) => assert.ok(Math.abs(result[i] - value) < 1e-5));
});

test('flat/nonfinite model output fails instead of producing a plausible success', () => {
  assert.throws(() => normalizePrediction([.5, .5, .5]), /не выделила/);
  assert.throws(() => normalizePrediction([0, NaN, 1]), /некорректную/);
  assert.deepEqual(Array.from(normalizePrediction([2, 4, 6])), [0, 128, 255]);
});

test('bilinear mask preserves corners and interpolates middle coverage', () => {
  const result = resizeMask(new Uint8Array([0, 255, 255, 0]), 2, 2, 3, 3);
  assert.deepEqual(Array.from(result), [0, 128, 255, 128, 128, 128, 255, 128, 0]);
});

test('main component removes detached specks and reports other substantial regions', () => {
  const mask = new Uint8Array(100);
  for (let y = 1; y <= 4; y++) for (let x = 1; x <= 4; x++) mask[y * 10 + x] = 255;
  mask[88] = 255;
  const cleaned = mainComponent(mask, 10, 10);
  assert.equal(cleaned.mask[88], 0); assert.equal(cleaned.mask[11], 255);
  assert.equal(cleaned.otherFraction, 1 / 17);
  assert.throws(() => mainComponent(new Uint8Array(100), 10, 10), /ненадёжна/);
});

test('image header rejects unsupported content before browser decode', () => {
  assert.throws(() => readImageHeader(new TextEncoder().encode('<svg></svg>')), /JPEG, PNG или WebP/);
  const bytes = new Uint8Array(33), view = new DataView(bytes.buffer);
  bytes.set([137, 80, 78, 71, 13, 10, 26, 10]);
  view.setUint32(8, 13); view.setUint32(12, 0x49484452); view.setUint32(16, 800); view.setUint32(20, 1600);
  assert.deepEqual(readImageHeader(bytes), { mime: 'image/png', width: 800, height: 1600 });
});
