# Solana restoration review: original-style menus and default SID

This branch restores the group/private coin-flip flow for native SOL and supported custom Solana tokens. On mainnet, **SOL and SID are automatically listed for every account**, including existing accounts, without individual imports. SID is identified only by mint `5w3wVdJaESaJKyLmStM6Hv9UyUkmZ1b9DLQquAqqpump`, not by its ticker. Read-only mainnet verification found the Token-2022 mint, 6 decimals and descriptive MetadataPointer/TokenMetadata extensions. A different asset called SID does not inherit this label. Mainnet SID is deliberately absent from devnet menus.

**Solana-only operation is the current scope.** Paxeer is deferred and is not a launch dependency. `SOLANA_HOLDER_REWARDS=deferred` is the default: every game still allocates 90% to the winner, 5% to a burn and 5% to a reserved holder pool in its original Solana asset. There are no Paxeer RPC calls, active holder registrations or new holder distributions in this mode. Without separate custody, pools remain treasury liabilities. With a configured holder wallet, the 5% is queued for transfer there and becomes a recorded reserve only after finality. It is never operator income or a completed distribution to holders. The fee screen states this clearly.

This is source publication, not proof of a live launch. Recovery remains the default; actual Telegram/wallet deposits, refunds, payouts and burns still need deployment validation. No private signing credentials or actual blockchain transactions were used during implementation. A future owner-created Solana FLIP mint could replace Paxeer eligibility, but no such mint is configured and no migration of existing holders is assumed.

## Restored player flow

1. `/start` opens a private dashboard with Wallets, My Stats, Start Flip, Profit Share, My Tokens and Help.
2. `/wallet` saves separate public sending and receiving wallets. The bot never requests a player's private key. A game snapshots both addresses; later profile edits affect future games. The shared bot wallet cannot be registered as a player.
3. Use `/flip` in the group. A user-owned, expiring Start in DM link opens token selection and wager entry. Missing wallets are collected first. Only one open interface game per group is admitted atomically.
4. Choose a featured token, a saved custom mint or enter a new mint. Custom tokens are checked on the configured network. Favorites can be removed; featured SOL/SID remain. Long menus are paginated.
5. Type the wager amount in Telegram first. The next screen supplies copy buttons for the deposit address, exact amount and optional game memo. Transfer exactly that wager from the registered sending wallet, or use the supplied memo-preserving Solana Pay request. If `PUBLIC_BASE_URL=https://...` or `RAILWAY_PUBLIC_DOMAIN` is available, Open Deposit provides a mobile payment page with no external scripts or access to keys. Closed, expired and already funded requests refuse to open a new payment. Check your wallet's selected network, amount, recipient and memo before authorizing; compatibility still needs real testing.
6. Tap Confirm Deposit after transferring. Registered source wallets are also scanned automatically. Confirmation replays the request window past a previously advanced cursor without moving that cursor. A direct signed transfer must prove its sender, recipient, mint/program and ownership. A memo-free receipt additionally needs an exact amount, a non-null finalized timestamp and one unique historical request. Closed/funded overlapping requests remain candidates, so they cannot be ignored to claim a different game. A wrong memo never falls back to memo-free matching. Missing/ambiguous matches require review. A diagnostic `/soldeposit GAME_ID SIGNATURE` remains available for manual proof recovery.
7. For new v2 games, the group challenge is published only after creator funding and the creator taps Confirm Deposit. Before that, the deposit instructions remain private. Legacy already-published cards continue receiving updates. The group card offers Accept Challenge. A second player privately reviews the wager and accepts or declines. An atomic join admits only one challenger. The creator must fund within 3 minutes, the funded offer stays open for 4 minutes, then the challenger has 3 minutes to deposit.
8. Both exact deposits commit one cryptographic result and a durable prize obligation. The coin video plays before the group result is revealed. Group/status messages distinguish a committed result, pending payment, confirmed payment and REVIEW. The winner's saved receiving wallet gets the prize; refunds go to the verified sending wallet.
9. Creator cancellation or expiry refunds recorded deposits. Wrong amounts, extra deposits, late transfers and attributable transfers of a different **supported** mint are refunded in full in the actual asset. Unsupported/ambiguous transfers are retained for review rather than guessed. Expired games' source addresses remain watched for late payments.
10. `/stats`, `/leaderboard` and `/shame` report results. Token values are never added across different mints, and allocated prizes are labeled separately from finalized payments.

