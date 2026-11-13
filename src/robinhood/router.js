const { randomUUID } = require('node:crypto');
const { SolanaInterface } = require('../solana/interface');
const { PrivateScreen } = require('../solana/screen');
const { ChallengeBusyError } = require('../solana/errors');
// One Telegram poller and one navigation screen. Wallets, tokens and financial
// records stay in their own chain store. Only screen ownership is shared.
function shareScreen(store, root) {
  const profile = store.profile.bind(store), update = store.updateProfile.bind(store);
  store.profile = async id => {
    const [own, shared] = await Promise.all([profile(id), root.profile(id)]);
    return { ...own, privateScreen: shared.privateScreen };
  };
  store.updateProfile = async (id, fields) => {
    const { privateScreen, ...own } = fields;
    if (Object.keys(own).length) await update(id, own);
    if (Object.hasOwn(fields, 'privateScreen')) await root.updateProfile(id, { privateScreen });
  };
  store.gameScreens = root.gameScreens.bind(root);
}
function createRouter(bot, entries) {
  const root = entries.solana.service.store;
  const screens = new PrivateScreen(root, bot.telegram);
  const handlers = {}, uis = {};
  for (const [key, entry] of Object.entries(entries)) {
    if (key !== 'solana') shareScreen(entry.service.store, root);
    const registered = {};
    const virtual = {
      telegram: bot.telegram, get botInfo() { return bot.botInfo; }, set botInfo(v) { bot.botInfo = v; },
      start: fn => { registered.start = fn; }, command: (name, fn) => { registered[name] = fn; },
      action: (_pattern, fn) => { registered.action = fn; }, on: (_kind, fn) => { registered.text = fn; },
    };
    const ui = new SolanaInterface(virtual, entry.service, entry.scanner);
    ui.multiChain = true; ui.screens = screens; ui.register();
    if (entry.prices) ui.prices = entry.prices;
    handlers[key] = registered; uis[key] = ui;
  }
  // Shared read-only reporting. Wallets, receipts and payment workers remain
  // isolated. Keep UI references so each chain uses its own quote provider.
  const reportingSources = Object.values(uis);
  for (const ui of reportingSources) ui.reportingSources = reportingSources;
  const selected = async ctx => (await root.profile(ctx.from.id)).privateScreen?.chainKey || 'solana';
  const dispatch = async (ctx, name, force) => {
    const key = force || await selected(ctx);
    if (!handlers[key]) throw new Error('Network unavailable');
    return handlers[key][name](ctx);
  };
  async function choose(ctx) {
    const previous = await selected(ctx);
    ctx.solChainKey = previous;
    return screens.show(ctx, '<b>Choose a Network</b>\n\nSolana and Robinhood Chain have separate wallets, tokens and balances. Both include their own SID. Robinhood also includes native ETH.', [[{ text: 'Solana', callback_data: 'net:solana' }, { text: 'Robinhood Chain', callback_data: 'net:robinhood' }]]);
  }
  async function groupFlip(ctx) {
    if (ctx.chat.type === 'private') return dispatch(ctx, 'flip');
    if (await root.activeGroup(ctx.chat.id)) return ctx.reply(new ChallengeBusyError().message);
    const rows = [];
    for (const [key, { service }] of Object.entries(entries)) {
      const id = randomUUID();
      await service.store.draft(id, ctx.from.id, ctx.chat.id);
      const prefix = key === 'solana' ? 'solcreate_' : 'rhcreate_';
      rows.push([{ text: key === 'solana' ? 'Solana' : 'Robinhood Chain', url: `https://t.me/${bot.botInfo.username}?start=${prefix}${id}`, draftId: id, key }]);
    }
    const sent = await ctx.reply('🪙 Start a Coin Flip\nChoose the network, then select your token and wager privately.', { reply_markup: { inline_keyboard: rows.map(row => row.map(({ draftId, key, ...b }) => b)) } });
    // Shared invitation belongs to the Solana draft; the RH draft keeps no
    // pointer, preventing an unchosen expired draft from deleting a live card.
    await root.draftMessage(rows[0][0].draftId, sent.message_id);
    const rhId = rows.find(r => r[0].key === 'robinhood')?.[0].draftId;
    if (rhId) await entries.robinhood.service.store.setInvitePeer?.(rhId, rows[0][0].draftId);
  }
  bot.start(async ctx => {
    const payload = ctx.startPayload || ctx.message?.text?.split(/\s+/)[1] || '';
    if (/^rh(create|join)_/.test(payload)) {
      if (payload.startsWith('rhcreate_')) {
        const peer = await entries.robinhood.service.store.invitePeer?.(payload.slice(9));
        if (peer) await uis.solana.cleanupDraft(await root.draft(peer, ctx.from.id));
      }
      return dispatch(ctx, 'start', 'robinhood');
    }
    if (/^sol(create|join)_/.test(payload)) return dispatch(ctx, 'start', 'solana');
    if (ctx.chat.type === 'private') { ctx.solNewScreen = true; return choose(ctx); }
  });
  bot.command('flip', groupFlip);
  for (const command of ['wallet', 'stats', 'leaderboard', 'shame', 'wallofshame', 'help']) bot.command(command, ctx => dispatch(ctx, command));
  bot.action(/^net:/, async ctx => screens.serial(ctx.from.id, async () => {
    if (!await screens.valid(ctx)) return;
    await ctx.answerCbQuery().catch(() => {});
    const key = ctx.callbackQuery.data.slice(4);
    if (key === 'choose') return choose(ctx);
    if (!uis[key] || ctx.chat.type !== 'private') return;
    // Invalidate unfinished navigation in both ledgers. Existing games and
    // one-tap deposit-check intentions remain durable and resumable.
    for (const e of Object.values(entries)) await e.service.store.clearSession(ctx.from.id);
    return uis[key].home(ctx);
  }));
  bot.action(/^[sr]:/, ctx => dispatch(ctx, 'action', ctx.callbackQuery.data.startsWith('r:') ? 'robinhood' : 'solana'));
  bot.on('text', ctx => dispatch(ctx, 'text'));
  return { uis, screens, choose, groupFlip, dispatch };
}
module.exports = { createRouter, shareScreen };
