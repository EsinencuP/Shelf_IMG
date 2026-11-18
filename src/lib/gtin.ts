export function gtinDigits(value: string): string {
  return value.replace(/[\s-]/g, '');
}

export function eanIssue(value: string): string | undefined {
  if (!value) return undefined;
  const digits = gtinDigits(value);
  if (!/^\d+$/.test(digits))
    return 'EAN должен содержать только цифры. Значение сохранено без исправлений.';
  if (value.length > 32 || ![8, 12, 13, 14].includes(digits.length))
    return 'Допустимая длина GTIN: 8, 12, 13 или 14 цифр. Значение сохранено без исправлений.';
  let sum = 0;
  for (let i = digits.length - 2, weight = 3; i >= 0; i--, weight = 4 - weight)
    sum += Number(digits[i]) * weight;
  if ((10 - (sum % 10)) % 10 !== Number(digits.at(-1)))
    return 'Неверная контрольная цифра EAN. Значение сохранено без исправлений; проверьте исходную таблицу.';
}

export function normalizeGtin(value: string): string | null {
  return value && !eanIssue(value) ? gtinDigits(value).padStart(14, '0') : null;
}
