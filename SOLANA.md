# SOL and custom Solana tokens: isolated devnet pilot

This recovery branch now includes native SOL and custom **standard SPL Token** games using a shared deposit/payout wallet. The owner-selected public address is `6izojQcvjazUDZ4jckAnFn15i8fDRkNb4J9NnTpTVBkY`. Its matching signing key must be entered privately into hosting variables, never GitHub, a document or chat. The address alone cannot sign payouts. The private key is not stored in this repository and has not been provided to the assistant.

This is a new, separate Solana ledger and command path. It is not a completed mainnet release or an automatic repair of legacy EVM settlement. The runtime selects EVM or Solana; simultaneous networks and the old animated/button interface have not been ported to this pilot. It does not connect to PaxPort. A fresh database does not recover historical Paxeer records. Owner reports no unpaid players and no significant remaining old funds, but that report is not an independent on-chain reconciliation.

## Fresh deployment and private setup

For an iPhone/iPad workflow without a terminal, use [PHONE-SETUP.md](PHONE-SETUP.md). Its optional Railway pre-deploy step initializes an explicitly empty devnet database; ordinary recovery deployments skip database access.

1. Use Node 24 and this recovery branch. Start with `BOT_MODE=recovery`, `LIVE_FUNDS_ENABLED=false`; `npm start` provides credential-free `/health`. Keep the original PaxLabs project untouched.
2. In an owner-controlled Railway workspace, use a **new, empty** PostgreSQL database and a separate **test** Telegram bot. No hosting has been provisioned by the assistant. Configure the private `DATABASE_URL` and `TELEGRAM_BOT_TOKEN` in Railway, not source control.
3. Set `BOT_CHAIN=solana`, `SOLANA_CLUSTER=devnet`, `SOLANA_RPC_URL=https://api.devnet.solana.com` or a trusted dedicated **devnet** endpoint. Set `SOLANA_WALLET_ADDRESS` to the owner-selected shared address above. Set its matching `SOLANA_PRIVATE_KEY` privately, as a base58-encoded 64-byte secret key or JSON array of 64 bytes. A seed phrase, EVM key or public address is not this key format. Do not change wallets while ledger liabilities exist.
4. Fund that same public address with **devnet** SOL from an official faucet for fees and ATA rent; keep at least 0.01 devnet SOL beyond player principal. A real mainnet token mint does not automatically exist on devnet. Use test mints created on devnet. The code checks the RPC genesis hash, not just the endpoint label, and refuses mainnet.
5. In the hosting console, run `SOLANA_INIT_FRESH=true npm run solana:init` once. This command refuses a database with existing public tables. Runtime startup verifies the pilot tables without automatic schema changes. Remove the initialization variable afterward.
6. Run `npm run preflight`. It reads aggregate database state, Telegram identity/webhook and chain/wallet configuration. Review privately. It does not reconcile funds or establish live readiness.
7. For the isolated devnet pilot only, set `BOT_MODE=live` and `LIVE_FUNDS_ENABLED=true`, then restart. Here these flags allow **test transactions**; the independent genesis check still blocks mainnet. One replica only. Do not use the production bot token. Existing webhooks cause startup refusal; it does not silently delete them. Old pending updates are retained.

## Commands and custom tokens

- `/solhelp`: help and supported scope.
- `/soltoken MINT`: validate and save a custom standard SPL token for your account; reads decimals from the exact mint.
- `/soltokens`: saved custom tokens.
- `/solflip SOL_OR_MINT AMOUNT SENDING_WALLET`: create a 15-minute game in the current chat. Another player uses `/soljoin GAME_ID SENDING_WALLET` in that chat.
- Follow the exact shared recipient, amount and **game/participant memo**. The supplied Solana Pay URI includes amount, memo and optional SPL mint; choose devnet in a compatible wallet. Compatibility must still be tested. The bot does not ask for player signing keys.
- `/soldeposit GAME_ID SIGNATURE`: submit your successful, finalized direct transfer. It must be signed by your registered source wallet, with exactly one top-level transfer and the correct memo. SPL uses `transferChecked`, the exact case-sensitive mint and the bot's canonical associated token account. Swaps, exchange withdrawals, multisigs, CPI transfer routes, Token-2022/fees/hooks and unchecked token transfers are unsupported. Unsupported transfers are not accepted as proof and need manual investigation, not an automatic refund guess.
- Once both exact deposits are recorded, one cryptographic random result and one payout obligation commit atomically. `/solstatus GAME_ID` reports the result separately from payout finality and links to the devnet explorer.
- `/solcancel GAME_ID`: creator can cancel before settlement. Restart-safe expiry cancels unpaid games. Recorded deposits receive full refunds; an unsubmitted or late deposit still needs its signature submitted. There is no automatic blockchain-wide deposit discovery.

The recipient is a **shared wallet**. Native SOL goes to that address. SPL token transfers credit the canonical ATA owned by it, as normal on Solana. Deposits and payouts use the same signing identity. Winnings and refunds return to the registered, on-chain-verified source wallet; a third-party payout address is not accepted.

## Payment handling and remaining scope

Amounts use integer lamports/token units end to end. Underpayments never receive a tolerance. Wrong amounts, extra valid deposits and late deposits are queued for full refund in the correct mint. A unique signature constraint and a game row lock prevent reuse and settle/cancel races. A memo separates concurrent games at the shared wallet.

Economics preserve the original nominal 90% prize / 5% holder allocation / 5% burn allocation, with integer rounding remainder assigned to the winner. **Both 5% allocations remain in the shared wallet and are recorded as retained, not distributed or burned.** No fee wallet, cross-chain holder distribution or burn is executed by this pilot. Those policies and implementation remain work before production parity. The bot pays transaction fees and account rent from its separate SOL reserve and never silently reduces prizes/refunds.

The outbox stores signed transaction bytes and signature before broadcasting. A timeout retries the **same bytes**, including after restart. Failed transactions, expired unresolved signatures and a changed source wallet require `REVIEW`; the worker never generates an automatic replacement payout. Review the exact signature and balances before any manual repair. Database backup and access control are essential because this state prevents duplicate payments.

The draw uses Node's cryptographic RNG; there is no player-verifiable commit/reveal proof. On-chain wallet holdings, token freeze/mint authorities, token liquidity, malicious issuers, independent RPC agreement and complete wallet solvency have not been audited. There is no claim that arbitrary custom tokens have monetary value.

## Validation

Run `npm ci --ignore-scripts` and `npm test -- --runInBand`. For the PostgreSQL concurrency/crash suite, set `SOLANA_TEST_DATABASE_URL` to a **disposable local** PostgreSQL server; tests isolate and drop their own schema. The suite refuses non-local database hosts. Tests cover exact SOL/SPL amounts, mint/owner/recipient/signature/memo/finality checks, independent SPL instruction vectors, payment gates, custom mint metadata, actual row-lock races, replay constraints, refunds, restart and ambiguous-send recovery.

Live Telegram conversations, wallet/Solana Pay compatibility, devnet mint issuance, real devnet transactions and Railway deployment still require a separate test run. No production credentials or blockchain transactions have been used during implementation. Existing legacy EVM accounting issues in the private assessment remain unresolved.
