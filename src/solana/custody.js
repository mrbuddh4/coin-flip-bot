const { randomUUID } = require('node:crypto');
const { publicKey } = require('./chain');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS "SolHolderCustody" (
  id integer PRIMARY KEY CHECK(id=1), wallet text NOT NULL
);
CREATE TABLE IF NOT EXISTS "SolHolderReserves" (
  mint text PRIMARY KEY, wallet text NOT NULL, token jsonb NOT NULL,
  amount numeric(78,0) NOT NULL CHECK(amount>=0)
);`;

function holderWallet(env = process.env) {
  const wallet = env.SOLANA_HOLDER_WALLET_ADDRESS;
  if (!wallet) return null;
  publicKey(wallet);
  if (wallet === env.SOLANA_WALLET_ADDRESS) throw new Error('Holder rewards wallet must differ from the game treasury');
  if ((env.SOLANA_HOLDER_REWARDS || 'deferred') !== 'deferred') throw new Error('Separate holder custody currently requires deferred distributions');
  return wallet;
}

async function bindHolderWallet(pool, wallet) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock($1)', [42424245]);
    const current = (await client.query('SELECT wallet FROM "SolHolderCustody" WHERE id=1 FOR UPDATE')).rows[0];
    if (current && current.wallet !== wallet) throw new Error('HOLDER_CUSTODY: Keep the recorded SOLANA_HOLDER_WALLET_ADDRESS; removing or changing it requires reconciliation.');
    if (!current && wallet) await client.query('INSERT INTO "SolHolderCustody" (id,wallet) VALUES (1,$1)', [wallet]);
    await client.query('COMMIT');
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
}

async function enqueueReserve(client, { id, gameId, token, amount, sourceWallet, recipient }) {
  if (recipient === sourceWallet) throw new Error('Holder wallet must differ from treasury');
  if (BigInt(amount) <= 0n || BigInt(amount) > 18446744073709551615n) throw new Error('Invalid holder reserve transfer amount');
  await client.query('INSERT INTO "SolOutbox" (id,"gameId",payment) VALUES ($1,$2,$3)', [id, gameId, JSON.stringify({ id, gameId, kind: 'holder-reserve', mint: token.address, token, amount: amount.toString(), sourceWallet, recipient })]);
}

// Move only unallocated treasury pools. Existing allocated holder payments
// remain obligations of their original wallet. One u64 chunk per asset per
// pass bounds migration work, even when an aggregate pool exceeds one transfer.
async function queueRetainedPools(pool, treasury) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock($1)', [42424245]);
    const custody = (await client.query('SELECT wallet FROM "SolHolderCustody" WHERE id=1 FOR SHARE')).rows[0];
    if (custody) {
      const pools = (await client.query('SELECT * FROM "SolFeePools" WHERE amount>0 ORDER BY mint LIMIT 10 FOR UPDATE')).rows;
      for (const p of pools) {
        if (p.sourceWallet !== treasury) throw new Error('Retained holder pool belongs to another treasury');
        const maximum = 18446744073709551615n;
        const amount = BigInt(p.amount) > maximum ? maximum : BigInt(p.amount);
        await enqueueReserve(client, { id: `holder-reserve:retained:${randomUUID()}`, gameId: p.anchorGameId, token: p.token, amount, sourceWallet: treasury, recipient: custody.wallet });
        await client.query('UPDATE "SolFeePools" SET amount=amount-$2 WHERE mint=$1', [p.mint, amount.toString()]);
      }
    }
    await client.query('COMMIT');
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
}

// Called in the SAME transaction that first marks a reserve transfer confirmed.
// The outbox obligation leaves the treasury only when the vault record gains it.
async function confirmReserve(client, payment) {
  if (payment.kind !== 'holder-reserve') return;
  const custody = (await client.query('SELECT wallet FROM "SolHolderCustody" WHERE id=1')).rows[0];
  if (!custody || custody.wallet !== payment.recipient || payment.sourceWallet === custody.wallet || payment.token?.address !== payment.mint) throw new Error('Holder reserve custody mismatch');
  const result = await client.query(`INSERT INTO "SolHolderReserves" (mint,wallet,token,amount) VALUES ($1,$2,$3,$4)
    ON CONFLICT (mint) DO UPDATE SET amount="SolHolderReserves".amount+EXCLUDED.amount
    WHERE "SolHolderReserves".wallet=EXCLUDED.wallet AND "SolHolderReserves".token->>'decimals'=EXCLUDED.token->>'decimals'
    AND COALESCE("SolHolderReserves".token->>'program','')=COALESCE(EXCLUDED.token->>'program','') RETURNING mint`,
  [payment.mint, payment.recipient, JSON.stringify(payment.token), payment.amount]);
  if (result.rowCount !== 1) throw new Error('Holder reserve asset or wallet conflict');
}

async function custodyState(pool) {
  // One snapshot keeps a confirmed transfer from appearing in both locations.
  const { rows } = await pool.query(`SELECT wallet,
    COALESCE((SELECT jsonb_agg(jsonb_build_object('mint',r.mint,'wallet',r.wallet,'token',r.token,'amount',r.amount::text) ORDER BY r.mint) FROM "SolHolderReserves" r), '[]'::jsonb) AS reserves,
    COALESCE((SELECT jsonb_agg(t) FROM (SELECT id,payment,status,signed->>'signature' AS signature FROM "SolOutbox" WHERE payment->>'kind'='holder-reserve' ORDER BY "createdAt" DESC,id LIMIT 8) t), '[]'::jsonb) AS transfers
    FROM "SolHolderCustody" WHERE id=1`);
  return rows[0] || null;
}

module.exports = { SCHEMA, holderWallet, bindHolderWallet, enqueueReserve, queueRetainedPools, confirmReserve, custodyState };
