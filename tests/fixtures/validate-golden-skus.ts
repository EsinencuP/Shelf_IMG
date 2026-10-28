import { Ajv } from 'ajv';
import schema from './golden-skus.schema.json';
import { normalizeGtin } from '../../src/lib/server/validation';
import { validatePublicUrl } from '../../src/lib/server/public-fetch';

export interface GoldenSku {
  ean: string;
  nameRu: string;
  nameRo: string;
  quantity: string;
  imageUrl: string;
  brand?: string;
}
export interface GoldenSkuFile {
  $schema: './golden-skus.schema.json';
  version: 1;
  status: 'pending-owner-input' | 'ready';
  skus: GoldenSku[];
}

const ajv = new Ajv({ allErrors: true });
ajv.addFormat('uri', (value: string) => {
  try {
    validatePublicUrl(value);
    return true;
  } catch {
    return false;
  }
});
const validateSchema = ajv.compile<GoldenSkuFile>(schema);

/** Offline structural and semantic checks; photo correctness is confirmed by the owner. */
export function validateGoldenSkus(input: unknown, { requireReady = true } = {}): string[] {
  if (!validateSchema(input)) {
    return (validateSchema.errors ?? []).map(
      (error) => `${error.instancePath || '/'}: ${error.message}`,
    );
  }
  const errors: string[] = [];
  const seen = new Map<string, number>();
  for (const [index, sku] of input.skus.entries()) {
    const gtin = normalizeGtin(sku.ean);
    if (!gtin) {
      errors.push(`/skus/${index}/ean: неверная контрольная цифра GTIN.`);
      continue;
    }
    const previous = seen.get(gtin);
    if (previous !== undefined)
      errors.push(`/skus/${index}/ean: дублирует GTIN из /skus/${previous}/ean.`);
    else seen.set(gtin, index);
  }
  if (requireReady && input.status !== 'ready')
    errors.push(
      `Набор ожидает данные владельца: ${input.skus.length}/20 SKU. Для приёмки нужны 20 подтверждённых записей и status=ready.`,
    );
  return errors;
}
