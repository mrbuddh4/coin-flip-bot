// Keep delivery history from previous versions, but never send standalone
// deposit/payment notifications. The existing result/refund cards hold proofs.
const SCHEMA = `CREATE TABLE IF NOT EXISTS "SolNotificationDeliveries" (
  "eventId" text NOT NULL, "chatId" text NOT NULL,
  "deliveredAt" timestamptz, "messageId" bigint,
  attempts integer NOT NULL DEFAULT 0, "retryAt" timestamptz,
  PRIMARY KEY ("eventId", "chatId")
);
ALTER TABLE "SolNotificationDeliveries" ADD COLUMN IF NOT EXISTS "cleanupState" text;`;
class ObsoleteNoticeCleanup {
  constructor(store, telegram) { Object.assign(this, { store, telegram }); this.running = false; }
  async tick() {
    if (this.running) return;
    this.running = true;
    try {
      const rows = (await this.store.pool.query(`SELECT "eventId","chatId","messageId" FROM "SolNotificationDeliveries"
        WHERE "messageId" IS NOT NULL AND "cleanupState" IS NULL AND ("retryAt" IS NULL OR "retryAt"<=now())
        ORDER BY "deliveredAt" LIMIT 5`)).rows;
      for (const row of rows) {
        let cleanup = 'REMOVED';
        try { await this.telegram.deleteMessage(row.chatId, Number(row.messageId)); }
        catch (error) {
          const description = error.response?.description || '';
          if (/message to delete not found/i.test(description)) cleanup = 'ALREADY_ABSENT';
          else if (/message can't be deleted|not enough rights|bot was blocked|bot is not a member/i.test(description) || error.response?.error_code === 403) cleanup = 'UNDELETABLE';
          else {
            const retry = Number(error.response?.parameters?.retry_after) || 60;
            await this.store.pool.query(`UPDATE "SolNotificationDeliveries" SET "retryAt"=now()+$3*interval '1 second' WHERE "eventId"=$1 AND "chatId"=$2`, [row.eventId, row.chatId, Math.min(Math.max(retry, 10), 86400)]);
            break;
          }
        }
        await this.store.pool.query('UPDATE "SolNotificationDeliveries" SET "cleanupState"=$3 WHERE "eventId"=$1 AND "chatId"=$2', [row.eventId, row.chatId, cleanup]);
      }
    } finally { this.running = false; }
  }
}
module.exports = { SCHEMA, ObsoleteNoticeCleanup };
