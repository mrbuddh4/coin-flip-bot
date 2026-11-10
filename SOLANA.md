# Solana restoration review: original-style menus and default SID

This branch restores the group/private coin-flip flow for native SOL and supported custom Solana tokens. On mainnet, **SOL and SID are automatically listed for every account**, including existing accounts, without individual imports. SID is identified only by mint `5w3wVdJaESaJKyLmStM6Hv9UyUkmZ1b9DLQquAqqpump`, not by its ticker. Read-only mainnet verification found the Token-2022 mint, 6 decimals and descriptive MetadataPointer/TokenMetadata extensions. A different asset called SID does not inherit this label. Mainnet SID is deliberately absent from devnet menus.

**This is an implementation review, not a mainnet launch.** Runtime startup explicitly refuses mainnet wagers because the original holder-distribution/burn economics are incomplete. Recovery remains the default. No private signing credentials or actual Telegram/blockchain transactions were used during implementation. Offline and disposable PostgreSQL tests do not establish live wallet compatibility or operational readiness.

## Restored player flow

1. `/start` opens a private dashboard with Wallets, My Stats, Start Flip, Profit Share, My Tokens and Help.
2. `/wallet` saves separate public sending and receiving wallets. The bot never requests a player's private key. A game snapshots both addresses; later profile edits affect future games. The shared bot wallet cannot be registered as a player.
3. Use `/flip` in the group. A user-owned, expiring Start in DM link opens token selection and wager entry. Missing wallets are collected first. Only one open interface game per group is admitted atomically.
4. Choose a featured token, a saved custom mint or enter a new mint. Custom tokens are checked on the configured network. Favorites can be removed; featured SOL/SID remain. Long menus are paginated.
5. Deposit exactly the wager using the supplied Solana Pay request and exact game/participant memo. If `PUBLIC_BASE_URL=https://...` or `RAILWAY_PUBLIC_DOMAIN` is available, Open Deposit provides a mobile payment page with no external scripts or access to keys. Closed, expired and already funded requests refuse to open a new payment. Check your wallet's selected network, amount, recipient and memo before authorizing; compatibility still needs real testing.
6. Registered source wallets are scanned for finalized transactions automatically. I Sent the Deposit triggers an additional check. Only direct signed transfers with the exact memo, sender, recipient, mint/program and ownership are accepted. A diagnostic `/soldeposit GAME_ID SIGNATURE` remains available for manual proof recovery.
7. After creator funding, the group card offers Accept Challenge. A second player privately reviews the wager and accepts or declines. An atomic join admits only one challenger. The creator must fund within 3 minutes, the funded offer stays open for 4 minutes, then the challenger has 3 minutes to deposit.
8. Both exact deposits commit one cryptographic result and a durable prize obligation. The coin video plays before the group result is revealed. Group/status messages distinguish a committed result, pending payment, confirmed payment and REVIEW. The winner's saved receiving wallet gets the prize; refunds go to the verified sending wallet.
9. Creator cancellation or expiry refunds recorded deposits. Wrong amounts, extra deposits, late transfers and attributable transfers of a different **supported** mint are refunded in full in the actual asset. Unsupported/ambiguous transfers are retained for review rather than guessed. Expired games' source addresses remain watched for late payments.
10. `/stats`, `/leaderboard` and `/shame` report results. Token values are never added across different mints, and allocated prizes are labeled separately from finalized payments.

Legacy command-only `/solflip` and `/soljoin` cannot bypass the restored flow in this runtime. `/solhelp`, `/soltoken`, `/soltokens`, `/soldeposit`, `/solstatus` and `/solcancel` remain diagnostic helpers. The old EVM runtime is a separate selection, not a simultaneously repaired second network.

## Supported tokens and deposit verification

Standard SPL Token and Token-2022 mints with only supported descriptive extensions are accepted. Token-2022 ATA derivation and transfer instructions use the mint's actual token program. Transfer-fee, transfer-hook, permanent-delegate, pausing, interest/scaled-amount and unknown extensions are rejected. This supports the verified SID mint without treating arbitrary Token-2022 behavior as equivalent.

