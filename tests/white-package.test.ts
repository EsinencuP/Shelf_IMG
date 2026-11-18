import { expect, it } from 'vitest';
import { maskBounds, preserveWhitePackage, compositeWhite } from '../src/lib/image-math';
function fixture(background: number) {
  const width = 100,
    height = 150;
  const rgba = new Uint8ClampedArray(width * height * 4);
  const mask = new Uint8Array(width * height);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const p = (y * width + x) * 4;
      rgba.set([background, background, background, 255], p);
      if (x >= 20 && x < 80 && y >= 30 && y < 140) {
        rgba.set([240, 200, 70, 255], p);
        mask[y * width + x] = 255;
      }
      if (x >= 10 && x < 30 && y >= 5 && y < 40) rgba.set([220, 220, 220, 255], p);
    }
  return { rgba, mask, width, height };
}
it('preserves a neutral cap missed by the neural mask on a white catalogue photo', () => {
  const { rgba, mask, width, height } = fixture(255);
  const preserved = preserveWhitePackage(rgba, mask, width, height)!;
  expect(preserved).not.toBeNull();
  expect(maskBounds(preserved, width, height)).toEqual({ x: 10, y: 5, width: 70, height: 135 });
  const cap = (10 * width + 15) * 4;
  expect([...compositeWhite(rgba, preserved).slice(cap, cap + 4)]).toEqual([220, 220, 220, 255]);
});
it('does not use white-background recovery on a coloured backdrop', () => {
  const { rgba, mask, width, height } = fixture(180);
  expect(preserveWhitePackage(rgba, mask, width, height)).toBeNull();
});
it('keeps a complete neural silhouette', () => {
  const { rgba, mask, width, height } = fixture(255);
  for (let y = 5; y < 40; y++) for (let x = 10; x < 30; x++) mask[y * width + x] = 255;
  expect(preserveWhitePackage(rgba, mask, width, height)).toBeNull();
});
