const DAY = 86400000;
const HOUR = 3600000;
const RUN_HOUR_UTC = 17;
const FIRST_SLOT = Date.parse('2026-11-25T17:00:00Z');
const SCHEMA = `CREATE TABLE IF NOT EXISTS "SolDailyAudit" (
  day date NOT NULL, recipient text NOT NULL, PRIMARY KEY(day, recipient)
)`;

async function findings({ store, chain, name }) {
  const { rows } = await store.pool.query(`
    SELECT * FROM (
      SELECT 'payment' AS kind, id AS ref, status AS detail, "createdAt" AS at
      FROM "SolOutbox"
      WHERE status='REVIEW' OR (status IN ('PENDING','SIGNED') AND "createdAt" < now() - interval '1 hour')
      UNION ALL
      SELECT 'deposit', r.signature, 'uncredited', min(r."createdAt")
      FROM (
        SELECT signature, "createdAt" FROM "SolDepositReviews"
        UNION ALL
        SELECT signature, "seenAt" FROM "SolAuditReceipts"
      ) r WHERE r."createdAt" >= now() - interval '48 hours'
      AND r."createdAt" < now() - interval '30 minutes'
      AND NOT EXISTS (SELECT 1 FROM "SolDeposits" d WHERE d.signature=r.signature)
      AND NOT EXISTS (SELECT 1 FROM "SolExternalRefunds" e WHERE e."depositSignature"=r.signature)
      GROUP BY r.signature
    ) issues ORDER BY at DESC LIMIT 7
  `);
  const lines = rows.slice(0, 6).map(({ kind, ref, detail }) => {
    if (kind === 'payment') return `${name}: ${detail} payment ${ref}`;
    const link = chain.chainId ? chain.explorer(ref) : 'https://solscan.io/tx/' + ref + (chain.env?.SOLANA_CLUSTER === 'devnet' ? '?cluster=devnet' : '');
    return `${name}: deposit needs review\n${link}`;
  });
  if (rows.length > 6) lines.push(`${name}: more items need review.`);
  return lines;
}

class DailyAudit {
  constructor({ store, sources, telegram, adminIds, now = Date.now }) {
    Object.assign(this, { store, sources, telegram, now });
    this.recipients = [...new Set((adminIds || '').split(',').map(id => id.trim()).filter(id => /^[1-9]\d*$/.test(id)))];
    this.running = false;
    this.nextCheck = 0;
  }
  async tick() {
    const now = this.now();
    if (this.running || now < this.nextCheck || !this.recipients.length) return;
    const slot = Math.floor((now - RUN_HOUR_UTC * HOUR) / DAY) * DAY + RUN_HOUR_UTC * HOUR;
    if (slot < FIRST_SLOT) { this.nextCheck = FIRST_SLOT; return; }
    const day = new Date(slot).toISOString().slice(0, 10);
    this.running = true;
    this.nextCheck = now + 5 * 60000;
    try {
      const { rows } = await this.store.pool.query('SELECT recipient FROM "SolDailyAudit" WHERE day=$1', [day]);
      const done = new Set(rows.map(row => row.recipient));
      const recipients = this.recipients.filter(id => !done.has(id));
      if (recipients.length) {
        const results = await Promise.allSettled(this.sources.map(findings));
        const lines = results.flatMap((result, i) => result.status === 'fulfilled' ? result.value :
          [`${this.sources[i].name}: audit could not read the ledger.`]);
        for (const id of recipients) {
          if (lines.length) await this.telegram.sendMessage(id, 'Coin flip daily audit\n\n' + lines.join('\n\n'),
            { link_preview_options: { is_disabled: true } });
          await this.store.pool.query('INSERT INTO "SolDailyAudit" (day, recipient) VALUES ($1,$2) ON CONFLICT DO NOTHING', [day, id]);
        }
      }
      this.nextCheck = slot + DAY;
    } finally { this.running = false; }
  }
}
module.exports = { DailyAudit, SCHEMA };
