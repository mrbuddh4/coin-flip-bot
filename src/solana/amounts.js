// All monetary arithmetic is integer based; JSON/SQL boundaries use decimal strings.
function toUnits(text, decimals) {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 18) throw new Error('Unsupported decimals');
  if (typeof text === 'string' && /^\.\d+$/.test(text)) text = '0' + text;
  if (typeof text !== 'string' || !/^\d+(\.\d+)?$/.test(text)) throw new Error('Use a positive decimal amount, without exponent notation');
  const [whole, fraction = ''] = text.split('.');
  if (fraction.length > decimals) throw new Error('Too many decimal places');
  const value = BigInt(whole) * 10n ** BigInt(decimals) + BigInt(fraction.padEnd(decimals, '0') || '0');
  if (value <= 0n || value > 18446744073709551615n) throw new Error('Amount outside token range');
  return value;
}
function fromUnits(value, decimals) {
  const raw = BigInt(value).toString().padStart(decimals + 1, '0');
  if (!decimals) return raw;
  return `${raw.slice(0, -decimals)}.${raw.slice(-decimals)}`.replace(/\.?0+$/, '');
}
function splitPool(wager) {
  const total = BigInt(wager) * 2n;
  const holderFee = total * 5n / 100n;
  const burnFee = total * 5n / 100n;
  return { prize: total - holderFee - burnFee, holderFee, burnFee };
}
module.exports = { toUnits, fromUnits, splitPool };
