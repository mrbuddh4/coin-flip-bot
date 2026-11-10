const { randomUUID, randomInt, randomBytes } = require('node:crypto');
const { publicKey } = require('./chain');
const { toUnits, splitPool } = require('./amounts');
class SolanaService {
  constructor({ store, chain, now = () => Date.now(), coin = () => randomInt(2) }) {
    Object.assign(this, { store, chain, now, coin });
    this.workerRunning = false;
  }
  async create({ userId, chatId, wallet, mint, amount, receiveWallet = wallet, name, gameId, interfaceVersion }) {
    publicKey(wallet);
    publicKey(receiveWallet);
    if ([wallet, receiveWallet].includes(this.chain.address)) throw new Error('Use a player wallet distinct from the shared bot wallet');
    const token = await this.chain.tokenInfo(mint);
    const wager = toUnits(amount, token.decimals).toString();
    if (BigInt(wager) * 2n > 18446744073709551615n) throw new Error('Pool exceeds token amount range');
    // Native SOL JSON RPC amounts are numbers; reject unsafe large transfers rather than rounding.
    if (token.address === 'NATIVE' && BigInt(wager) * 2n > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('SOL wager too large');
    const id = gameId || randomUUID();
    return this.store.create({ id, chatId: String(chatId), token, wager, status: 'OPEN',
      depositAddress: this.chain.address, cluster: this.chain.env?.SOLANA_CLUSTER || 'devnet', createdAt: this.now(), expiresAt: this.now() + (interfaceVersion ? 3 : 15) * 60 * 1000,
      ...(interfaceVersion ? { interfaceVersion, ui: {} } : {}),
      creator: { userId: String(userId), wallet, receiveWallet, name, payToken: randomBytes(16).toString('hex'), memo: `coinflip:${id}:creator` }, challenger: null });
  }
  async join({ id, userId, wallet, chatId, receiveWallet = wallet, name }) {
    publicKey(wallet);
    publicKey(receiveWallet);
    if ([wallet, receiveWallet].includes(this.chain.address)) throw new Error('Use a player wallet distinct from the shared bot wallet');
    return this.store.mutate(id, async g => {
      if (g.chatId !== String(chatId)) throw new Error('Use the original game chat');
      if (g.status !== 'OPEN' || this.now() >= g.expiresAt) throw new Error('Game closed or expired');
      if (g.creator.userId === String(userId) || g.creator.wallet === wallet) throw new Error('A different player and sending wallet must join');
      if (g.challenger) throw new Error('Game already has a challenger');
      if (g.interfaceVersion && !g.creator.deposit) throw new Error('Creator has not funded this challenge');
      g.challenger = { userId: String(userId), wallet, receiveWallet, name, payToken: randomBytes(16).toString('hex'), memo: `coinflip:${id}:challenger` };
      if (g.interfaceVersion) g.expiresAt = this.now() + 3 * 60 * 1000;
    });
  }
  member(game, userId) {
    const member = [game.creator, game.challenger].find(p => p?.userId === String(userId));
    if (!member) throw new Error('You are not a player in this game');
    return member;
  }
  async refund(g, tx, member, receipt, mint = g.token.address) {
    await tx.enqueue({ id: `refund:${receipt.signature}`, gameId: g.id, mint, recipient: member.wallet, amount: receipt.amount, kind: 'refund', sourceWallet: g.depositAddress });
  }
  async cancelLocked(g, tx) {
    g.status = 'CANCELLED';
    for (const player of [g.creator, g.challenger]) if (player?.deposit) await this.refund(g, tx, player, player.deposit);
  }
  async deposit({ id, userId, signature, detectedMint, transaction }) {
    const snapshot = await this.store.get(id);
    const participant = this.member(snapshot, userId);
    if (snapshot.depositAddress !== this.chain.address) throw new Error('Game belongs to a different deposit wallet; reconcile before changing keys');
    const mint = detectedMint || snapshot.token.address;
    if (mint !== snapshot.token.address) await this.chain.tokenInfo(mint);
    const amount = await this.chain.verifyDeposit({ signature, sender: participant.wallet, mint, memo: participant.memo, transaction });
    return this.store.mutate(id, async (g, tx) => {
      const player = this.member(g, userId);
      if (!await tx.consume(signature, String(userId), amount.toString())) return;
      const receipt = { signature, amount: amount.toString() };
      if (mint !== g.token.address) { await this.refund(g, tx, player, receipt, mint); return; }
      if (g.status === 'OPEN' && this.now() >= g.expiresAt) await this.cancelLocked(g, tx);
      // Wrong amounts, second payments and late transfers are recorded and refunded in full.
      if (g.status !== 'OPEN' || player.deposit || amount !== BigInt(g.wager)) {
        await this.refund(g, tx, player, receipt);
        return;
      }
      player.deposit = receipt;
      if (g.interfaceVersion && !g.challenger && player === g.creator) g.expiresAt = this.now() + 4 * 60 * 1000;
      if (g.creator.deposit && g.challenger?.deposit) {
        const result = this.coin();
        if (result !== 0 && result !== 1) throw new Error('Invalid random result');
        const winner = result === 0 ? g.creator : g.challenger;
        const split = splitPool(g.wager);
        g.status = 'SETTLED'; // Economic result committed atomically with durable payout; chain state is separate.
        g.winnerId = winner.userId;
        g.fees = { holder: split.holderFee.toString(), burn: split.burnFee.toString(), status: 'ACCRUED' };
        g.prize = split.prize.toString();
        await tx.enqueue({ id: `prize:${id}`, gameId: id, mint: g.token.address, recipient: winner.receiveWallet || winner.wallet, amount: g.prize, kind: 'prize', sourceWallet: g.depositAddress });
        await tx.accrueFees(g, split);
      }
    });
  }
  async cancel({ id, userId, chatId }) {
    return this.store.mutate(id, async (g, tx) => {
      if (g.creator.userId !== String(userId) || g.chatId !== String(chatId)) throw new Error('Only the creator can cancel in the original chat');
      if (g.status === 'CANCELLED') return;
      if (g.status !== 'OPEN') throw new Error('Result already committed; cancellation is closed');
      await this.cancelLocked(g, tx);
    });
  }
  async expire() {
    for (const { id } of await this.store.unfinished()) await this.store.mutate(id, async (g, tx) => {
      if (g.status === 'OPEN' && this.now() >= g.expiresAt) await this.cancelLocked(g, tx);
    });
  }
  async recheckPayment(id) {
    const row = (await this.store.pool.query('SELECT payment,signed,status FROM "SolOutbox" WHERE id=$1', [id])).rows[0];
    if (!row?.signed || row.payment.sourceWallet !== this.chain.address) throw new Error('No matching signed payment to recheck');
    await this.chain.validate();
    if (await this.chain.paymentStatus(row.signed.signature) === 'finalized') await this.store.paymentState(id, 'CONFIRMED');
    // Unknown, failed and expired signatures never authorize a replacement.
    return (await this.store.pool.query('SELECT status,signed->>\'signature\' AS signature FROM "SolOutbox" WHERE id=$1', [id])).rows[0];
  }
  async work() {
    if (this.workerRunning) return;
    this.workerRunning = true;
    try {
      await this.expire();
      try {
        await this.store.queueHolderReserves?.(this.chain.address);
        this.custodyError = null;
      } catch (_) {
        // Retained-pool reconciliation must not starve already-signed payouts.
        this.custodyError = 'Retained holder fees need reconciliation; their funds remain reserved in the treasury.';
      }
      for (const item of await this.store.pendingPayments()) {
        let signed = item.signed;
        try {
          if (item.payment.sourceWallet !== this.chain.address) {
            await this.store.paymentState(item.id, 'REVIEW', 'Signing wallet changed; reconcile original wallet before payout');
            continue;
          }
          if (!signed) {
            // Reserve every recorded liability, including other games and
            // REVIEW transfers. Do not let fees consume player deposits.
            await this.chain.assertSolvent(await this.store.liabilities());
            signed = await this.chain.buildPayment(item.payment);
            await this.store.saveSigned(item.id, signed); // Commit before any network send.
          }
          const state = await this.chain.paymentStatus(signed.signature);
          if (state === 'finalized') { await this.store.paymentState(item.id, 'CONFIRMED'); continue; }
          if (state === 'failed') { await this.store.paymentState(item.id, 'REVIEW', 'On-chain transaction failed; manual reconciliation required'); continue; }
          const height = await this.chain.connection.getBlockHeight('finalized');
          if (height > signed.lastValidBlockHeight) {
            // RPC absence is not proof of no payout. Never auto-resign/retry with a new blockhash.
            await this.store.paymentState(item.id, 'REVIEW', 'Blockhash expired without finalized proof; reconcile exact signature before any replacement');
            continue;
          }
          await this.chain.broadcast(signed);
        } catch (_) {
          // Preserve signed payload on ambiguous send or RPC failures. Do not log private endpoint URLs.
          await this.store.paymentState(item.id, signed ? 'SIGNED' : 'PENDING', 'Payment check failed; original signed transaction retained if present');
        }
      }
    } finally { this.workerRunning = false; }
  }
}
module.exports = { SolanaService };