Legacy command-only `/solflip` and `/soljoin` cannot bypass the restored flow in this runtime. `/solhelp`, `/soltoken`, `/soltokens`, `/soldeposit`, `/solstatus` and `/solcancel` remain diagnostic helpers. The old EVM runtime is a separate selection, not a simultaneously repaired second network.

## Supported tokens and deposit verification

Standard SPL Token and Token-2022 mints with only supported descriptive extensions are accepted. Token-2022 ATA derivation and transfer instructions use the mint's actual token program. Transfer-fee, transfer-hook, permanent-delegate, pausing, interest/scaled-amount and unknown extensions are rejected. This supports the verified SID mint without treating arbitrary Token-2022 behavior as equivalent.

Amounts use integer token units. A deposit requires a successful finalized transaction, registered-wallet signature and one direct top-level transfer. The exact memo identifies the game, or a memo-free transfer must uniquely match a historical request by wallet, asset, exact amount and the frozen deposit window. Transactions timestamped before the request, missing timestamps, and legacy challenger requests with unknown join times cannot authorize memo-free credit. Candidate matching is repeated inside the receipt transaction. Wrong-amount or wrong-token transfers without an attributable memo require review rather than automatic guessing. SPL deposits require `transferChecked` into the shared wallet's canonical ATA, with matching pre/post token owners and mint. Swaps, exchange withdrawals, multisigs, CPI/unchecked routes and unsupported layouts require investigation. Deterministic rejected proofs are recorded for review and do not block later deposits. RPC/database failures retain the scanner cursor for replay.

The shared address is `6izojQcvjazUDZ4jckAnFn15i8fDRkNb4J9NnTpTVBkY`. Matching private signing credentials belong only in Railway Variables. The public address alone cannot pay anyone. Native SOL credits that address; tokens credit its program-specific ATA. Payout fees and ATA rent come from an independently funded SOL reserve, never from reduced prizes/refunds.

## Economics and remaining mainnet work

The split is 90% prize, 5% FLIP-holder rewards and 5% burn, for native SOL and supported custom tokens. Integer rounding remainder goes to the winner. Settlement atomically records the unique per-game fee accrual, either credits the treasury holder pool or queues the separate-wallet transfer, and queues the burn alongside the prize. Replayed deposits and restarts cannot accrue the same fee twice. Prior explicitly retained devnet fee allocations are backfilled idempotently without resending prizes.

### Separate holder-rewards wallet

Set `SOLANA_HOLDER_WALLET_ADDRESS` to a distinct, on-curve Solana wallet you control, keeping `SOLANA_HOLDER_REWARDS=deferred`. This is an explicit opt-in; existing deployments without the variable keep their treasury-pool behavior. The first enabled startup binds that address to the ledger. Removing or changing it later refuses startup instead of silently moving custody. Migration/rotation needs separate reconciliation.

Each settlement queues one `holder-reserve` transfer for exactly the 5% allocation in the original wager asset, including supported custom SPL/Token-2022 mints. Only the treasury signer is needed to send into this wallet; no holder-wallet private key is loaded. Token transfers create the correct program-specific recipient ATA idempotently, paid by the independently funded treasury fee float. Existing unallocated treasury pools are moved in bounded u64-sized chunks under a database lock. Already allocated holder payouts retain their original source and destination.

The transfer uses the durable payment outbox: signed bytes are committed before broadcast; retries use those exact bytes. Unknown, failed or expired transactions are never automatically replaced. Pending/review transfers still count against treasury solvency. A first finalized confirmation atomically removes the treasury obligation and credits `SolHolderReserves`; concurrent confirmation/recheck cannot credit twice. This table records custody reserves, not rewards paid to individual holders. Amounts remain decimal strings through database JSON output, including amounts above JavaScript's safe integer limit.

Profit Share shows the public custody wallet, recent transfer statuses and recorded finalized reserves separately from any unqueued treasury pool. Game Status includes per-game custody transfers. Private `/solaudit` checks the separate wallet's actual finalized SOL and token-ATA balances against every recorded reserve, in addition to treasury liabilities. Ledger totals do not imply that later manual withdrawals remain covered. No rewards-wallet private key is needed for this read-only audit.

Automatic holder distributions remain deferred. They will require the separate wallet's matching key entered privately in the host, a SOL fee float in that wallet, exact reward-token eligibility, and a payout worker that debits these custody reserves atomically. Adding a key alone does not enable this future feature. Do not place any real key in this repository or send it through chat.

