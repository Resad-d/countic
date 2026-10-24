/** Number rendering for counter values. */

export type NumberFormat = 'compact' | 'full';

// Constructing NumberFormat is slow, so each locale is built once and reused.
const formatters = new Map<string, Intl.NumberFormat>();

function intl(locale: string): Intl.NumberFormat {
  let formatter = formatters.get(locale);
  if (!formatter) {
    formatter = new Intl.NumberFormat(locale);
    formatters.set(locale, formatter);
  }
  return formatter;
}

export function formatCount(value: number, format: NumberFormat, locale: string): string {
  const digits = String(value).length;
  if (format === 'compact' && digits > 3 && digits < 10) {
    return compact(value, locale);
  }
  return intl(locale).format(value);
}

// Compact always shows 3 significant digits, Intl output keeps the locale decimal separator.
function compact(value: number, locale: string): string {
  const rounded = Number(value.toPrecision(3));
  const millions = rounded >= 1_000_000;
  const divided = millions ? rounded / 1_000_000 : rounded / 1_000;
  return `${intl(locale).format(divided)}${millions ? 'M' : 'K'}`;
}
