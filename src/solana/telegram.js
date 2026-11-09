const { fromUnits } = require('./amounts');
function args(ctx) { return ctx.message.text.trim().split(/\s+/).slice(1); }
function depositInstructions(game, member, address) {
  const amount = fromUnits(game.wager, game.token.decimals);
  const params = new URLSearchParams({ amount, memo: member.memo, label: 'Coin flip devnet test' });
  if (game.token.address !== 'NATIVE') params.set('spl-token', game.token.address);
  return `DEVNET ONLY. No real SOL or tokens.\nGame: ${game.id}\n` +
    `Send exactly ${amount} ${game.token.symbol} from ${member.wallet}\n` +
    `Shared recipient: ${address}\nMint: ${game.token.address}\nMemo (required): ${member.memo}\n` +
    `Solana Pay URI: solana:${address}?${params}\n` +
    `Then /soldeposit ${game.id} TRANSACTION_SIGNATURE\n` +
    'Winner receives 90% of the pool (integer rounding remainder included). The other 10% is recorded and retained for now. Payout and refunds return to the sending wallet. Expires in 15 minutes; late payments must still be submitted for refund.';
}
function registerSolanaCommands(bot, service) {
  const command = (name, handler) => bot.command(name, async ctx => {
    try { await handler(ctx, args(ctx)); }
    catch (_) { await ctx.reply('Could not complete that command. Check the arguments, game state, devnet wallet, exact mint, amount, memo and finalized signature. No replacement payout was created. Use /solhelp.'); }
  });
  command('start', ctx => ctx.reply('Solana devnet pilot. Use /solhelp. Real funds are disabled.'));
  command('solhelp', ctx => ctx.reply(
    '/soltoken MINT (save custom standard SPL token)\n/soltokens (saved tokens)\n' +
    '/solflip SOL_OR_MINT AMOUNT SENDING_WALLET\n/soljoin GAME_ID SENDING_WALLET\n' +
    '/soldeposit GAME_ID TRANSACTION_SIGNATURE\n/solcancel GAME_ID\n/solstatus GAME_ID\n' +
    'Send one direct transfer with the required memo, using your devnet wallet. A custom token is identified by its mint address, never its name. Token-2022 is not supported. Game results use a cryptographic random draw, without a verifiable commit/reveal proof.'));
  command('soltoken', async (ctx, [mint]) => {
    const token = await service.chain.tokenInfo(mint);
    await service.store.saveToken(String(ctx.from.id), token);
    await ctx.reply(`Saved ${token.symbol}\nMint: ${token.address}\nDecimals: ${token.decimals}\nUse /solflip ${token.address} AMOUNT SENDING_WALLET`);
  });
  command('soltokens', async ctx => {
    const tokens = await service.store.tokens(String(ctx.from.id));
    const lines = tokens.map(t => `${t.symbol}: ${t.address} (${t.decimals} decimals)`);
    // Telegram has a 4096-character limit. Send bounded chunks for large saved lists.
    for (let index = 0; index < Math.max(lines.length, 1); index += 20) await ctx.reply(lines.slice(index, index + 20).join('\n') || 'No saved custom tokens. Use /soltoken MINT.');
  });
  command('solflip', async (ctx, [mint, amount, wallet]) => {
    const game = await service.create({ userId: ctx.from.id, chatId: ctx.chat.id, mint, amount, wallet });
    await ctx.reply(depositInstructions(game, game.creator, service.chain.address));
    await ctx.reply(`Another player can join in this chat:\n/soljoin ${game.id} SENDING_WALLET`);
  });
  command('soljoin', async (ctx, [id, wallet]) => {
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
      (game.winnerId ? `Winner: ${game.winnerId}\nPrize: ${fromUnits(game.prize, game.token.decimals)}\nFees: retained, not distributed/burned\n` : '') +
      payments.map(p => `${p.id.split(':')[0]}: ${p.status}${p.signature ? `\nhttps://explorer.solana.com/tx/${p.signature}?cluster=devnet` : ''}`).join('\n'));
  });
}
module.exports = { registerSolanaCommands, depositInstructions };