SOL burns use the official `1nc1nerator11111111111111111111111111111111` address. Standard SPL and supported Token-2022 burns use `BurnChecked` against the shared wallet's canonical token account and the mint's actual token program. This reduces mint supply rather than transferring tokens to an arbitrary inaccessible account. Queued, signed, confirmed and review states are shown distinctly. No actual burn is claimed by source tests.

The deferred legacy holder implementation, available only if explicitly selected with `SOLANA_HOLDER_REWARDS=paxeer`, uses **Paxeer EVM FLIP**, contract `0x2aA5968F710080ea453e7e09E59d769E8C470fac`, to allocate rewards in each Solana wager asset. A user must link an EVM holding wallet to their Solana reward wallet under Profit Share. An expiring `personal_sign` proof binds the Telegram user, EVM address, exact Solana recipient, treasury, network and nonce. It authorizes no spending. Open the HTTPS verification link inside an EVM wallet's browser, or sign the exact message separately and paste its signature. EOA signatures are supported; contract-wallet signature validation is not implemented. Each EVM address can be registered once globally. Later edits in the Wallet menu do not redirect verified rewards; changing the reward recipient requires a new holding-wallet signature.

In that optional Paxeer mode, daily UTC allocation (with startup/retry catchup) uses integer arithmetic and one finalized EVM block hash for total supply, every exclusion and registered balances. The denominator is total FLIP supply minus zero/burn/FLIP-contract/exchange and configured bot/dev/additional excluded holdings. It is not the sum of registered balances. The threshold is 0.001 units of the payout asset, rounded up to one atomic unit for low-decimal assets. Unregistered share and dust stay in the pool. A durable unique per-day/per-mint cycle debits only successfully enqueued holder obligations. Snapshot, allocation and registration failures preserve funds for retry. Slow holder RPC work runs separately from the deposit scanner and does not hold pool rows during network reads.

Before signing any new transaction, the worker checks treasury coverage for all recorded open deposits, unallocated fee pools and unresolved outbox obligations, plus an independent 0.01 SOL reserve. Fund additional SOL above that reserve for fees and ATA rent. This is a ledger coverage check against the configured RPC, not a proof of unrestricted on-chain solvency or an independent treasury audit.

Private administrators listed in `ADMIN_IDS` can use `/solaudit` to inspect liabilities/coverage and review payments, and `/solrecheck PAYMENT_ID` to query the original signed transaction. Recheck can mark a payment confirmed only on finalized proof; it never resends or creates replacement transactions. Unknown, failed and expired payments remain for reconciliation. Replacement signing is deliberately not automatic. Back up the database before any manual financial repair.

**Paxeer work is deferred, not a Solana launch blocker.** Three current official Paxeer endpoints returned no contract at the original FLIP address, and the old RPC failed. That only prevents activating the optional legacy Paxeer reward mode. Default Solana games require neither this RPC nor an EVM key, and keep holder fees reserved for a separately configured reward program. The inactive verification page is unavailable and stale registration callbacks cannot re-enable it.

A new Solana FLIP token would be a distinct mint and would require exact-mint validation, ownership-safe reward registration and a supported supply/eligibility calculation before distributions are activated. Its name or ticker alone is insufficient, and existing Paxeer balances do not automatically become Solana balances. Token creation or migration is not performed by this bot update.

Actual Telegram, Solana Pay and wallet deposits/payouts still require end-to-end deployment verification. The legacy EVM runtime remains a separate, unrepaired selection, not a simultaneously restored second network.

## Deployment and persistence

For phone-only hosting steps see [PHONE-SETUP.md](PHONE-SETUP.md). Use `npm start` as the Railway start command. Recovery (`BOT_MODE=recovery`, `LIVE_FUNDS_ENABLED=false`) imports no Telegram, game, wallet or database runtime.

The devnet runtime requires explicit `BOT_CHAIN=solana`, `SOLANA_CLUSTER=devnet`, a matching devnet RPC, private Telegram/signing variables and both live-mode switches. Here the switches permit test transactions. Mainnet additionally requires `SOLANA_CLUSTER=mainnet-beta`, a matching Solana mainnet RPC, a separate ledger and `SOLANA_HOLDER_REWARDS=deferred`. No Paxeer variables are needed. Only the explicitly selected optional `paxeer` reward mode requires HTTPS `FLIP_HOLDER_RPC_URL` and verifies Paxeer chain 125, the exact original FLIP contract and finalized supply/exclusions before polling Telegram. A failure in that optional mode stops launch with a sanitized diagnostic. If the same Telegram token is used, the old service must remain stopped. Existing webhooks cause startup refusal and are not silently deleted.