Amounts use integer token units. A deposit requires a successful finalized transaction, registered-wallet signature, exact memo and one direct top-level transfer. SPL deposits require `transferChecked` into the shared wallet's canonical ATA, with matching pre/post token owners and mint. Swaps, exchange withdrawals, multisigs, CPI/unchecked routes and unsupported layouts require investigation. Deterministic rejected proofs are recorded for review and do not block later deposits. RPC/database failures retain the scanner cursor for replay.

The shared address is `6izojQcvjazUDZ4jckAnFn15i8fDRkNb4J9NnTpTVBkY`. Matching private signing credentials belong only in Railway Variables. The public address alone cannot pay anyone. Native SOL credits that address; tokens credit its program-specific ATA. Payout fees and ATA rent come from an independently funded SOL reserve, never from reduced prizes/refunds.

## Economics and remaining mainnet work

The nominal split is 90% prize, 5% holder allocation and 5% burn allocation. Integer rounding remainder goes to the winner. **This review build records and retains both 5% allocations. It does not distribute to holders or burn.** The fee screen says so. The owner confirmed the same economics for Solana (m172): 90% winner, 5% FLIP-holder rewards and 5% burn for SOL and custom tokens. Distribution and burn implementation still need completion, so mainnet wagering remains closed in this review build; changing a network variable is insufficient.

The original EVM interface/economic intent has guided this restoration, but the legacy EVM financial audit issues, cross-network operation and holder program are not repaired by the new Solana module. There is no claim of complete production parity.

Before a mainnet release: implement the agreed fee policy, complete operational reconciliation for REVIEW payments and actual wallet/Telegram transaction tests, verify the private signer matches the shared wallet, establish RPC/fee-reserve readiness and verify deployed identity/single-instance behavior. No original database should be erased or relabeled as a different network.

## Deployment and persistence

For phone-only hosting steps see [PHONE-SETUP.md](PHONE-SETUP.md). Use `npm start` as the Railway start command. Recovery (`BOT_MODE=recovery`, `LIVE_FUNDS_ENABLED=false`) imports no Telegram, game, wallet or database runtime.

The devnet review runtime requires explicit `BOT_CHAIN=solana`, `SOLANA_CLUSTER=devnet`, a matching devnet RPC, private Telegram/signing variables and both live-mode switches. Here the switches permit test transactions; the explicit mainnet-readiness check still refuses mainnet. If the same Telegram token is used, the old service must remain stopped. Existing webhooks cause startup refusal and are not silently deleted.

Fresh initialization remains an explicit operation for an empty database only. Runtime verifies the financial schema, binds genesis and shared-wallet identity, and adds separate profile/session/draft/scanner/review tables without resetting financial rows. An occupied devnet ledger cannot be relabeled mainnet or rebound to another signing wallet. Existing unbound pilot records can only adopt devnet with their original shared wallet. Use separate storage for a future mainnet ledger.

The payment outbox commits signed bytes/signature before any broadcast. Ambiguous sends retry those same bytes, including after restart. Failed/expired uncertain payments enter REVIEW and are never automatically re-signed. Preserve backups: the ledger prevents repeated deposits and duplicate payments. Cancellation/settlement are row-locked and receipts globally unique. The singleton PostgreSQL advisory lock stays held through worker shutdown.

The draw uses Node's cryptographic RNG with no player-verifiable commit/reveal proof. Token issuers/liquidity, full solvency and independent RPC agreement have not been audited. A custom mint being supported does not establish its value.

## Validation

`npm ci --ignore-scripts` then `npm test -- --runInBand`. Set `SOLANA_TEST_DATABASE_URL` to a disposable local PostgreSQL server for actual concurrency, restart, profile/network-binding and complete offline button-flow tests. Integration tests refuse remote hosts and isolate/drop their own schema. SID account-layout and Token-2022 instruction fixtures were checked against the official SPL SDK without adding that SDK as a production dependency. Payment-page tests use a real local HTTP server; chain/Telegram traffic remains simulated.
