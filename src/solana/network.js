const NETWORKS = Object.freeze({
  devnet: Object.freeze({ genesis: 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG', label: 'Solana devnet', realFunds: false }),
  'mainnet-beta': Object.freeze({ genesis: '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d', label: 'Solana mainnet', realFunds: true }),
});
function network(env = process.env) {
  const result = NETWORKS[env.SOLANA_CLUSTER];
  if (!result) throw new Error('SOLANA_CLUSTER must be devnet or mainnet-beta');
  return result;
}
module.exports = { NETWORKS, network };
