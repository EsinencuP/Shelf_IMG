import type { Candidate } from '../types';
import { normalizeGtin, type SearchProduct } from './validation';

const normalize = (value: string) => value.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

export interface ParsedQuantity { amount: number; kind: 'mass' | 'volume' | 'count'; count: number }
export function parseQuantity(value: string): ParsedQuantity | null {
  const clean = value.toLowerCase().replace(/,/g, '.').replace(/×|х/g, 'x');
  const match = clean.match(/(?:(\d+)\s*[x*]\s*)?(\d+(?:\.\d+)?)\s*(kg|кг|ml|мл|litri|litru|litre|liter|л|l|grame|grams|gram|гр|g|г|buc(?:ati)?|pcs|шт)(?![\p{L}])(?:\s*[x*]\s*(\d+))?/u);
  if (!match) return null;
  if (match[1] && match[4] && match[1] !== match[4]) return null;
  const count = Number(match[1] || match[4] || 1);
  const amount = Number(match[2]);
  if (!count || !amount || !Number.isFinite(count * amount)) return null;
  const unit = match[3];
  const kind = /^(kg|кг|g|г|гр|grame|grams|gram)$/.test(unit) ? 'mass' : /^(buc|bucati|pcs|шт)$/.test(unit) ? 'count' : 'volume';
  const multiplier = /^(kg|кг|l|л|litri|litru|litre|liter)$/.test(unit) ? 1000 : 1;
  return { amount: amount * count * multiplier, kind, count };
}

export function matchCandidate(product: SearchProduct, candidate: Candidate): { rejected: boolean; candidate: Candidate } {
  const warnings = [...candidate.warnings];
  let rejected = false;
  const requestedGtin = product.ean ? normalizeGtin(product.ean) : null;
  const foundGtin = candidate.gtin ? normalizeGtin(candidate.gtin) : null;
  if (requestedGtin && foundGtin && requestedGtin !== foundGtin) { warnings.push('GTIN источника отличается от GTIN товара.'); rejected = true; }
  const gtinExact = !!requestedGtin && requestedGtin === foundGtin && candidate.gtinExact;
  if (!gtinExact) warnings.push('Связь изображения с точным GTIN не подтверждена.');
  if (product.brand) {
    if (candidate.brand) {
      const expected = normalize(product.brand);
      if (!candidate.brand.split(/[,;\/]/).some((brand) => normalize(brand) === expected)) { warnings.push('Бренд источника отличается от запрошенного.'); rejected = true; }
    } else warnings.push('Бренд на изображении требует проверки.');
  }
  const expectedQuantity = parseQuantity(product.quantity || `${product.nameRu} ${product.nameRo}`);
  const actualQuantity = parseQuantity(candidate.quantity || candidate.title);
  if (expectedQuantity && actualQuantity) {
    if (expectedQuantity.kind !== actualQuantity.kind || expectedQuantity.count !== actualQuantity.count || Math.abs(expectedQuantity.amount - actualQuantity.amount) > 0.001) {
      warnings.push('Объём, масса или количество упаковок отличаются.'); rejected = true;
    }
  } else if (expectedQuantity) warnings.push('Объём и количество упаковок не подтверждены.');
  warnings.push('Проверьте вкус, вариант и актуальность дизайна упаковки; источник не гарантирует текущую версию.');
  return { rejected, candidate: { ...candidate, gtinExact, warnings: [...new Set(warnings)] } };
}
