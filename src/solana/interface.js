const { randomUUID, randomBytes } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { publicKey } = require('./chain');
const { fromUnits, toUnits } = require('./amounts');
const { tokensForUser } = require('./featured');
const { getVideoDuration } = require('../utils/helpers');
const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const button = (text, callback_data) => ({ text, callback_data });
const keyboard = rows => ({ parse_mode: 'HTML', reply_markup: { inline_keyboard: rows } });
const mention = player => `<a href="tg://user?id=${escape(player.userId)}">${escape(player.name || player.userId)}</a>`;
const nonce = () => randomBytes(6).toString('hex');
function paymentURI(game, player) {
  const params = new URLSearchParams({ amount: fromUnits(game.wager, game.token.decimals), memo: player.memo, label: 'Coin Flip' });
  if (game.token.address !== 'NATIVE') params.set('spl-token', game.token.address);
  return `solana:${game.depositAddress}?${params}`;
}
function networkName(chain) { return chain.env.SOLANA_CLUSTER === 'mainnet-beta' ? 'Solana mainnet' : 'Solana devnet (test coins)'; }
function summary(g) { return `${escape(fromUnits(g.wager, g.token.decimals))} ${escape(g.token.symbol)}`; }
class SolanaInterface {
  constructor(bot, service, scanner, env = process.env) {
    Object.assign(this, { bot, service, scanner, env });
    this.store = service.store;
    this.telegram = bot.telegram;
    this.rendering = false;
  }
  register() {
    const wrap = fn => async ctx => {
      try {
        if (ctx.callbackQuery) await ctx.answerCbQuery().catch(() => {});
        await this.store.updateProfile(ctx.from.id, { name: ctx.from.first_name || ctx.from.username || String(ctx.from.id) });
        await fn(ctx);
      } catch (_) {
        await ctx.reply('That action could not be completed. Check the current game or use /start to reopen the menu. Your existing deposits and payout records are preserved.');
      }
    };
    this.bot.start(wrap(ctx => this.start(ctx)));
    this.bot.command('flip', wrap(ctx => this.flip(ctx)));
    this.bot.command('wallet', wrap(ctx => this.wallets(ctx)));
    this.bot.command('stats', wrap(ctx => this.stats(ctx)));
    this.bot.command('leaderboard', wrap(ctx => this.leaderboard(ctx)));
    this.bot.command('shame', wrap(ctx => this.leaderboard(ctx, true)));
    this.bot.command('wallofshame', wrap(ctx => this.leaderboard(ctx, true)));
    this.bot.command('help', wrap(ctx => this.help(ctx)));
    this.bot.action(/^s:/, wrap(ctx => this.action(ctx)));
    this.bot.on('text', wrap(ctx => this.text(ctx)));
  }
  async me() { return this.bot.botInfo || (this.bot.botInfo = await this.telegram.getMe()); }
  async reply(ctx, text, rows = []) { return ctx.reply(text, keyboard(rows)); }
  async private(ctx) {
    if (ctx.chat?.type === 'private') return true;
    const me = await this.me();
    await this.reply(ctx, 'Open the bot privately to manage your wallet and account.', [[{ text: 'Open Bot', url: `https://t.me/${me.username}` }]]);
    return false;
  }
  async start(ctx) {
    if (ctx.chat.type !== 'private') return;
    const payload = ctx.startPayload || ctx.message?.text?.split(/\s+/)[1] || '';
    if (payload.startsWith('solcreate_')) {
      const draft = await this.store.draft(payload.slice(10), ctx.from.id);
      return this.begin(ctx, { kind: 'create', draftId: draft.id, chatId: draft.chatId });
    }
    if (payload.startsWith('soljoin_')) return this.reviewJoin(ctx, payload.slice(8));
    return this.home(ctx);
  }
  async home(ctx) {
    if (!await this.private(ctx)) return;
    await this.store.clearSession(ctx.from.id);
    const profile = await this.store.profile(ctx.from.id);
    return this.reply(ctx, `🏠 <b>Coin Flip Dashboard</b>\n${escape(networkName(this.service.chain))}\n\n` +
      `Sending wallet: ${profile.wallet ? `<code>${escape(profile.wallet)}</code>` : 'Not set'}\n` +
      `Receive wallet: ${profile.receiveWallet ? `<code>${escape(profile.receiveWallet)}</code>` : 'Not set'}\n\nUse /flip in your group to start a challenge.`, [
      [button('💳 Wallets', 's:wallets'), button('📊 My Stats', 's:stats')],
      [button('🪙 Start Flip', 's:flip'), button('💰 Profit Share', 's:fees')],
      [button('⭐ My Tokens', 's:tokens'), button('❓ Help', 's:help')],
    ]);
  }
  async wallets(ctx) {
    if (!await this.private(ctx)) return;
    const profile = await this.store.profile(ctx.from.id);
    return this.reply(ctx, `<b>Your Solana Wallets</b>\n\nSending: <code>${escape(profile.wallet || 'Not set')}</code>\nReceiving: <code>${escape(profile.receiveWallet || 'Not set')}</code>\n\nOnly public addresses are needed. Never send a key or seed phrase. Changes apply to future games. Refunds return to the actual sending wallet.`, [
      [button('Set Sending Wallet', 's:wallet:wallet')], [button('Set Receive Wallet', 's:wallet:receiveWallet')], [button('🏠 Home', 's:home')],
    ]);
  }
  async begin(ctx, state) {
    const profile = await this.store.profile(ctx.from.id);
    if (!profile.wallet || !profile.receiveWallet) {
      const field = !profile.wallet ? 'wallet' : 'receiveWallet';
      await this.store.setSession(ctx.from.id, { kind: 'wallet', field, resume: state });
      return this.reply(ctx, `Send your public Solana ${field === 'wallet' ? 'sending' : 'receiving'} wallet address to continue.`, field === 'receiveWallet' ? [[button('Use Sending Wallet', 's:wallet:same')]] : []);
    }
    if (state.kind === 'join') return this.reviewJoin(ctx, state.gameId, true);
    return this.selectTokens(ctx, state);
  }
  async flip(ctx) {
    if (ctx.chat.type === 'private') return this.reply(ctx, 'Use /flip in the group where you want to challenge another player. I will send you a private token and wager menu.', [[button('🏠 Home', 's:home')]]);
    const draftId = randomUUID();
    await this.store.draft(draftId, ctx.from.id, ctx.chat.id);
    const me = await this.me();
    const text = `🪙 <b>Start a Coin Flip</b>\n\n${escape(ctx.from.first_name || 'Player')}, choose your token and wager privately.\n${escape(networkName(this.service.chain))}`;
    return this.reply(ctx, text, [[{ text: 'Start in DM', url: `https://t.me/${me.username}?start=solcreate_${draftId}` }]]);
  }
  async selectTokens(ctx, state = { kind: 'favorites' }, page = 0) {
    const tokens = tokensForUser(await this.store.tokens(String(ctx.from.id)), this.service.chain.env.SOLANA_CLUSTER);
    page = Math.max(0, Math.min(Math.trunc(page), Math.ceil(tokens.length / 20) - 1));
    const data = { ...state, page, step: 'token', nonce: nonce(), tokens };
    await this.store.setSession(ctx.from.id, data);
    const rows = tokens.slice(page * 20, (page + 1) * 20).map((token, i) => [
      button(`${token.featured ? '⭐' : '❤️'} ${token.symbol}`, `s:token:${page * 20 + i}:${data.nonce}`),
      ...(state.kind === 'favorites' && !token.featured ? [button('Remove', `s:remove:${page * 20 + i}:${data.nonce}`)] : []),
    ]);
    const pages = [];
    if (page > 0) pages.push(button('Previous', `s:page:${page - 1}:${data.nonce}`));
    if ((page + 1) * 20 < tokens.length) pages.push(button('Next', `s:page:${page + 1}:${data.nonce}`));
    if (pages.length) rows.push(pages);
    rows.push([button('🔍 Enter Contract Address', `s:custom:${data.nonce}`)], [button('🏠 Home', 's:home')]);
    return this.reply(ctx, `<b>${state.kind === 'favorites' ? 'My Tokens' : 'Select a Token'}</b>\n${escape(networkName(this.service.chain))}\n\nFeatured tokens are included for everyone. Custom assets are identified by their exact mint address.`, rows);
  }
  async chooseToken(ctx, state, mint) {
    const token = await this.service.chain.tokenInfo(mint);
    if (state.kind === 'favorites') {
      await this.store.saveToken(String(ctx.from.id), token);
      return this.selectTokens(ctx);
    }
    await this.store.setSession(ctx.from.id, { ...state, token, step: 'amount' });
    return this.reply(ctx, `<b>Wager Amount</b>\n\nToken: ${escape(token.symbol)}\nMint: <code>${escape(token.address)}</code>\n\nType the amount you want each player to wager here in this chat, for example <code>0.01</code>. The next message will show the deposit address and transfer instructions. Winner receives 90% of the pool.`, [[button('🏠 Home', 's:home')]]);
  }
  async reviewJoin(ctx, id, walletsReady = false) {
    const game = await this.store.get(id);
    if (game.status !== 'OPEN' || !game.creator.deposit || (game.interfaceVersion >= 2 && !game.ui?.publishRequested) || game.challenger || this.service.now() >= game.expiresAt || game.creator.userId === String(ctx.from.id)) return this.reply(ctx, 'This challenge is unavailable, expired or your own challenge.');
    if (!walletsReady) return this.begin(ctx, { kind: 'join', gameId: id });
    await this.store.setSession(ctx.from.id, { kind: 'join', gameId: id, step: 'confirm', nonce: nonce() });
    const session = await this.store.session(ctx.from.id);
    return this.reply(ctx, `<b>Review Challenge</b>\n\nCreator: ${mention(game.creator)}\nEach player wagers: <b>${summary(game)}</b>\nWinner receives 90% of the pool.\n${escape(networkName(this.service.chain))}`, [[button('✅ Accept', `s:accept:${session.nonce}`), button('❌ Decline', 's:home')]]);
  }
  async depositMessage(ctx, game) {
    const player = this.service.member(game, ctx.from.id);
    const base = this.env.PUBLIC_BASE_URL || (this.env.RAILWAY_PUBLIC_DOMAIN ? `https://${this.env.RAILWAY_PUBLIC_DOMAIN}` : '');
    const role = player.userId === game.creator.userId ? 'creator' : 'challenger';
    const rows = [];
    rows.push([{ text: '📋 Copy Deposit Address', copy_text: { text: game.depositAddress } }]);
    rows.push([{ text: '📋 Copy Exact Amount', copy_text: { text: fromUnits(game.wager, game.token.decimals) } }, { text: '📋 Copy Game Memo', copy_text: { text: player.memo } }]);
    if (/^https:\/\//.test(base) && player.payToken) rows.push([{ text: '💳 Open Deposit', url: `${base.replace(/\/$/, '')}/pay/${game.id}/${role}/${player.payToken}` }]);
    rows.push([button('✅ Confirm Deposit', `s:check:${game.id}`)], [button('Game Status', `s:status:${game.id}`)]);
    if (role === 'creator') rows.push([button('Cancel Challenge', `s:cancel:${game.id}`)]);
    return this.reply(ctx, `<b>Transfer Your Wager From Your Wallet</b>\n${escape(networkName(this.service.chain))}\n\nAmount: <b>${summary(game)}</b>\nFrom: <code>${escape(player.wallet)}</code>\nTo: <code>${escape(game.depositAddress)}</code>\nMint: <code>${escape(game.token.address)}</code>\nGame memo (optional for a unique matching transfer): <code>${escape(player.memo)}</code>\nWinnings go to: <code>${escape(player.receiveWallet || player.wallet)}</code>\n\n1. Copy the deposit address and exact amount above.\n2. Transfer from your registered sending wallet. Including the game memo helps identify the payment if requests overlap.\n3. Return here and tap Confirm Deposit.\n\nThe bot automatically reports finalized deposits and payment confirmations here and in the originating group. ${role === 'creator' ? 'Once your deposit is confirmed, the challenge is posted to the group where you started /flip.' : 'Once both deposits are confirmed, the game resolves.'} A plain transfer is matched only when the signing wallet, exact token, exact amount and transaction time identify one request. If requests overlap, include the game memo or use Open Deposit.\n\nPayment URI:\n<code>${escape(paymentURI(game, player))}</code>`, rows);
  }
  async confirmDeposit(ctx, id) {
    const before = await this.store.get(id);
    this.service.member(before, ctx.from.id);
    if (this.scanner.confirm) await this.scanner.confirm(id, ctx.from.id);
    else await this.scanner.tick();
    await this.service.work();
    const game = await this.store.get(id);
    const player = this.service.member(game, ctx.from.id);
    if (player.deposit && game.creator.userId === String(ctx.from.id)) {
      await this.store.mutate(id, g => {
        if (g.status === 'OPEN' && g.creator.deposit && this.service.now() < g.expiresAt) {
          g.ui ||= {};
          g.ui.publishRequested = true;
        }
      });
    }
    await this.render();
    if (!player.deposit && game.status === 'OPEN') {
      return this.reply(ctx, 'Your deposit has not been matched yet. Check the amount, registered sending wallet, destination and whether another request overlaps. A game memo identifies the payment when requests overlap. If you already transferred, the bot will report the finalized deposit automatically. You can also tap Confirm Deposit to recheck.', [
        [button('✅ Confirm Deposit', `s:check:${id}`)],
        [button('Game Status', `s:status:${id}`)],
      ]);
    }
    return this.status(ctx, id);
  }
  async status(ctx, id) {
    const game = await this.store.get(id);
    this.service.member(game, ctx.from.id);
    const payments = await this.store.payments(id);
    const winner = [game.creator, game.challenger].find(p => p?.userId === game.winnerId);
    return this.reply(ctx, `<b>Game Status</b>\n${summary(game)}\nState: ${escape(game.status)}\nCreator funded: ${Boolean(game.creator.deposit)}\nChallenger funded: ${Boolean(game.challenger?.deposit)}\n` + (winner ? `Winner: ${mention(winner)}\n` : '') + payments.map(p => `${escape(p.id.split(':')[0])}: ${escape(p.status)}${p.signature ? `\n${escape(this.explorer(p.signature))}` : ''}`).join('\n'), [[button('Refresh', `s:status:${id}`)], [button('🏠 Home', 's:home')]]);
  }
  explorer(signature) { return `https://explorer.solana.com/tx/${signature}${this.service.chain.env.SOLANA_CLUSTER === 'mainnet-beta' ? '' : '?cluster=devnet'}`; }
  async action(ctx) {
    if (!await this.private(ctx)) return;
    const [, action, arg, revision] = ctx.callbackQuery.data.split(':');
    const simple = { home: () => this.home(ctx), wallets: () => this.wallets(ctx), flip: () => this.flip(ctx), tokens: () => this.selectTokens(ctx), stats: () => this.stats(ctx), help: () => this.help(ctx), fees: () => this.fees(ctx), holder: () => this.holder(ctx) };
    if (simple[action]) return simple[action]();
    if (action === 'wallet') {
      if (arg === 'same') {
        const session = await this.store.session(ctx.from.id), profile = await this.store.profile(ctx.from.id);
        if (session?.kind !== 'wallet' || session.field !== 'receiveWallet' || !profile.wallet) throw new Error('No wallet prompt');
        await this.store.updateProfile(ctx.from.id, { receiveWallet: profile.wallet });
        await this.store.clearSession(ctx.from.id);
        return session.resume ? this.begin(ctx, session.resume) : this.wallets(ctx);
      }
      if (!['wallet', 'receiveWallet'].includes(arg)) throw new Error('Invalid wallet field');
      await this.store.setSession(ctx.from.id, { kind: 'wallet', field: arg });
      return this.reply(ctx, `Send your public Solana ${arg === 'wallet' ? 'sending' : 'receiving'} wallet address.`);
    }
    if (action === 'check') return this.confirmDeposit(ctx, arg);
    if (action === 'status') return this.status(ctx, arg);
    if (action === 'cancel') {
      const game = await this.store.get(arg);
      await this.service.cancel({ id: arg, userId: ctx.from.id, chatId: game.chatId });
      await this.service.work(); await this.render();
      return this.reply(ctx, 'Challenge cancelled. Recorded deposits are queued for full refund. Status shows when each refund is finalized.', [[button('Game Status', `s:status:${arg}`)]]);
    }
    const session = await this.store.session(ctx.from.id);
    if (!session) throw new Error('Session expired');
    if (action === 'page' || action === 'remove') {
      if (session.nonce !== revision || session.step !== 'token' || !/^\d+$/.test(arg)) throw new Error('Stale token menu');
      if (action === 'page') return this.selectTokens(ctx, session, Number(arg));
      const token = session.tokens[Number(arg)];
      if (session.kind !== 'favorites' || !token || token.featured) throw new Error('Cannot remove this token');
      await this.store.removeToken(ctx.from.id, token.address);
      return this.selectTokens(ctx, { kind: 'favorites' }, session.page);
    }
    if (action === 'token') {
      if (session.nonce !== revision || session.step !== 'token' || !/^\d+$/.test(arg) || !session.tokens[Number(arg)]) throw new Error('Stale selection');
      return this.chooseToken(ctx, session, session.tokens[Number(arg)].address);
    }
    if (action === 'custom') {
      if (session.nonce !== arg || session.step !== 'token') throw new Error('Stale custom prompt');
      await this.store.setSession(ctx.from.id, { ...session, step: 'custom' });
      return this.reply(ctx, 'Send the exact Solana token mint address. It will be checked on the selected network.');
    }
    if (action === 'accept') {
      if (session.nonce !== arg || session.kind !== 'join' || session.step !== 'confirm') throw new Error('Stale accept');
      const profile = await this.store.profile(ctx.from.id), game = await this.store.get(session.gameId);
      const joined = await this.service.join({ id: game.id, userId: ctx.from.id, chatId: game.chatId, wallet: profile.wallet, receiveWallet: profile.receiveWallet, name: profile.name });
      await this.store.clearSession(ctx.from.id);
      await this.render();
      return this.depositMessage(ctx, joined);
    }
    throw new Error('Unknown action');
  }
  async text(ctx) {
    if (ctx.chat.type !== 'private' || ctx.message.text.startsWith('/')) return;
    const state = await this.store.session(ctx.from.id);
    if (!state) return;
    const text = ctx.message.text.trim();
    if (['holder-address', 'holder-sign'].includes(state.kind) && this.service.feeService?.mode !== 'paxeer') {
      await this.store.clearSession(ctx.from.id);
      return this.fees(ctx);
    }
    if (state.kind === 'holder-address') {
      const profile = await this.store.profile(ctx.from.id);
      const c = await this.service.feeService.challenge(ctx.from.id, text, profile.receiveWallet);
      await this.store.setSession(ctx.from.id, { kind: 'holder-sign', id: c.id });
      const base = this.env.PUBLIC_BASE_URL || (this.env.RAILWAY_PUBLIC_DOMAIN ? `https://${this.env.RAILWAY_PUBLIC_DOMAIN}` : '');
      const rows = /^https:\/\//.test(base) ? [[{ text: 'Verify Holding Wallet', url: `${base.replace(/\/$/, '')}/holder/${c.id}` }]] : [];
      rows.push([button('Profit Share', 's:fees')]);
      return this.reply(ctx, `<b>Verify FLIP Holding Wallet</b>\n\nSign this exact message in your EVM wallet, then paste only the signature here, or open the verification link in your wallet browser. No transaction or spending approval is requested. Link expires in 10 minutes.\n\n<code>${escape(c.message)}</code>`, rows);
    }
    if (state.kind === 'holder-sign') {
      await this.service.feeService.verify(state.id, text);
      await this.store.clearSession(ctx.from.id);
      return this.fees(ctx);
    }
    if (state.kind === 'wallet') {
      publicKey(text);
      if (text === this.service.chain.address) return this.reply(ctx, 'Use your own wallet, rather than the bot’s shared deposit address.');
      await this.store.updateProfile(ctx.from.id, { [state.field]: text });
      await this.store.clearSession(ctx.from.id);
      return state.resume ? this.begin(ctx, state.resume) : this.wallets(ctx);
    }
    if (state.step === 'custom') {
      const token = await this.service.chain.tokenInfo(text);
      await this.store.saveToken(String(ctx.from.id), token);
      return this.chooseToken(ctx, state, token.address);
    }
    if (state.kind === 'create' && state.step === 'amount') {
      try { toUnits(text, state.token.decimals); }
      catch (_) { return this.reply(ctx, 'Enter a positive amount such as 0.01 (or .01), using no more decimal places than this token supports.'); }
      const draft = await this.store.draft(state.draftId, ctx.from.id), profile = await this.store.profile(ctx.from.id);
      const game = await this.service.create({ userId: ctx.from.id, chatId: draft.chatId, wallet: profile.wallet, receiveWallet: profile.receiveWallet, name: profile.name, mint: state.token.address, amount: text, gameId: draft.id, interfaceVersion: 2 });
      await this.store.clearSession(ctx.from.id);
      await this.render();
      return this.depositMessage(ctx, game);
    }
  }
  async help(ctx) {
    return this.reply(ctx, `<b>How to Play</b>\n\n1. Set sending and receiving wallets using /wallet.\n2. Use /flip in a group and choose a token and amount privately.\n3. Type the wager amount in chat, then copy the deposit address from the transfer screen. Transfer the wager from your registered wallet and tap Confirm Deposit. The funded challenge is then posted to the originating group.\n4. Another player reviews and accepts the challenge, then deposits.\n5. The coin animation plays, the result is announced, and the winner receives 90% of the pool automatically.\n\nCancelled and expired games refund recorded deposits to their sending wallets. Deposits, refunds, prize payments, burns and holder-custody transfers are automatically reported here and in the originating group with amounts and transaction links. Pending or uncertain payments remain visible in Game Status.\n\n${escape(networkName(this.service.chain))}`, [[button('🏠 Home', 's:home')]]);
  }
  async fees(ctx) {
    const fees = this.service.feeService;
    const link = fees ? await fees.link(ctx.from.id) : null;
    const pools = (await this.store.pool.query('SELECT token,amount FROM "SolFeePools" WHERE amount>0 ORDER BY mint LIMIT 10')).rows;
    if (fees?.mode !== 'paxeer') {
      const custody = await this.store.holderCustody?.();
      const balance = p => `${escape(fromUnits(p.amount, p.token.decimals))} ${escape(p.token.symbol)} (${escape(p.token.address)})`;
      let location = custody
        ? `Holder rewards wallet:\n<code>${escape(custody.wallet)}</code>\nThe 5% is queued for transfer here in the original wager asset. Pending or uncertain transfers remain treasury liabilities; only finalized transfers enter this wallet's recorded reserve. This is custody, not a payout to holders.\n\nConfirmed wallet reserves (first 5 assets):\n${custody.reserves.slice(0, 5).map(balance).join('\n') || 'No confirmed transfers yet.'}\n\nRecent wallet transfers (latest 3):\n${custody.transfers.slice(0, 3).map(p => `${balance({ ...p.payment, token: p.payment.token })}: ${escape(p.status)}${p.signature ? `\n${escape(this.explorer(p.signature))}` : ''}`).join('\n') || 'None yet.'}`
        : 'Reserved fees stay in the treasury and count as liabilities. They are not paid to the operator or represented as distributed.';
      if (this.service.custodyError) location += `\n\n${escape(this.service.custodyError)}`;
      return this.reply(ctx, '<b>Fee Accounting</b>\n\nWinner: 90% of the pool.\nBurn: 5%, queued with each settled game.\nHolder share: 5%, reserved in the original Solana asset.\n\nPaxeer support and holder distributions are deferred.\n\n' + location + '\n\nGame Status shows prize, burn and holder-wallet transfer confirmation.\n\nHolder pools still in treasury (first 5 assets):\n' + (pools.slice(0, 5).map(balance).join('\n') || 'None.'), [[button('Refresh', 's:fees')], [button('🏠 Home', 's:home')]]);
    }
    const payments = (await this.store.pool.query('SELECT payment,status,signed->>\'signature\' AS signature FROM "SolOutbox" WHERE payment->>\'kind\'=\'holder\' AND payment->>\'userId\'=$1 ORDER BY "createdAt" DESC LIMIT 5', [String(ctx.from.id)])).rows;
    return this.reply(ctx, '<b>Profit Share</b>\n\nWinner: 90%. FLIP holders: 5%. Burn: 5%.\nBurns are queued with each settled game; Game Status shows actual confirmation.\n\nHolder rewards use your share of eligible Paxeer FLIP supply, paid daily in the original Solana wager asset. Unregistered shares and dust stay pooled. SOL is sent to Solana’s incinerator; supported token burns reduce mint supply.\n\n' +
      (link ? `Verified holding wallet: <code>${escape(link.evm)}</code>\nReward recipient: <code>${escape(link.recipient)}</code>\nWallet menu changes do not redirect rewards; sign a new link to change the recipient.\n` : 'Link your FLIP holding wallet to register for rewards. Ownership signature required.\n') +
      (fees?.lastError ? `\n${escape(fees.lastError)}\n` : '') +
      (pools.length ? '\nUnallocated pools:\n' + pools.map(p => `${escape(fromUnits(p.amount, p.token.decimals))} ${escape(p.token.symbol)} (${escape(p.token.address)})`).join('\n') : '\nNo unallocated fees yet.') +
      (payments.length ? '\n\nYour latest reward payments:\n' + payments.map(p => `${escape(p.payment.amount)} atomic units, ${escape(p.payment.mint)}: ${escape(p.status)}${p.signature ? `\n${escape(this.explorer(p.signature))}` : ''}`).join('\n') : ''), [[button(link ? 'Update Reward Wallet Link' : 'Link FLIP Holding Wallet', 's:holder')], [button('Refresh', 's:fees')], [button('🏠 Home', 's:home')]]);
  }
  async holder(ctx) {
    if (this.service.feeService?.mode !== 'paxeer') return this.fees(ctx);
    if (!this.service.feeService) throw new Error('Holder service unavailable');
    const profile = await this.store.profile(ctx.from.id);
    if (!profile.receiveWallet) return this.reply(ctx, 'Set your Solana receiving wallet first using /wallet.');
    await this.store.setSession(ctx.from.id, { kind: 'holder-address' });
    return this.reply(ctx, `Send the public Paxeer EVM address holding your FLIP (0x…). You will sign a message proving ownership and authorizing rewards to <code>${escape(profile.receiveWallet)}</code>. Never send a private key or seed phrase.`);
  }
  async stats(ctx) {
    const games = (await this.store.allResults()).filter(g => [g.creator.userId, g.challenger?.userId].includes(String(ctx.from.id)));
    const wins = games.filter(g => g.winnerId === String(ctx.from.id)).length;
    const assets = new Map();
    for (const g of games) {
      const a = assets.get(g.token.address) || { token: g.token, wagered: 0n, allocated: 0n };
      a.wagered += BigInt(g.wager);
      if (g.winnerId === String(ctx.from.id)) a.allocated += BigInt(g.prize);
      assets.set(g.token.address, a);
    }
    return this.reply(ctx, `<b>Your Game Statistics</b>\n\nFlips: ${games.length}\nWins: ${wins}\nLosses: ${games.length - wins}\n\n` + [...assets.values()].slice(0, 20).map(a => `${escape(a.token.symbol)} (<code>${escape(a.token.address)}</code>)\nWagered: ${fromUnits(a.wagered, a.token.decimals)}\nPrizes allocated: ${fromUnits(a.allocated, a.token.decimals)}`).join('\n\n') + '\n\nAllocated prizes may still be pending payment. Different tokens are never added together.', [[button('🏠 Home', 's:home')]]);
  }
  async leaderboard(ctx, losers = false) {
    const results = await this.store.allResults(), ranks = new Map();
    for (const game of results) for (const player of [game.creator, game.challenger]) {
      const r = ranks.get(player.userId) || { ...player, wins: 0, losses: 0 };
      if (game.winnerId === player.userId) r.wins++; else r.losses++;
      ranks.set(player.userId, r);
    }
    const order = [...ranks.values()].sort((a, b) => losers ? b.losses - a.losses : b.wins - a.wins).slice(0, 10);
    return this.reply(ctx, `<b>${losers ? 'Wall of Shame' : 'Leaderboard'}</b>\nRanked by ${losers ? 'losses' : 'wins'}.\n\n` + (order.map((r, i) => `${i + 1}. ${mention(r)}: ${r.wins} wins, ${r.losses} losses`).join('\n') || 'No completed flips yet.'));
  }
  async render() {
    if (this.rendering) return;
    this.rendering = true;
    try {
      const me = await this.me();
      for (const snapshot of await this.store.groupGames()) {
        const game = await this.store.get(snapshot.id);
        // An existing card may still need cancellation/refund updates. A new
        // challenge is published only after creator funding; v2 also requires
        // the creator's explicit Confirm Deposit action.
        if (!game.ui?.messageId && (!game.creator.deposit || (game.interfaceVersion >= 2 && !game.ui?.publishRequested))) continue;
        const payments = await this.store.payments(game.id);
        let text = `<b>🪙 Coin Flip</b>\n${summary(game)} each\n${escape(networkName(this.service.chain))}\nCreator: ${mention(game.creator)}\n`;
        const rows = [];
        if (game.status === 'OPEN') {
          if (!game.creator.deposit) text += '\nWaiting for creator deposit.';
          else if (!game.challenger) {
            text += '\nCreator funded. Awaiting a challenger.';
            rows.push([{ text: 'Accept Challenge', url: `https://t.me/${me.username}?start=soljoin_${game.id}` }]);
          } else text += `\nChallenger: ${mention(game.challenger)}\nWaiting for challenger deposit.`;
        } else if (game.status === 'CANCELLED') {
          text += '\nChallenge cancelled or expired.\n' + (payments.length ? payments.every(p => p.status === 'CONFIRMED') ? 'Recorded refunds finalized.' : 'Recorded refunds pending; check Game Status.' : 'No deposits recorded.');
        } else {
          if (!game.ui?.animationClaimed) {
            const video = path.join(__dirname, '../../assets/coinflip.MP4');
            this.videoDuration ??= fs.existsSync(video) ? await getVideoDuration(video) : 0;
            let send = false;
            const claimed = await this.store.mutate(game.id, g => {
              g.ui ||= {};
              if (!g.ui.animationClaimed) {
                g.ui.animationClaimed = true;
                g.ui.revealAt = this.service.now() + this.videoDuration + 5000;
                send = true;
              }
            });
            game.ui = claimed.ui;
            if (send && fs.existsSync(video)) {
              await this.telegram.sendVideo(game.chatId, { source: video }, { caption: '🪙 Flipping the coin…' }).catch(() => {});
              const updated = await this.store.mutate(game.id, g => { g.ui.revealAt = this.service.now() + this.videoDuration; });
              game.ui = updated.ui;
            }
          }
          if (this.service.now() < (game.ui?.revealAt || 0)) text += '\n🪙 Flipping the coin…';
          else {
            const winner = [game.creator, game.challenger].find(p => p.userId === game.winnerId);
            const payment = payments.find(p => p.id === `prize:${game.id}`);
            text += `\nWinner: ${mention(winner)}\nPrize: ${escape(fromUnits(game.prize, game.token.decimals))} ${escape(game.token.symbol)}\nPayout: ${escape(payment?.status || 'PENDING')}`;
            if (payment?.signature) text += `\n${escape(this.explorer(payment.signature))}`;
          }
        }
        const renderKey = JSON.stringify([text, rows]);
        if (game.ui?.renderKey === renderKey) continue;
        try {
          let messageId = game.ui?.messageId;
          if (messageId) {
            try { await this.telegram.editMessageText(game.chatId, messageId, undefined, text, keyboard(rows)); }
            catch (error) {
              const description = error.response?.description || '';
              if (/message to edit not found|message can't be edited/i.test(description)) messageId = (await this.telegram.sendMessage(game.chatId, text, keyboard(rows))).message_id;
              else if (!/message is not modified/i.test(description)) throw error;
            }
          }
          else messageId = (await this.telegram.sendMessage(game.chatId, text, keyboard(rows))).message_id;
          const terminal = game.status !== 'OPEN' && (game.status !== 'SETTLED' || this.service.now() >= (game.ui?.revealAt || 0)) && (game.status === 'CANCELLED' ? payments.every(p => p.status === 'CONFIRMED') : payments.some(p => p.id === `prize:${game.id}` && p.status === 'CONFIRMED'));
          await this.store.mutate(game.id, g => { g.ui ||= {}; Object.assign(g.ui, { messageId, renderKey, terminal }); });
        } catch (_) { console.error('GROUP_CARD_RETRY: game record retained.'); }
      }
    } finally { this.rendering = false; }
  }
}
module.exports = { SolanaInterface, escape, paymentURI, networkName };
