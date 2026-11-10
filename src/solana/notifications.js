const { fromUnits } = require('./amounts');
const SCHEMA = `CREATE TABLE IF NOT EXISTS "SolNotificationDeliveries" (
  "eventId" text NOT NULL, "chatId" text NOT NULL,
  "deliveredAt" timestamptz, "messageId" bigint,
  attempts integer NOT NULL DEFAULT 0, "retryAt" timestamptz,
  PRIMARY KEY ("eventId", "chatId")
);`;
const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
function explorer(signature, cluster) {
  return `https://explorer.solana.com/tx/${encodeURIComponent(signature)}${cluster === 'mainnet-beta' ? '' : '?cluster=devnet'}`;
}
function amountText(amount, mint, game, token) {
  const asset = mint === game.token.address ? game.token : token;
  if (asset?.address === mint && Number.isInteger(asset.decimals)) return `${fromUnits(amount, asset.decimals)} ${asset.symbol || mint}`;
  return `${amount} atomic units`;
}
function noticeText(row) {
  const game = row.game, event = row.event;
  const native = event.mint === 'NATIVE';
  const amount = amountText(event.amount, event.mint, game, event.token);
  let text = `<b>${escape(event.kind === 'deposit' ? 'Deposit finalized' : ({ prize: 'Winner payout', refund: 'Refund', burn: 'Burn allocation', 'holder-reserve': 'Holder reserve transfer', holder: 'Holder distribution' }[event.kind] || 'Payment'))}</b>\nGame: <code>${escape(game.id)}</code>\n${game.cluster === 'mainnet-beta' ? 'Solana mainnet' : 'Solana devnet (test coins)'}\nAmount: <b>${escape(amount)}</b>\nMint: <code>${escape(event.mint)}</code>\n`;
  if (event.userId) {
    const member = [game.creator, game.challenger].find(p => p?.userId === event.userId);
    text += `Player: ${escape(member?.name || event.userId)}\n`;
  }
  text += `From: <code>${escape(event.sourceWallet)}</code>\n`;
  if (event.kind === 'burn') {
    // Native SOL is sent to the incinerator; SPL uses an actual burn instruction.
    text += native ? 'To: <code>1nc1nerator11111111111111111111111111111111</code>\nNative SOL incinerator transfer.\n' : 'SPL burn instruction, reducing token supply when finalized.\n';
  } else text += `To: <code>${escape(event.recipient)}</code>\n`;
  const statuses = {
    PENDING: 'Queued. No finalized payment yet.', SIGNED: 'Signed, awaiting finalized on-chain confirmation. This is not payment confirmation.',
    REVIEW: 'Needs reconciliation. Finalized success is not established; no replacement transaction will be sent automatically.',
    CONFIRMED: 'Finalized on-chain.',
  };
  text += `Status: ${escape(statuses[event.status] || event.status)}\n`;
  if (event.signature) text += `<a href="${escape(explorer(event.signature, game.cluster))}">View transaction</a>\n`;
  if (event.kind === 'deposit') text += event.refund ? 'Received and recorded for a full refund. Refund confirmation is reported separately.' : 'Wager deposit recorded.';
  if (event.kind === 'holder-reserve') text += 'Custody transfer to the separate holder wallet. Distributions to individual holders remain deferred.';
  if (event.kind === 'prize' && game.fees) text += `Pool allocation: winner ${escape(amountText(game.prize, game.token.address, game))}; burn ${escape(amountText(game.fees.burn, game.token.address, game))}; holders ${escape(amountText(game.fees.holder, game.token.address, game))}. Each transfer has its own confirmation.`;
  return text;
}
// Current ledger facts drive notifications, independently of terminal group
// cards. Persist per-event/per-destination receipts only after Telegram accepts
// delivery. Restart and deposit replays do not resend acknowledged notices.
// Telegram cannot provide exactly-once sends across a lost network response;
// in that narrow case retry may duplicate a notice, never a financial payment.
class PaymentNotifications {
  constructor(store, telegram) { this.store = store; this.telegram = telegram; this.running = false; }
  async pending() {
    return (await this.store.pool.query(`WITH events AS (
      SELECT 'deposit:'||d.signature AS id, d."createdAt" AS time, g.state AS game,
        jsonb_build_object('kind','deposit','status','CONFIRMED','signature',d.signature,'amount',d.amount::text,
          'mint',COALESCE(r.payment->>'mint',g.state->'token'->>'address'),'userId',d."userId",
          'sourceWallet',CASE WHEN d."userId"=g.state->'creator'->>'userId' THEN g.state->'creator'->>'wallet' ELSE g.state->'challenger'->>'wallet' END,
          'recipient',g.state->>'depositAddress','refund',r.id IS NOT NULL) AS event
      FROM "SolDeposits" d JOIN "SolGames" g ON g.id=d."gameId"
      LEFT JOIN "SolOutbox" r ON r.id='refund:'||d.signature
      UNION ALL
      SELECT 'payment:'||p.id||':'||p.status, p."createdAt",g.state,
        p.payment || jsonb_build_object('status',p.status,'signature',p.signed->>'signature')
      FROM "SolOutbox" p JOIN "SolGames" g ON g.id=p."gameId"
      WHERE NOT (g.state ? 'interfaceVersion' AND g.state->>'status'='SETTLED')
        OR COALESCE(g.state->'ui'->>'resultAnnounced','false')='true'
        OR COALESCE(g.state->'ui'->>'terminal','false')='true' 
    ) SELECT e.id,e.game,e.event,t.chat AS "chatId"
      FROM events e CROSS JOIN LATERAL (
        SELECT DISTINCT chat FROM (VALUES (e.game->>'chatId'),(e.game->'creator'->>'userId'),(e.game->'challenger'->>'userId')) ids(chat) WHERE chat IS NOT NULL
      ) t LEFT JOIN "SolNotificationDeliveries" n ON n."eventId"=e.id AND n."chatId"=t.chat
      WHERE n."deliveredAt" IS NULL AND (n."retryAt" IS NULL OR n."retryAt"<=now())
      ORDER BY e.time,e.id,t.chat LIMIT 30`)).rows;
  }
  async tick() {
    if (this.running) return;
    this.running = true;
    try {
      const chats = new Set();
      for (const row of await this.pending()) {
        if (chats.has(row.chatId)) continue;
        chats.add(row.chatId);
        try {
          const message = await this.telegram.sendMessage(row.chatId, noticeText(row), { parse_mode: 'HTML', link_preview_options: { is_disabled: true } });
          await this.store.pool.query(`INSERT INTO "SolNotificationDeliveries" ("eventId","chatId","deliveredAt","messageId",attempts) VALUES ($1,$2,now(),$3,1)
            ON CONFLICT ("eventId","chatId") DO UPDATE SET "deliveredAt"=now(),"messageId"=EXCLUDED."messageId",attempts="SolNotificationDeliveries".attempts+1,"retryAt"=NULL`, [row.id, row.chatId, message.message_id]);
        } catch (error) {
          const retry = Number(error.response?.parameters?.retry_after);
          // Honor Telegram rate limits; don't let one blocked DM prevent group
          // delivery or another player's confirmation. Never log raw errors.
          const minimum = Number.isFinite(retry) && retry > 0 ? Math.min(retry, 86400) : 30;
          await this.store.pool.query(`INSERT INTO "SolNotificationDeliveries" ("eventId","chatId",attempts,"retryAt") VALUES ($1,$2,1,now()+$3*interval '1 second')
            ON CONFLICT ("eventId","chatId") DO UPDATE SET attempts="SolNotificationDeliveries".attempts+1,"retryAt"=now()+GREATEST($3,LEAST(3600,30*power(2,LEAST("SolNotificationDeliveries".attempts,7))))*interval '1 second'
            WHERE "SolNotificationDeliveries"."deliveredAt" IS NULL`, [row.id, row.chatId, minimum]);
          if (retry > 0) break;
        }
      }
    } finally { this.running = false; }
  }
}
module.exports = { PaymentNotifications, SCHEMA, noticeText, amountText };
