const { fromUnits } = require('./amounts');
const { tokensForUser } = require('./featured');
function args(ctx) { return ctx.message.text.trim().split(/\s+/).slice(1); }
function depositInstructions(game, member, address) {
  const mainnet = game.cluster === 'mainnet-beta';
  const amount = fromUnits(game.wager, game.token.decimals);
  const params = new URLSearchParams({ amount, memo: member.memo, label: 'Coin Flip' });
  if (game.token.address !== 'NATIVE') params.set('spl-token', game.token.address);
  return `${mainnet ? 'SOLANA MAINNET. Real funds.' : 'DEVNET ONLY. Test coins.'}\nGame: ${game.id}\n` +
    `Send exactly ${amount} ${game.token.symbol} from ${member.wallet}\n` +
    `Shared recipient: ${address}\nMint: ${game.token.address}\nMemo (required): ${member.memo}\n` +
    `Solana Pay URI: solana:${address}?${params}\n` +
    `Then /soldeposit ${game.id} TRANSACTION_SIGNATURE\n` +
    'Winner receives 90% of the pool (integer rounding remainder included). 5% enters the FLIP-holder pool and 5% is queued for burn. Payout goes to the game’s saved receiving wallet; refunds return to the sending wallet. Expires in 15 minutes; late payments must still be submitted for refund.';
}
function registerSolanaCommands(bot, service, { includeStart = true, allowLegacyGames = true } = {}) {
  const command = (name, handler) => bot.command(name, async ctx => {
    try { await handler(ctx, args(ctx)); }
    catch (_) { await ctx.reply('Could not complete that command. Check the arguments, game state, registered wallet, exact mint, amount, memo and finalized signature. No replacement payout was created. Use /solhelp.'); }
  });
  if (includeStart) command('start', ctx => ctx.reply('Solana devnet pilot. Use /solhelp. Real funds are disabled.'));
  command('solhelp', ctx => ctx.reply(
    '/soltoken MINT (save a supported custom token)\n/soltokens (saved tokens)\n' +
    '/solflip SOL_OR_MINT AMOUNT SENDING_WALLET\n/soljoin GAME_ID SENDING_WALLET\n' +
    '/soldeposit GAME_ID TRANSACTION_SIGNATURE\n/solcancel GAME_ID\n/solstatus GAME_ID\n' +
    'Send one direct transfer with the required memo, using your registered wallet on the configured network. A custom token is identified by its mint address, never its name. Standard SPL and descriptive-extension Token-2022 mints are supported; fee/hook/delegate extensions are rejected. Game results use a cryptographic random draw, without a verifiable commit/reveal proof.'));
  command('soltoken', async (ctx, [mint]) => {
    const token = await service.chain.tokenInfo(mint);
    await service.store.saveToken(String(ctx.from.id), token);
    await ctx.reply(`Saved ${token.symbol}\nMint: ${token.address}\nDecimals: ${token.decimals}\nUse /solflip ${token.address} AMOUNT SENDING_WALLET`);
  });
  command('soltokens', async ctx => {
    const tokens = tokensForUser(await service.store.tokens(String(ctx.from.id)), service.chain.env?.SOLANA_CLUSTER);
    const lines = tokens.map(t => `${t.symbol}: ${t.address} (${t.decimals} decimals)`);
    // Telegram has a 4096-character limit. Send bounded chunks for large saved lists.
    for (let index = 0; index < Math.max(lines.length, 1); index += 20) await ctx.reply(lines.slice(index, index + 20).join('\n') || 'No saved custom tokens. Use /soltoken MINT.');
  });
  command('solflip', async (ctx, [mint, amount, wallet]) => {
    if (!allowLegacyGames) return ctx.reply('Use /flip in your group, then choose the token and wager in the private menu.');
    const game = await service.create({ userId: ctx.from.id, chatId: ctx.chat.id, mint, amount, wallet });
    await ctx.reply(depositInstructions(game, game.creator, service.chain.address));
    await ctx.reply(`Another player can join in this chat:\n/soljoin ${game.id} SENDING_WALLET`);
  });
  command('soljoin', async (ctx, [id, wallet]) => {
    if (!allowLegacyGames) return ctx.reply('Use the group challenge’s Accept Challenge button to review and join privately.');
    const game = await service.join({ id, wallet, userId: ctx.from.id, chatId: ctx.chat.id });
    await ctx.reply(depositInstructions(game, game.challenger, service.chain.address));
  });
  command('soldeposit', async (ctx, [id, signature]) => {
    const game = await service.deposit({ id, signature, userId: ctx.from.id });
    await ctx.reply(`Game ${id}: ${game.status}. ` + (game.winnerId ? `Winner Telegram ID: ${game.winnerId}. Payout queued; use /solstatus to check finality.` : 'Deposit processed. Wrong amounts, duplicate extra deposits and late payments are queued for full refund.'));
  });
  command('solcancel', async (ctx, [id]) => {
    await service.cancel({ id, userId: ctx.from.id, chatId: ctx.chat.id });
    await ctx.reply('Game cancelled. Recorded deposits are queued for full refund. Submit any unrecorded or late deposit signature with /soldeposit so it can be refunded.');
  });
  command('solstatus', async (ctx, [id]) => {
    const game = await service.store.get(id);
    if (game.chatId !== String(ctx.chat.id)) service.member(game, ctx.from.id);
    const payments = await service.store.payments(id);
    await ctx.reply(`Game ${id}: ${game.status}\nCreator funded: ${Boolean(game.creator.deposit)}\nChallenger funded: ${Boolean(game.challenger?.deposit)}\n` +
      (game.winnerId ? `Winner: ${game.winnerId}\nPrize: ${fromUnits(game.prize, game.token.decimals)}\nFee accounting: ${game.fees.status}; individual burn/payment confirmation below\n` : '') +
      payments.map(p => `${p.id.split(':')[0]}: ${p.status}${p.signature ? `\nhttps://explorer.solana.com/tx/${p.signature}${game.cluster === 'mainnet-beta' ? '' : '?cluster=devnet'}` : ''}`).join('\n'));
  });
  const isAdmin = ctx => ctx.chat.type === 'private' && (service.chain.env.ADMIN_IDS || '').split(',').map(s => s.trim()).filter(s => /^\d+$/.test(s)).includes(String(ctx.from.id));
  command('solaudit', async ctx => {
    if (!isAdmin(ctx)) return ctx.reply('Private administrator command.');
    const liabilities = await service.store.liabilities();
    let coverage = 'Verified: recorded liabilities and SOL reserve are covered.';
    try { await service.chain.assertSolvent(liabilities); } catch (_) { coverage = 'NOT VERIFIED: treasury balance/RPC/reserve needs review. New unsigned payments stay pending when coverage fails.'; }
    const reviews = (await service.store.pool.query('SELECT id,signed->>\'signature\' AS signature FROM "SolOutbox" WHERE status=\'REVIEW\' ORDER BY "createdAt" LIMIT 10')).rows;
    const custody = await service.store.holderCustody?.();
    let holderCoverage = '';
    if (custody) {
      let verified = 'Verified: holder wallet covers recorded finalized reserves.';
      try { await service.chain.assertHolderReserveCoverage(custody.wallet, custody.reserves); }
      catch (_) { verified = 'NOT VERIFIED: holder wallet balance/RPC needs review.'; }
      holderCoverage = `\n\nHolder wallet: ${custody.wallet}\n${verified}\nRecorded reserves (first 5, atomic units):\n${custody.reserves.slice(0, 5).map(p => `${p.mint}: ${p.amount}`).join('\n') || 'None'}\nHolder distributions remain deferred.`;
    }
    await ctx.reply(`Treasury: ${service.chain.address}\n${coverage}\nLiabilities (atomic units):\n${liabilities.map(p => `${p.mint}: ${p.amount}`).join('\n') || 'None'}${holderCoverage}\n\nReview payments (first 10):\n${reviews.map(p => `${p.id}\n${p.signature || 'No signed transaction'}`).join('\n') || 'None'}\nUse /solrecheck PAYMENT_ID to inspect the original signature. It never resends or creates a replacement.`);
  });
  command('solrecheck', async (ctx, [id]) => {
    if (!isAdmin(ctx)) return ctx.reply('Private administrator command.');
    const result = await service.recheckPayment(id);
    await ctx.reply(`${id}: ${result.status}\n${result.signature}\nOnly finalized proof can mark it confirmed. Unknown/failed signatures remain unresolved; no new transaction was created.`);
  });
}
module.exports = { registerSolanaCommands, depositInstructions };
