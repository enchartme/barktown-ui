/**
 * Format display numbers consistently across server and browser locales.
 * Group thousands with a nonbreaking space and retain a decimal point.
 * Pass fractionDigits to preserve an existing fixed decimal precision.
 */
export function formatNumber(value, fractionDigits) {
  const text = fractionDigits === undefined ? String(value) : value.toFixed(fractionDigits);
  const [integer, fraction] = text.split('.');
  if (!/^-?\d+$/.test(integer)) return text;
  const grouped = integer.replace(/\B(?=(\d{3})+(?!\d))/g, '\u00a0');
  return fraction === undefined ? grouped : `${grouped}.${fraction}`;
}
