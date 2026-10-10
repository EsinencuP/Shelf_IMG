import type { SearchProduct } from './validation';
import { INDEXED_DOMAINS } from '../search-sources';

const ALIASES: [RegExp, string][] = [
  [/букурия|bucuria/gi, 'bucuria'],
  [/рошен|roshen/gi, 'roshen'],
  [/славянка|slavianka|slavyanka/gi, 'slavjanka'],
  [/махеев[ъь]?|maheev|makheev/gi, 'maheev'],
  [/савушкин|savushkin/gi, 'savushkin'],
  [/джлц|джелси|jlc/gi, 'jlc'],
  [/черноголовка|chernogolovka/gi, 'chernogolovka'],
  [/франзелуца|franzeluta/gi, 'franzeluta'],
  [/рогоб|rogob/gi, 'rogob'],
  [/макфа|makfa/gi, 'makfa'],
  [/акконд|akkond/gi, 'akkond'],
];
const CYRILLIC: Record<string, string> = {
  а: 'a',
  б: 'b',
  в: 'v',
  г: 'g',
  д: 'd',
  е: 'e',
  ё: 'e',
  ж: 'zh',
  з: 'z',
  и: 'i',
  й: 'i',
  к: 'k',
  л: 'l',
  м: 'm',
  н: 'n',
  о: 'o',
  п: 'p',
  р: 'r',
  с: 's',
  т: 't',
  у: 'u',
  ф: 'f',
  х: 'h',
  ц: 'ts',
  ч: 'ch',
  ш: 'sh',
  щ: 'shch',
  ъ: '',
  ы: 'y',
  ь: '',
  э: 'e',
  ю: 'yu',
  я: 'ya',
  і: 'i',
  ї: 'yi',
  є: 'e',
  ґ: 'g',
};

export function canonicalText(value: string): string {
  let result = value.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase();
  for (const [pattern, replacement] of ALIASES) result = result.replace(pattern, replacement);
  return result
    .replace(/[а-яієїґ]/g, (letter) => CYRILLIC[letter] ?? letter)
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

export function languageQueries(product: SearchProduct): string[] {
  const result: string[] = [];
  for (const name of [product.nameRo, product.nameRu]) {
    if (!name || /^Товар с EAN /i.test(name)) continue;
    const query = [
      product.brand && !canonicalText(name).includes(canonicalText(product.brand))
        ? product.brand
        : '',
      name,
    ]
      .filter(Boolean)
      .join(' ')
      .trim();
    if (query) result.push(query.slice(0, 200));
  }
  if (product.brand && !result.length) result.push(product.brand.slice(0, 80));
  return [...new Set(result)];
}

export function nativeQueries(product: SearchProduct): string[] {
  const names = languageQueries(product);
  const short = names.map((name) =>
    name
      .replace(/\d+(?:[.,]\d+)?\s*(?:kg|кг|ml|мл|g|гр|г|l|л)(?!\p{L})/giu, '')
      .replace(/\d+(?:[.,]\d+)?\s*%/g, '')
      .replace(/\s+/g, ' ')
      .trim(),
  );
  const queries = [...(product.ean ? [product.ean.replace(/[\s-]/g, '')] : []), ...short];
  return [...new Set(queries)].filter(Boolean).slice(0, 3);
}

/** Exact barcode first, then both descriptions and a Moldova/manufacturer discovery query. */
export function webQueries(product: SearchProduct, limit = 4): string[] {
  const names = languageQueries(product);
  const queries = [
    ...(product.ean ? [`"${product.ean.replace(/[\s-]/g, '')}"`] : []),
    ...names.map((name) =>
      [name, product.quantity && !name.includes(product.quantity) ? product.quantity : '']
        .filter(Boolean)
        .join(' '),
    ),
  ];
  if (names[0]) {
    const name = canonicalText(`${product.brand} ${names.join(' ')}`);
    const manufacturers = INDEXED_DOMAINS.filter((domain) =>
      name.includes(canonicalText(domain.split('.')[0])),
    ).slice(0, 3);
    const domains = [
      ...new Set([...manufacturers, 'linella.md', 'metro.zakaz.md', 'bonus.zakaz.md']),
    ].slice(0, 5);
    queries.push(
      `${names[0].slice(0, 150)} (${domains.map((domain) => `site:${domain}`).join(' OR ')})`,
    );
  }
  return [...new Set(queries)].map((query) => query.slice(0, 400)).slice(0, limit);
}

const CATEGORY_TERMS: Record<string, string> = {
  tvorog: 'branza',
  brinza: 'branza',
  branza: 'branza',
  moloko: 'lapte',
  lapte: 'lapte',
  smetana: 'smantana',
  smantana: 'smantana',
  maslo: 'unt',
  unt: 'unt',
  kefir: 'chefir',
  chefir: 'chefir',
  maioneza: 'maionez',
  maionez: 'maionez',
  mayo: 'maionez',
  pechene: 'biscuit',
  biscuiti: 'biscuit',
  sok: 'suc',
  suc: 'suc',
  voda: 'apa',
  apa: 'apa',
  konfety: 'bomboane',
  bomboane: 'bomboane',
  krem: 'crema',
  crema: 'crema',
  shampun: 'sampon',
  sampon: 'sampon',
};
const STOP = new Set([
  'g',
  'gr',
  'kg',
  'ml',
  'l',
  'ean',
  'tovar',
  's',
  'cu',
  'de',
  'din',
  'in',
  'na',
  'dlya',
  'produs',
  'product',
  'buc',
  'pcs',
  'sht',
  'ambalaj',
  'pahar',
  'sticla',
]);
export function titleRelevance(product: SearchProduct, title: string): number {
  const tokens = (value: string) =>
    canonicalText(value)
      .split(' ')
      .filter((token) => token.length > 1 && !/^\d+$/.test(token) && !STOP.has(token))
      .map((token) => CATEGORY_TERMS[token] || token);
  const titleTokens = new Set(tokens(title));
  const names = languageQueries(product);
  if (!names.length) return 0;
  return Math.max(
    ...names.map((name) => {
      const expected = [...new Set(tokens(name))];
      return expected.length
        ? expected.filter((token) => titleTokens.has(token)).length / expected.length
        : 0;
    }),
  );
}
