import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import golden from './fixtures/golden-skus.json';
import { validateGoldenSkus, type GoldenSkuFile } from './fixtures/validate-golden-skus';
import { runGoldenValidation } from '../scripts/validate-golden-skus';

// Synthetic data tests the validator only; these rows never enter golden-skus.json.
function syntheticSet(): GoldenSkuFile {
  return {
    $schema: './golden-skus.schema.json',
    version: 1,
    status: 'ready',
    skus: Array.from({ length: 20 }, (_, index) => {
      const stem = String(200000000000 + index);
      const sum = [...stem]
        .reverse()
        .reduce((total, digit, offset) => total + Number(digit) * (offset % 2 === 0 ? 3 : 1), 0);
      return {
        ean: `${stem}${(10 - (sum % 10)) % 10}`,
        nameRu: `ТЕСТОВЫЙ товар ${index}`,
        nameRo: `PRODUS DE TEST ${index}`,
        quantity: '500 г',
        imageUrl: `https://example.com/test-only-${index}.jpg`,
      };
    }),
  };
}

afterEach(() => vi.restoreAllMocks());

describe('golden SKU format and GTIN validation', () => {
  it('validates the checked-in file against its schema, including every entered GTIN', () => {
    expect(validateGoldenSkus(golden, { requireReady: false })).toEqual([]);
  });

  it.skipIf(golden.status !== 'ready')(
    'contains 20 owner-approved SKUs ready for acceptance',
    () => {
      expect(validateGoldenSkus(golden)).toEqual([]);
      expect(golden.skus).toHaveLength(20);
    },
  );

  it('accepts a complete set without performing any network requests', () => {
    const fetcher = vi
      .spyOn(globalThis, 'fetch')
      .mockRejectedValue(new Error('No network in validation'));
    expect(validateGoldenSkus(syntheticSet())).toEqual([]);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each(['96385074', '012345678905', '3017620422003', '03017620422003'])(
    'accepts valid GTIN lengths and preserves initial zeros (%s)',
    (ean) => {
      const input = syntheticSet();
      input.skus[0].ean = ean;
      expect(validateGoldenSkus(input)).toEqual([]);
      expect(input.skus[0].ean).toBe(ean);
    },
  );

  it.each([
    '3017620422004',
    '301762042200',
    '30176204220031',
    '1234567',
    '123456789',
    '00000000',
    '3017 620422003',
    '3.017620422003e12',
    '３０１７６２０４２２００３',
  ])('rejects an invalid GTIN (%s)', (ean) => {
    const input = syntheticSet();
    input.skus[0].ean = ean;
    expect(validateGoldenSkus(input).join('\n')).toContain('/skus/0/ean');
  });

  it('rejects numeric EANs and missing required fields instead of coercing them', () => {
    const input = syntheticSet();
    const invalid: unknown = {
      ...input,
      skus: [{ ...input.skus[0], ean: 3017620422003 }, ...input.skus.slice(1)],
    };
    expect(validateGoldenSkus(invalid).join('\n')).toContain('/skus/0/ean');
    const { nameRo: _missing, ...row } = input.skus[0];
    expect(
      validateGoldenSkus({ ...input, skus: [row, ...input.skus.slice(1)] }).join('\n'),
    ).toContain('nameRo');
  });

  it('rejects normalized GTIN duplicates even when the rows and barcode lengths differ', () => {
    const input = syntheticSet();
    input.skus[0].ean = '3017620422003';
    input.skus[1].ean = '03017620422003';
    expect(validateGoldenSkus(input).join('\n')).toContain(
      '/skus/1/ean: дублирует GTIN из /skus/0/ean',
    );
  });

  it.each([0, 19, 21])('requires exactly 20 rows for a ready set (%i)', (count) => {
    const input = syntheticSet();
    input.skus = count > 20 ? [...input.skus, { ...input.skus[0] }] : input.skus.slice(0, count);
    expect(validateGoldenSkus(input).length).toBeGreaterThan(0);
  });

  it('does not mistake a valid draft for an accepted dataset', () => {
    const input = { ...syntheticSet(), status: 'pending-owner-input', skus: [] };
    expect(validateGoldenSkus(input, { requireReady: false })).toEqual([]);
    expect(validateGoldenSkus(input).join('\n')).toContain('0/20');
  });

  it.each(['', ' ', ' name ', 'name\nline'])(
    'rejects empty, padded and multiline text (%s)',
    (value) => {
      const input = syntheticSet();
      input.skus[0].nameRu = value;
      expect(validateGoldenSkus(input).join('\n')).toContain('/skus/0/nameRu');
    },
  );

  it.each([
    'not-a-url',
    'http://example.com/photo.jpg',
    'https://localhost/photo.jpg',
    'https://127.0.0.1/photo.jpg',
    'https://user:password@example.com/photo.jpg',
    'javascript:alert(1)',
  ])('rejects unusable reference image URLs (%s)', (imageUrl) => {
    const input = syntheticSet();
    input.skus[0].imageUrl = imageUrl;
    expect(validateGoldenSkus(input).join('\n')).toContain('/skus/0/imageUrl');
  });

  it('rejects unknown fields and unsupported file versions', () => {
    const input = syntheticSet();
    expect(validateGoldenSkus({ ...input, extra: true }).length).toBeGreaterThan(0);
    expect(validateGoldenSkus({ ...input, version: 2 }).length).toBeGreaterThan(0);
    expect(
      validateGoldenSkus({
        ...input,
        skus: [{ ...input.skus[0], typo: 'photo' }, ...input.skus.slice(1)],
      }).length,
    ).toBeGreaterThan(0);
  });

  it('validates files through the CLI and distinguishes draft and ready exit codes', () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const dir = mkdtempSync(join(tmpdir(), 'shelf-golden-'));
    const path = join(dir, 'set.json');
    try {
      writeFileSync(path, JSON.stringify(syntheticSet()));
      expect(runGoldenValidation([path])).toBe(0);
      writeFileSync(
        path,
        JSON.stringify({ ...syntheticSet(), status: 'pending-owner-input', skus: [] }),
      );
      expect(runGoldenValidation([path])).toBe(1);
      expect(runGoldenValidation(['--draft', path])).toBe(0);
      writeFileSync(path, '{broken');
      expect(runGoldenValidation([path])).toBe(1);
      expect(runGoldenValidation([join(dir, 'missing.json')])).toBe(1);
      expect(runGoldenValidation(['--unknown'])).toBe(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
