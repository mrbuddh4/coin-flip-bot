const { resultVisible } = require('./presentation');
const { fromUnits } = require('./amounts');
const { tokensForUser } = require('./featured');
const { traceDeposit } = require('./depositTrace');
const { MEMO } = require('./chain');
const { reconcileExternalRefund, RefundReconciliationError, refundFailure } = require('./refundReconciliation');
const { recoverExpiredBurn, BurnRecoveryError, boundedRead, burnRecoveryFailure } = require('./expiredBurn');
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
  command('depositcheck', async (ctx, [signature]) => {
    if (ctx.chat.type !== 'private') return ctx.reply('Use /depositcheck privately with the bot.');
    await ctx.reply(await traceDeposit(service, String(ctx.from.id), signature));
  });
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
    // A supplied proof bypasses unrelated wallet-history lookups, while the
    // service repeats sender, exact historical matching and receipt uniqueness.
    // Never treat a wrong/unsupported memo as a plain transfer.
    const transaction = await service.chain.connection.getParsedTransaction(signature, { commitment: 'finalized', maxSupportedTransactionVersion: 0 });
    if (!transaction) return ctx.reply('This payment is not finalized or is unavailable. No receipt was changed.');
    const noMemo = !transaction.transaction.message.instructions.some(i => i.programId.equals(MEMO));
    const game = await service.deposit({ id, signature, userId: ctx.from.id, transaction, noMemo });
    await ctx.reply(`Game ${id}: ${game.status}. ` + (game.winnerId && resultVisible(game) ? `Winner Telegram ID: ${game.winnerId}. Payout queued; use /solstatus to check finality.` : 'Deposit processed. Wrong amounts, duplicate extra deposits and late payments are queued for full refund.'));
  });
  command('solcancel', async (ctx, [id]) => {
    await service.cancel({ id, userId: ctx.from.id, chatId: ctx.chat.id });
    await ctx.reply('Game cancelled. Recorded deposits are queued for full refund. Submit any unrecorded or late deposit signature with /soldeposit so it can be refunded.');
  });
  command('solstatus', async (ctx, [id]) => {
    const game = await service.store.get(id);
    if (game.chatId !== String(ctx.chat.id)) service.member(game, ctx.from.id);
    if (game.status === 'SETTLED' && !resultVisible(game)) return ctx.reply('Both deposits are recorded. The flip animation plays before the winner and payment details are revealed.');
    const payments = await service.store.payments(id);
    await ctx.reply(`Game ${id}: ${game.status}\nCreator funded: ${Boolean(game.creator.deposit)}\nChallenger funded: ${Boolean(game.challenger?.deposit)}\n` +
      (game.winnerId ? `Winner: ${game.winnerId}\nPrize: ${fromUnits(game.prize, game.token.decimals)}\nFee accounting: ${game.fees.status}; individual burn/payment confirmation below\n` : '') +
      payments.map(p => `${p.id.split(':')[0]}: ${p.status}${p.lastError && p.status !== 'CONFIRMED' ? `\n${p.lastError.slice(0, 240)}` : ''}${p.signature ? `\nhttps://explorer.solana.com/tx/${p.signature}${game.cluster === 'mainnet-beta' ? '' : '?cluster=devnet'}` : ''}`).join('\n'));
  });
  const isAdmin = ctx => ctx.chat.type === 'private' && (service.chain.env.ADMIN_IDS || '').split(',').map(s => s.trim()).filter(s => /^\d+$/.test(s)).includes(String(ctx.from.id));
  command('solrefundsync', async (ctx, [depositSignature, returnSignature, confirmation]) => {
    if (!isAdmin(ctx)) return ctx.reply('Private administrator command.');
    try {
      const result = await reconcileExternalRefund(service, { depositSignature, returnSignature, adminId: ctx.from.id, commit: confirmation === 'CONFIRM' });
      const recorded = result.recorded || result.alreadyRecorded;
      await ctx.reply(`${recorded ? 'Manual refund recorded. No transaction was sent by this command.' : 'Manual refund preview. No records changed.'}\nGame: ${result.gameId}\nReturned: ${fromUnits(result.returnedAmount, result.token.decimals)} ${result.token.symbol}\nRemaining refund: ${fromUnits(result.remainingAmount, result.token.decimals)} ${result.token.symbol}\nReturn: ${returnSignature}\n${recorded ? 'Only the remaining amount stays queued. Run /solaudit and /solstatus to verify current coverage and finality.' : `To record this verified return:\n/solrefundsync ${depositSignature} ${returnSignature} CONFIRM`}`);
    } catch (error) {
      if (error instanceof RefundReconciliationError) return ctx.reply(error.message);
      const failure = refundFailure(error);
      console.error(`MANUAL_REFUND_RETRY: stage=${failure.stage}; reason=${failure.code}; original proof retained.`);
      await ctx.reply(`Manual return check: ${failure.code} at ${failure.stage}.\n${failure.reason}\nThis command sent no transaction. Repeating the original command cannot count the same return twice.`);
    }
  });
  command('solaudit', async ctx => {
    if (!isAdmin(ctx)) return ctx.reply('Private administrator command.');
    const liabilities = await service.store.liabilities();
    let coverage = 'Verified: recorded liabilities and SOL reserve are covered.';
    try { await service.chain.assertSolvent(liabilities); } catch (_) { coverage = 'NOT VERIFIED: treasury balance/RPC/reserve needs review. New unsigned payments stay pending when coverage fails.'; }
    const reviews = (await service.store.pool.query('SELECT id,signed->>\'signature\' AS signature FROM "SolOutbox" WHERE status=\'REVIEW\' ORDER BY "createdAt" LIMIT 10')).rows;
    const scanReviews = (await service.store.pool.query('SELECT signature FROM "SolScanReviews" ORDER BY "createdAt" DESC LIMIT 5')).rows;
    const custody = await service.store.holderCustody?.();
    let holderCoverage = '';
    if (custody) {
      let verified = 'Verified: holder wallet covers recorded finalized reserves.';
      try { await service.chain.assertHolderReserveCoverage(custody.wallet, custody.reserves); }
      catch (_) { verified = 'NOT VERIFIED: holder wallet balance/RPC needs review.'; }
      holderCoverage = `\n\nHolder wallet: ${custody.wallet}\n${verified}\nRecorded reserves (first 5, atomic units):\n${custody.reserves.slice(0, 5).map(p => `${p.mint}: ${p.amount}`).join('\n') || 'None'}\nHolder distributions remain deferred.`;
    }
    await ctx.reply(`Treasury: ${service.chain.address}\n${coverage}\nLiabilities (atomic units):\n${liabilities.map(p => `${p.mint}: ${p.amount}`).join('\n') || 'None'}${holderCoverage}\n\nReview payments (first 10):\n${reviews.map(p => `${p.id}\n${p.signature || 'No signed transaction'}`).join('\n') || 'None'}\nUse /solrecheck PAYMENT_ID to inspect the original signature. It never resends or creates a replacement.\n\nUnsupported transaction versions saved for review (latest 5):\n${scanReviews.map(r => r.signature).join('\n') || 'None'}\nThese have not been credited as deposits. Other supported receipts continue normally.`);
  });
  command('solrecheck', async (ctx, [id]) => {
    if (!isAdmin(ctx)) return ctx.reply('Private administrator command.');
    const result = await service.recheckPayment(id);
    await ctx.reply(`${id}: ${result.status}\n${result.signature}\nOnly finalized proof can mark it confirmed. Unknown/failed signatures remain unresolved; no new transaction was created.`);
  });
  command('solburnstatus', async ctx => {
    if (!isAdmin(ctx)) return ctx.reply('Private administrator command.');
    const status = service.expiredBurnStatus;
    if (!status) return ctx.reply('No burn history result is recorded in this running deployment. A restart clears in-memory checks and previews. This does not establish whether a payment completed. Use /solstatus GAME_ID for the payment record.');
    await ctx.reply(`${status.text}\n\nCheck started: ${status.startedAt}\nLast update: ${status.updatedAt}\n${service.expiredBurnJob ? 'History check is running.' : 'History check has stopped.'}`);
  });
  command('solburnrecover', async (ctx, [gameId, confirmation]) => {
    if (!isAdmin(ctx)) return ctx.reply('Private administrator command.');
    if (confirmation && confirmation !== 'CONFIRM') return ctx.reply('Use the game ID alone for a read-only preview, or add CONFIRM to authorize the verified burn retry.');
    if (service.expiredBurnJob) return ctx.reply('A burn history check is already running. Use /solburnstatus for its latest progress. Other bot functions remain available.');
    service.expiredBurnJob = { starting: true };
    service.expiredBurnStatus = { gameId, startedAt: new Date().toISOString(), updatedAt: new Date().toISOString(), text: 'Starting the original burn history check. No replacement has been queued.' };
    let message;
    try { message = await ctx.reply('Checking the original burn against every finalized block in its validity window. No transaction has been sent.'); }
    catch (error) { service.expiredBurnJob = null; throw error; }
    const update = async (text, terminal = false) => {
      // Save the result BEFORE delivery, so /solburnstatus can recover a failed edit.
      Object.assign(service.expiredBurnStatus, { text, updatedAt: new Date().toISOString() });
      try {
        await boundedRead(() => ctx.telegram.editMessageText(ctx.chat.id, message.message_id, undefined, text), 7000);
        return;
      } catch (error) {
        if (/message is not modified/i.test(String(error?.description || error?.message))) return;
      }
      if (!terminal) return;
      try { await boundedRead(() => ctx.reply(text), 7000); }
      catch (_) { console.error('BURN_RECOVERY_NOTIFICATION_FAILED: result retained for /solburnstatus.'); }
    };
    // Do not hold Telegram polling or the payment worker while fetching history.
    service.expiredBurnJob = recoverExpiredBurn(service, {
      gameId, adminId: String(ctx.from.id), commit: confirmation === 'CONFIRM',
      progress: (count, total, stage) => update(`Checking finalized burn history: ${count}/${total} blocks. ${stage || ''}\nNo replacement has been queued.`),
    }).then(async result => {
      if (result.alreadyRecorded) return update('This burn recovery was already recorded. No additional replacement was queued. Use /solstatus ' + gameId, true);
      if (result.recorded) return update('The original signed burn and complete history evidence were archived. The same burn obligation is queued for one retry through the normal payment worker. No prize or holder payment was changed.\nUse /solstatus ' + gameId + ' to verify finality.', true);
      await update(`Read-only check passed: the original burn is absent from all 151 finalized blocks in its signed validity window. Its blockhash is expired.\nOriginal: ${result.originalSignature}\nBurn: ${fromUnits(result.amount, result.token.decimals)} ${result.token.symbol}\nMint: ${result.token.address}\nNo records changed and no transaction was sent.\nTo queue this burn once:\n/solburnrecover ${gameId} CONFIRM`, true);
    }).catch(async error => {
      const failure = burnRecoveryFailure(error);
      console.error(`BURN_RECOVERY_STOPPED: stage=${failure.stage}; reason=${failure.code}; queueOutcome=${failure.outcomeUnknown ? 'unverified' : 'not-queued'}.`);
      const reason = error instanceof BurnRecoveryError ? error.message : failure.reason;
      await update(`Burn recovery stopped at ${failure.stage}: ${failure.code}.\n${reason}\n${failure.outcomeUnknown ? 'The database confirmation was interrupted; queue outcome is not verified. Use /solstatus ' + gameId + ' before any further action. Do not send a manual burn.' : 'No replacement was queued. The original burn and its reserved funds remain unchanged. A failed confirmation does not erase a verified preview in this running deployment.'}`, true);
    }).finally(() => { service.expiredBurnJob = null; });
  });
}
module.exports = { registerSolanaCommands, depositInstructions };
