const { randomBytes } = require('node:crypto');
const { ethers } = require('ethers');
const { publicKey } = require('./chain');
const FLIP = '0x2aA5968F710080ea453e7e09E59d769E8C470fac';
const EXCHANGE = '0xA0Cd0F92f12f881aeBaFF9e0fb3144511c9ebF6c';
const ABI = new ethers.Interface(['function totalSupply() view returns (uint256)', 'function balanceOf(address) view returns (uint256)']);
function holderRewardsMode(env = process.env) {
  const mode = env.SOLANA_HOLDER_REWARDS || 'deferred';
  if (!['deferred', 'paxeer'].includes(mode)) throw new Error('SOLANA_HOLDER_REWARDS must be deferred or paxeer');
  return mode;
}
const SCHEMA = `
CREATE TABLE IF NOT EXISTS "SolFeeAccruals" (
  "gameId" text PRIMARY KEY REFERENCES "SolGames"(id), mint text NOT NULL,
  holder numeric(40,0) NOT NULL CHECK(holder>=0), burn numeric(40,0) NOT NULL CHECK(burn>=0)
);
CREATE TABLE IF NOT EXISTS "SolFeePools" (
  mint text PRIMARY KEY, token jsonb NOT NULL, amount numeric(78,0) NOT NULL CHECK(amount>=0),
  "sourceWallet" text NOT NULL, "anchorGameId" text NOT NULL REFERENCES "SolGames"(id)
);
CREATE TABLE IF NOT EXISTS "SolHolderLinks" (
  "userId" text PRIMARY KEY, evm text UNIQUE NOT NULL, recipient text NOT NULL,
  proof jsonb NOT NULL, "verifiedAt" timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS "SolHolderChallenges" (
  id text PRIMARY KEY, "userId" text NOT NULL UNIQUE, evm text NOT NULL,
  recipient text NOT NULL, message text NOT NULL, "expiresAt" timestamptz NOT NULL
);
CREATE TABLE IF NOT EXISTS "SolFeeCycles" (
  day text NOT NULL, mint text NOT NULL, snapshot jsonb NOT NULL,
  available numeric(78,0) NOT NULL, allocated numeric(78,0) NOT NULL,
  "createdAt" timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(day,mint)
);`;
async function accrueFees(client, game, split) {
  const inserted = await client.query('INSERT INTO "SolFeeAccruals" ("gameId",mint,holder,burn) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING RETURNING "gameId"', [game.id, game.token.address, split.holderFee.toString(), split.burnFee.toString()]);
  if (!inserted.rowCount) return;
  if (split.holderFee > 0n) {
    const result = await client.query(`INSERT INTO "SolFeePools" (mint,token,amount,"sourceWallet","anchorGameId") VALUES ($1,$2,$3,$4,$5)
      ON CONFLICT (mint) DO UPDATE SET amount="SolFeePools".amount+EXCLUDED.amount
      WHERE "SolFeePools"."sourceWallet"=EXCLUDED."sourceWallet" AND "SolFeePools".token->>'decimals'=EXCLUDED.token->>'decimals'
      AND COALESCE("SolFeePools".token->>'program','')=COALESCE(EXCLUDED.token->>'program','') RETURNING mint`,
    [game.token.address, JSON.stringify(game.token), split.holderFee.toString(), game.depositAddress, game.id]);
    if (result.rowCount !== 1) throw new Error('Fee pool asset or wallet conflict; reconcile before settlement');
  }
  if (split.burnFee > 0n) await client.query('INSERT INTO "SolOutbox" (id,"gameId",payment) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING', [
    `burn:${game.id}`, game.id, JSON.stringify({ id: `burn:${game.id}`, gameId: game.id, mint: game.token.address, amount: split.burnFee.toString(), kind: 'burn', sourceWallet: game.depositAddress }),
  ]);
}
function exclusions(env = process.env) {
  return [...new Set([
    ethers.ZeroAddress, '0x000000000000000000000000000000000000dEaD', FLIP, env.SIDIORA_EXCHANGE_ADDRESS || EXCHANGE,
    env.EVM_BOT_WALLET_ADDRESS, env.EVM_DEV_WALLET, ...(env.FLIP_EXCLUDED_ADDRESSES || '').split(','),
  ].filter(x => x?.trim()).map(x => ethers.getAddress(x.trim().toLowerCase()).toLowerCase()))];
}
// Read-only JSON RPC. No EVM private key is loaded by the Solana fee worker.
class FlipSnapshotSource {
  constructor(env = process.env, fetcher = fetch) { this.env = env; this.fetcher = fetcher; }
  async rpc(method, params) {
    const url = this.env.FLIP_HOLDER_RPC_URL;
    if (!url || !/^https:\/\//.test(url)) throw new Error('FLIP_HOLDER_RPC_URL: set a working HTTPS Paxeer RPC privately');
    const response = await this.fetcher(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(15000) });
    if (!response.ok) throw new Error('FLIP holder RPC request failed');
    const json = await response.json();
    if (json.error || json.result === undefined || json.result === null) throw new Error('FLIP holder RPC result unavailable');
    return json.result;
  }
  async snapshot(links) {
    const deadline = Date.now() + 60000;
    const rpc = (method, params) => {
      if (Date.now() >= deadline) throw new Error('Holder snapshot deadline exceeded; retry without allocation');
      return this.rpc(method, params);
    };
    if (BigInt(await rpc('eth_chainId', [])) !== 125n) throw new Error('FLIP holder RPC must use Paxeer chain 125');
    // Read the contract and every balance against one finalized canonical block.
    // Unsupported finality is a failure, never a fallback to a mutable latest block.
    const block = await rpc('eth_getBlockByNumber', ['finalized', false]);
    if (!/^0x[0-9a-f]+$/i.test(block.number || '') || !/^0x[0-9a-f]{64}$/i.test(block.hash || '')) throw new Error('Finalized FLIP block unavailable');
    const reference = { blockHash: block.hash, requireCanonical: true };
    if (!/^0x[0-9a-f]{2,}$/i.test(await rpc('eth_getCode', [FLIP, reference]))) throw new Error('FLIP contract unavailable on configured network');
    const call = async (name, args = []) => {
      const raw = await rpc('eth_call', [{ to: FLIP, data: ABI.encodeFunctionData(name, args) }, reference]);
      return ABI.decodeFunctionResult(name, raw)[0];
    };
    const excluded = exclusions(this.env);
    const total = await call('totalSupply');
    let removed = 0n;
    for (const address of excluded) removed += await call('balanceOf', [address]);
    if (removed >= total) throw new Error('Effective FLIP supply is unavailable or zero');
    const supply = total - removed, balances = {};
    let sum = 0n;
    for (const link of links) {
      const address = link.evm.toLowerCase();
      if (Object.hasOwn(balances, address)) throw new Error('Duplicate holder address');
      const balance = excluded.includes(address) ? 0n : await call('balanceOf', [address]);
      balances[address] = balance.toString(); sum += balance;
    }
    if (sum > supply) throw new Error('Holder balances exceed effective supply');
    return { chainId: 125, contract: FLIP.toLowerCase(), block: block.number, blockHash: block.hash, total: total.toString(), excluded, excludedBalance: removed.toString(), supply: supply.toString(), balances };
  }
}
class SolanaFees {
  constructor({ store, chain, source, mode = 'deferred', now = () => Date.now() }) {
    holderRewardsMode({ SOLANA_HOLDER_REWARDS: mode });
    Object.assign(this, { store, chain, mode, now });
    this.source = mode === 'paxeer' ? source || new FlipSnapshotSource() : null;
    this.lastError = null; this.lastSuccess = null; this.nextTry = 0;
  }
  async prepare() { await this.store.pool.query(SCHEMA); }
  async backfill() {
    // Only the explicitly retained fee format from earlier devnet review builds.
    // Per-game accrual uniqueness prevents both pool and burn duplication.
    for (const g of await this.store.allResults()) if (g.fees?.status === 'RETAINED_NOT_DISTRIBUTED') {
      if (g.depositAddress !== this.chain.address || g.cluster !== this.chain.env.SOLANA_CLUSTER) throw new Error('Retained fees belong to another network/wallet');
      await this.store.mutate(g.id, async (game, tx) => {
        if (game.fees.status !== 'RETAINED_NOT_DISTRIBUTED') return;
        await tx.accrueFees(game, { holderFee: BigInt(game.fees.holder), burnFee: BigInt(game.fees.burn) });
        game.fees.status = 'ACCRUED';
      });
    }
  }
  async challenge(userId, evm, recipient) {
    if (this.mode !== 'paxeer') throw new Error('Holder rewards are deferred; allocations remain reserved');
    evm = ethers.getAddress(evm.toLowerCase()).toLowerCase();
    if (exclusions(this.source.env).includes(evm)) throw new Error('This address is excluded from rewards');
    publicKey(recipient);
    if (recipient === this.chain.address) throw new Error('Use a personal receiving wallet');
    const id = randomBytes(16).toString('hex'), expiry = this.now() + 10 * 60 * 1000;
    const message = `Coin Flip: link FLIP holder rewards\nTelegram user: ${String(userId)}\nPaxeer chain: 125\nFLIP contract: ${FLIP.toLowerCase()}\nHolding wallet: ${evm}\nSolana network: ${this.chain.env.SOLANA_CLUSTER}\nBot treasury: ${this.chain.address}\nSolana reward recipient: ${recipient}\nNonce: ${id}\nExpires: ${new Date(expiry).toISOString()}\nThis signature only registers rewards. It authorizes no transfer or token approval.`;
    await this.store.pool.query('INSERT INTO "SolHolderChallenges" (id,"userId",evm,recipient,message,"expiresAt") VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT ("userId") DO UPDATE SET id=EXCLUDED.id,evm=EXCLUDED.evm,recipient=EXCLUDED.recipient,message=EXCLUDED.message,"expiresAt"=EXCLUDED."expiresAt"', [id, String(userId), evm, recipient, message, new Date(expiry)]);
    return { id, message };
  }
  async getChallenge(id) {
    if (this.mode !== 'paxeer') return null;
    return (await this.store.pool.query('SELECT * FROM "SolHolderChallenges" WHERE id=$1 AND "expiresAt">$2', [id, new Date(this.now())])).rows[0];
  }
  async verify(id, signature) {
    if (this.mode !== 'paxeer') throw new Error('Holder rewards are deferred; no registration is active');
    const client = await this.store.pool.connect();
    try {
      await client.query('BEGIN');
      // Serialize holder changes with daily snapshots, including destination updates.
      await client.query('SELECT pg_advisory_xact_lock($1)', [42424245]);
      const c = (await client.query('SELECT * FROM "SolHolderChallenges" WHERE id=$1 AND "expiresAt">$2 FOR UPDATE', [id, new Date(this.now())])).rows[0];
      if (!c || !/^0x[0-9a-f]{130}$/i.test(signature) || ethers.verifyMessage(c.message, signature).toLowerCase() !== c.evm) throw new Error('Holder proof invalid or expired');
      await client.query('INSERT INTO "SolHolderLinks" ("userId",evm,recipient,proof) VALUES ($1,$2,$3,$4) ON CONFLICT ("userId") DO UPDATE SET evm=EXCLUDED.evm,recipient=EXCLUDED.recipient,proof=EXCLUDED.proof,"verifiedAt"=now()', [c.userId, c.evm, c.recipient, JSON.stringify({ message: c.message, signature })]);
      await client.query('DELETE FROM "SolHolderChallenges" WHERE id=$1', [id]);
      await client.query('COMMIT');
      return c;
    } catch (e) { await client.query('ROLLBACK'); throw e; }
    finally { client.release(); }
  }
  async link(userId) {
    if (this.mode !== 'paxeer') return null;
    return (await this.store.pool.query('SELECT evm,recipient FROM "SolHolderLinks" WHERE "userId"=$1', [String(userId)])).rows[0];
  }
  async distribute() {
    if (this.mode !== 'paxeer') return;
    const client = await this.store.pool.connect();
    try {
      await client.query('BEGIN');
      const locked = (await client.query('SELECT pg_try_advisory_xact_lock($1) AS locked', [42424245])).rows[0].locked;
      if (!locked) { await client.query('ROLLBACK'); return; }
      const day = new Date(this.now()).toISOString().slice(0, 10);
      const poolQuery = 'SELECT * FROM "SolFeePools" p WHERE amount>0 AND NOT EXISTS(SELECT 1 FROM "SolFeeCycles" c WHERE c.day=$1 AND c.mint=p.mint) ORDER BY mint';
      let pools = (await client.query(poolQuery, [day])).rows;
      if (!pools.length) { await client.query('COMMIT'); return; }
      const links = (await client.query('SELECT "userId",evm,recipient FROM "SolHolderLinks" ORDER BY evm')).rows;
      if (!links.length) { await client.query('COMMIT'); return; } // Leave the cycle open for first registration.
      const snapshot = await this.source.snapshot(links);
      // Do slow RPC reads before locking pool rows, so game settlements can
      // accrue fees while the snapshot is fetched. The allocation then locks
      // and uses the current pool balances in this same transaction.
      pools = (await client.query(poolQuery + ' FOR UPDATE', [day])).rows;
      const supply = BigInt(snapshot.supply);
      if (supply <= 0n || links.reduce((sum, l) => sum + BigInt(snapshot.balances[l.evm] ?? '-1'), 0n) > supply) throw new Error('Invalid holder snapshot');
      for (const p of pools) {
        if (p.sourceWallet !== this.chain.address) throw new Error('Fee pool signing wallet mismatch');
        const available = BigInt(p.amount);
        const minimum = p.token.decimals >= 3 ? 10n ** BigInt(p.token.decimals - 3) : 1n;
        let allocated = 0n;
        for (const l of links) {
          const balance = BigInt(snapshot.balances[l.evm] ?? '-1');
          if (balance < 0n || balance > supply) throw new Error('Invalid holder balance');
          const amount = available * balance / supply;
          if (amount < minimum) continue;
          // One transfer is u64 limited even if the aggregate pool exceeds it.
          if (amount > 18446744073709551615n) throw new Error('Holder payment exceeds transfer limit');
          const id = `holder:${day}:${p.mint}:${l.evm}`;
          const payment = { id, gameId: p.anchorGameId, kind: 'holder', mint: p.mint, recipient: l.recipient, amount: amount.toString(), sourceWallet: p.sourceWallet, userId: l.userId, holder: l.evm, cycle: day };
          // A collision rolls back the whole allocation, never silently debits twice.
          await client.query('INSERT INTO "SolOutbox" (id,"gameId",payment) VALUES ($1,$2,$3)', [id, p.anchorGameId, JSON.stringify(payment)]);
          allocated += amount;
        }
        if (allocated > available) throw new Error('Holder allocations exceed pool');
        await client.query('UPDATE "SolFeePools" SET amount=amount-$2 WHERE mint=$1', [p.mint, allocated.toString()]);
        await client.query('INSERT INTO "SolFeeCycles" (day,mint,snapshot,available,allocated) VALUES ($1,$2,$3,$4,$5)', [day, p.mint, JSON.stringify(snapshot), available.toString(), allocated.toString()]);
      }
      await client.query('COMMIT'); this.lastSuccess = this.now(); this.lastError = null;
    } catch (e) { await client.query('ROLLBACK'); throw e; }
    finally { client.release(); }
  }
  async tick() {
    if (this.mode !== 'paxeer') return;
    if (this.running || this.now() < this.nextTry) return;
    this.running = true;
    this.nextTry = this.now() + 60000;
    try { await this.distribute(); }
    catch (_) { this.lastError = 'Holder snapshot/distribution unavailable; all unallocated fees retained for retry.'; }
    finally { this.running = false; }
  }
}
module.exports = { SolanaFees, FlipSnapshotSource, accrueFees, SCHEMA, FLIP, EXCHANGE, exclusions, holderRewardsMode };
