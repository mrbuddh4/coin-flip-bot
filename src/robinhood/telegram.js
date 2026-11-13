const { resultVisible } = require('../solana/presentation');
function registerRobinhoodCommands(bot, service, env = process.env) {
  const isAdmin = ctx => ctx.chat.type === 'private' && (env.ADMIN_IDS || '').split(',').map(x => x.trim()).filter(Boolean).includes(String(ctx.from.id));
  const command = (name, fn) => bot.command(name, async ctx => {
    try { await fn(ctx, ctx.message.text.trim().split(/\s+/).slice(1)); }
    catch (_) { await ctx.reply('Robinhood check could not finish. Existing deposits and signed payments are preserved. No replacement transaction was created.'); }
  });
  command('rhstatus', async (ctx, [id]) => {
    const g = await service.store.get(id);
    if (g.chatId !== String(ctx.chat.id)) service.member(g, ctx.from.id);
    const payments = await service.store.payments(id);
    await ctx.reply(`Robinhood game ${id}: ${g.status === 'SETTLED' && !resultVisible(g) ? 'FLIPPING' : g.status}\nCreator funded: ${Boolean(g.creator.deposit)}\nChallenger funded: ${Boolean(g.challenger?.deposit)}\n` + payments.map(p => `${p.id.split(':')[0]}: ${p.status}${p.signature ? '\n' + service.chain.explorer(p.signature) : ''}`).join('\n'));
  });
  command('rhdeposit', async (ctx, [id, signature]) => {
    if (ctx.chat.type !== 'private') return ctx.reply('Use /rhdeposit GAME_ID TX_HASH privately.');
    const g = await service.store.get(id), player = service.member(g, ctx.from.id);
    const proof = await service.chain.receiptProof(signature);
    const tx = proof.tx;
    const mint = tx.to?.toLowerCase() === service.chain.address ? 'NATIVE' : tx.to?.toLowerCase();
    const transaction = { hash: signature.toLowerCase(), blockTime: proof.blockTime };
    const matches = await service.store.noMemoCandidates({ sender: player.wallet, mint, amount: '1', at: proof.blockTime * 1000 });
    if (matches.length === 1) await service.deposit({ id, userId: ctx.from.id, signature: signature.toLowerCase(), detectedMint: mint, transaction, noMemo: true });
    else {
      const amount = await service.chain.verifyDeposit({ signature, sender: player.wallet, mint, transaction });
      if (!await service.recoverUnmatchedDeposit({ sender: player.wallet, signature: signature.toLowerCase(), mint, amount: amount.toString(), transaction })) return ctx.reply('Payment has no unique historical request. It was not credited. Keep the original hash for review.');
    }
    await ctx.reply('Finalized deposit processed. Closed requests queue a refund; use Game Status for confirmation.');
  });
  command('rhaudit', async ctx => {
    if (!isAdmin(ctx)) return ctx.reply('Private administrator command.');
    const liabilities = await service.store.liabilities();
    let note = 'Verified: treasury covers recorded liabilities and the ETH gas reserve.';
    try { await service.chain.assertSolvent(liabilities); } catch (_) { note = 'NOT VERIFIED: review treasury balances, gas reserve and RPC. Unsigned payouts remain pending.'; }
    const custody = await service.store.holderCustody();
    await ctx.reply(`Robinhood treasury: ${service.chain.address}\n${note}\nLiabilities (atomic units):\n${liabilities.map(l => `${l.mint}: ${l.amount}`).join('\n') || 'None'}\nHolder wallet: ${custody?.wallet || 'Fees retained as treasury liabilities; distributions deferred.'}`);
  });
  command('rhrecheck', async (ctx, [id]) => {
    if (!isAdmin(ctx)) return ctx.reply('Private administrator command.');
    const r = await service.recheckPayment(id);
    await ctx.reply(`${id}: ${r.status}\n${r.signature}\nExact original hash checked. No replacement was created.`);
  });
}
module.exports = { registerRobinhoodCommands };