Fresh initialization remains an explicit operation for an empty database only. Runtime verifies the financial schema, binds genesis and shared-wallet identity, and adds separate profile/session/draft/scanner/review/fee tables without resetting financial rows. An occupied devnet ledger cannot be relabeled mainnet or rebound to another signing wallet. Existing unbound pilot records can only adopt devnet with their original shared wallet. Use separate storage for a future mainnet ledger.

The payment outbox commits signed bytes/signature before any broadcast. Ambiguous sends retry those same bytes, including after restart. Failed/expired uncertain payments enter REVIEW and are never automatically re-signed. Preserve backups: the ledger prevents repeated deposits and duplicate payments. Cancellation/settlement are row-locked and receipts globally unique. The singleton PostgreSQL advisory lock stays held through worker shutdown.

The draw uses Node's cryptographic RNG with no player-verifiable commit/reveal proof. Token issuers/liquidity and independent RPC agreement have not been audited. A custom mint being supported does not establish its value.

## Validation

`npm ci --ignore-scripts` then `npm test -- --runInBand`. Set `SOLANA_TEST_DATABASE_URL` to a disposable local PostgreSQL server for actual concurrency, restart, profile/network-binding and complete offline button-flow tests. Integration tests refuse remote hosts and isolate/drop their own schema. SID account-layout and Token-2022 instruction fixtures were checked against the official SPL SDK without adding that SDK as a production dependency. Payment-page tests use a real local HTTP server; chain/Telegram traffic remains simulated.

Burn wire formats were compared with the published `@solana/spl-token` SDK definitions; native SOL incinerator semantics come from Solana's SDK source. Fee tests include actual local PostgreSQL settlement/rollback, holder proof replay/uniqueness, daily allocation races, RPC failures, dust carryover, destination changes, retained-fee backfill, liabilities and read-only reconciliation. No production signing keys or blockchain sends are used by these tests.


### Recording a manual token refund

A private administrator can preview an already-finalized manual return with
`/solrefundsync ORIGINAL_DEPOSIT_SIGNATURE MANUAL_RETURN_SIGNATURE`. Review the
returned amount, original sender and remaining refund, then repeat the command
with `CONFIRM` appended to record it. The command never sends a transaction.
It supports a recorded deposit in a cancelled game, with all refund components
still pending and unsigned, and a plain direct token return from the same
treasury to the original sender's associated token account. Native SOL, mixed
instructions, signed/uncertain refunds and returns exceeding the pending
obligation require separate review.

The repair verifies the original deposit and exact finalized token movement,
keeps an audit record of every original payment and allocation, and leaves any
unreturned remainder queued. The same return cannot be counted for another
deposit. Repeating a successful command is safe even if the remaining refund
has since been signed. It shares the payment worker's exclusion and commits
all allocations atomically. Run `/solaudit` afterwards; other unresolved
obligations remain reserved. A successful accounting repair does not prove
that remaining refunds have finalized.

### Expired token burn recovery

Private owner-only `/solburnrecover GAME_ID` checks the exact original signed SPL/Token-2022 burn. A negative signature lookup alone is insufficient. Recovery requires all 151 finalized blocks in the signed blockhash validity window, contiguous parent hashes/heights, the original blockhash, a confirmed same-game anchor, expired-blockhash proof and absent historical receipts. Missing/pruned blocks, RPC errors, an original signature in any block, changed records, insufficient coverage or disabled funds leave the burn unchanged. The history job runs outside Telegram polling and the payment worker, with bounded rate-limit backoff.

After a successful read-only preview, `/solburnrecover GAME_ID CONFIRM` archives original signed bytes and block evidence atomically, then resets only that existing burn to pending for the normal guarded payment worker. It does not resend prizes or holder fees, erase liabilities or mark an unpaid burn confirmed. Repeated confirmation cannot queue a second replacement. The cached evidence is discarded on restart; verification must then run again. One recovery is allowed per burn; another expiry requires separate review. Use `/solstatus GAME_ID` to verify the replacement signature has finalized.
