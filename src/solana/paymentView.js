const { fromUnits } = require('./amounts');
const html = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const kind = p => p.payment?.kind || p.id.split(':')[0];
function state(p) { return p.status === 'CONFIRMED' ? '✓' : p.status === 'REVIEW' ? 'needs review' : 'pending'; }
function proof(p, label, explorer) {
  const text = `${label} ${state(p)}`;
  return p.signature ? `<a href="${html(explorer(p.signature))}">${html(text)}</a>` : html(text);
}
function compactPayments(game, payments, explorer) {
  const links = [];
  for (const [type, label] of [['prize', 'Prize'], ['burn', 'Burn'], ['holder-reserve', 'Holder fee']]) {
    for (const p of payments.filter(p => kind(p) === type)) links.push(proof(p, label, explorer));
  }
  // With no separate custody wallet, the share is reserved rather than sent.
  if (game.status === 'SETTLED' && BigInt(game.fees?.holder || 0) > 0n && !payments.some(p => kind(p) === 'holder-reserve')) links.push('Holder fee: reserved');
  const refunds = payments.filter(p => kind(p) === 'refund').map(p => {
    const player = [game.creator, game.challenger].find(v => v && v.wallet === p.payment?.recipient);
    const asset = p.payment?.mint === game.token.address ? game.token : p.payment?.token;
    const amount = p.payment?.amount;
    const value = amount == null ? '' : asset?.decimals != null ? `${fromUnits(amount, asset.decimals)} ${asset.symbol}` : `${amount} atomic units`;
    const label = `Refund${player ? ' to ' + (player.name || player.userId) : ''}${value ? ': ' + value : ''}`;
    const external = p.payment?.externalRefunds || [];
    return [proof(p, label, explorer), ...external.filter(v => v.signature !== p.signature).map(v => `<a href="${html(explorer(v.signature))}">Manual return ✓</a>`)].join(' · ');
  });
  return [links.join(' · '), ...refunds].filter(Boolean).join('\n');
}
module.exports = { compactPayments, kind };
