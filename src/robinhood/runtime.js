const { ethers } = require('ethers');
const { RobinhoodChain, holderWallet, SID } = require('./chain');
const { RobinhoodStore, createPool, initialize, SCHEMA } = require('./store');
const { SolanaService } = require('../solana/service');
const { SolanaFees } = require('../solana/fees');
const { RobinhoodScanner } = require('./scanner');
async function setupRobinhood(root, env = process.env) {
  for (const name of ['ROBINHOOD_RPC_URL', 'ROBINHOOD_WALLET_ADDRESS', 'ROBINHOOD_PRIVATE_KEY']) if (!env[name]) throw new Error(`Set ${name} privately before enabling multi-chain mode`);
  if (env.SOLANA_HOLDER_REWARDS && env.SOLANA_HOLDER_REWARDS !== 'deferred') throw new Error('Multi-chain mode requires deferred holder distributions');
  const schema = (await root.pool.query('SELECT current_schema() AS schema')).rows[0]?.schema;
  if (schema !== 'public') throw new Error('Multi-chain runtime requires the existing Solana ledger in public schema');
  const chain = new RobinhoodChain({ env });
  let store;
  try {
    const identity = await chain.validate();
    const vault = holderWallet(env);
    await chain.tokenInfo(SID);
    await chain.balance('NATIVE'); // Require state access at the selected confirmation depth before accepting wagers.
    await initialize(root.pool);
    store = new RobinhoodStore(createPool(env.DATABASE_URL));
    await store.verifySchema(); await store.prepareInterface();
    await store.bindNetwork(identity, chain.address); await store.bindHolderWallet(vault);
    chain.nextNonce = async () => {
      const used = (await store.pool.query(`SELECT MAX((signed->>'nonce')::bigint)::text AS nonce FROM "SolOutbox" WHERE signed IS NOT NULL`)).rows[0]?.nonce;
      const pending = BigInt(await chain.rpc('eth_getTransactionCount', [chain.address, 'pending']));
      const candidate = used == null ? pending : (BigInt(used) + 1n > pending ? BigInt(used) + 1n : pending);
      if (candidate > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('Nonce out of range');
      return Number(candidate);
    };
    chain.signedGas = async () => BigInt((await store.pool.query(`SELECT COALESCE(SUM((signed->>'gasCost')::numeric),0)::text AS amount FROM "SolOutbox" WHERE signed IS NOT NULL AND status<>'CONFIRMED'`)).rows[0].amount);
    chain.liabilities = () => store.liabilities();
    chain.assertHealthy = () => store.assertHealthy();
    chain.recordProof = (signature, block) => store.recordProof(signature, block);
    chain.checkHistory = async () => {
      await store.assertHealthy();
      const proofs = (await store.pool.query('SELECT signature,block::text,hash FROM "RhProofs" WHERE NOT finalized ORDER BY block')).rows;
      if (!proofs.length) return;
      const final = await chain.rpc('eth_getBlockByNumber', ['finalized', false]);
      if (!final?.number) throw new Error('Ethereum finality head unavailable');
      // Pin every previously accepted block until Ethereum finality. A reorg
      // pauses new signatures; it never fabricates replacement payouts.
      for (const proof of proofs) {
        const block = await chain.rpc('eth_getBlockByNumber', [ethers.toQuantity(BigInt(proof.block)), false]);
        if (!block) throw new Error('Previously confirmed history temporarily unavailable');
        if (block.hash !== proof.hash) { await store.freeze('Previously confirmed block changed'); throw new Error('ROBINHOOD_HISTORY_REVIEW'); }
        if (BigInt(proof.block) <= BigInt(final.number)) await store.pool.query('UPDATE "RhProofs" SET finalized=true WHERE signature=$1 AND hash=$2', [proof.signature, proof.hash]);
      }
    };
    store.peerSchema = 'public'; root.peerSchema = SCHEMA;
    const service = new SolanaService({ store, chain });
    service.feeService = new SolanaFees({ store, chain, mode: 'deferred' });
    const scanner = new RobinhoodScanner(service);
    await scanner.start();
    return { chain, store, service, scanner };
  } catch (e) { if (store) await store.pool.end(); chain.provider.destroy?.(); throw e; }
}
module.exports = { setupRobinhood };
