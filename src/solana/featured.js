// The mint is the identity. A token using the same ticker never inherits this label.
const SID_MINT = '5w3wVdJaESaJKyLmStM6Hv9UyUkmZ1b9DLQquAqqpump';
const FEATURED = Object.freeze([
  Object.freeze({ address: 'NATIVE', symbol: 'SOL', decimals: 9, cluster: 'any' }),
  Object.freeze({ address: SID_MINT, symbol: 'SID', name: 'Sidiora Markets', decimals: 6, cluster: 'mainnet-beta' }),
]);
function displayToken(token, cluster) {
  const featured = FEATURED.find(t => t.address === token.address && (t.cluster === 'any' || t.cluster === cluster));
  return featured ? { ...token, symbol: featured.symbol, name: featured.name } : token;
}
function tokensForUser(saved = [], cluster = 'devnet') {
  const featured = FEATURED.filter(t => t.cluster === 'any' || t.cluster === cluster);
  const featuredMints = new Set(featured.map(t => t.address));
  return [...featured.map(t => ({ ...t, featured: true })), ...saved.filter(t => !featuredMints.has(t.address)).map(t => displayToken(t, cluster))];
}
module.exports = { SID_MINT, FEATURED, displayToken, tokensForUser };
