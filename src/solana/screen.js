const { randomBytes } = require('node:crypto');
class ScreenTransportError extends Error {}
// Only this saved navigation message is editable. Payment receipts and group
// results are deliberately outside this controller.
class PrivateScreen {
  constructor(store, telegram) { Object.assign(this, { store, telegram }); this.queues = new Map(); }
  async serial(userId, work) {
    const key = String(userId), previous = this.queues.get(key) || Promise.resolve();
    const current = previous.catch(() => {}).then(work);
    this.queues.set(key, current);
    try { return await current; }
    finally { if (this.queues.get(key) === current) this.queues.delete(key); }
  }
  async valid(ctx) {
    if (ctx.chat?.type !== 'private' || !ctx.callbackQuery?.message) return true;
    const screen = (await this.store.profile(ctx.from.id)).privateScreen;
    const [data, revision] = ctx.callbackQuery.data.split('|');
    if (screen && (String(ctx.callbackQuery.message.message_id) !== String(screen.messageId) || revision !== screen.revision)) {
      // An older screen must never mutate a newer session or accept a wager.
      if (String(ctx.callbackQuery.message.message_id) !== String(screen.messageId)) {
        await this.telegram.editMessageReplyMarkup(ctx.chat.id, ctx.callbackQuery.message.message_id, undefined, { inline_keyboard: [] }).catch(() => {});
      }
      await ctx.answerCbQuery('That screen has changed. Use the current screen or /start.').catch(() => {});
      return false;
    }
    if (!screen && revision) { await ctx.answerCbQuery('Reopen the menu with /start.').catch(() => {}); return false; }
    ctx.callbackQuery.data = data;
    return true;
  }
  async show(ctx, text, rows) {
    const profile = await this.store.profile(ctx.from.id), old = profile.privateScreen;
    const revision = randomBytes(4).toString('hex');
    const buttons = rows.map(row => row.map(b => b.callback_data ? { ...b, callback_data: `${b.callback_data}|${revision}` } : b));
    if (buttons.flat().some(b => b.callback_data && Buffer.byteLength(b.callback_data) > 64)) throw new Error('Navigation button too long');
    const options = { parse_mode: 'HTML', link_preview_options: { is_disabled: true }, reply_markup: { inline_keyboard: buttons } };
    let messageId = old?.messageId;
    if (messageId) {
      try { await this.telegram.editMessageText(ctx.chat.id, messageId, undefined, text, options); }
      catch (error) {
        const description = error.response?.description || '';
        if (/message to edit not found|message can't be edited/i.test(description)) {
          messageId = null;
          await this.telegram.editMessageReplyMarkup(ctx.chat.id, old.messageId, undefined, { inline_keyboard: [] }).catch(() => {});
          await this.telegram.deleteMessage(ctx.chat.id, old.messageId).catch(() => {});
        } else if (!/message is not modified/i.test(description)) {
          // A timeout may mean the edit succeeded. Never follow it with a new
          // message; /start can safely reconcile the existing screen.
          throw new ScreenTransportError('Screen edit needs retry');
        }
      }
    }
    if (!messageId) {
      try { messageId = (await ctx.reply(text, options)).message_id; }
      catch (_) { throw new ScreenTransportError('Screen send needs retry'); }
    }
    await this.store.updateProfile(ctx.from.id, { privateScreen: { messageId, revision, text, rows: buttons, gameId: ctx.solGameId || null, view: ctx.solView || null, gameStateKey: ctx.solGameStateKey || null } });
    ctx.screenUpdated = true;
    return { message_id: messageId };
  }
}
module.exports = { PrivateScreen, ScreenTransportError };
