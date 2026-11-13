# Robinhood Chain support

The same Telegram bot supports Solana plus Robinhood Chain (chain ID **4663**).
Select a network when starting `/flip` in a group, then continue in the bot's
private menu. ETH and the exact Robinhood SID contract are included for everyone:

`0x99f2f175df58e31d8f8368f11e2e2c7f8dbdc3f8` (18 decimals).

Use My Tokens to add and remove custom standard ERC-20 favorites. Contract
identity includes the chain. The Solana SID mint, Solana wallets, and existing
Solana financial history remain separate. A group has one active flip across
both chains. The first successful acceptance owns the challenger slot.

## Phone setup on the existing Railway service

The source is inert for Robinhood while `BOT_CHAIN=solana` remains set. No wallet
is generated, imported from the arbitrage project, or selected automatically.
Keep the existing database and all Solana settings. **Do not use any fresh-Solana
initialization flags or reset the database.**

Before switching modes, finish current flips. In Railway private Variables set:

- `ROBINHOOD_RPC_URL`: Robinhood Chain RPC, verified against chain ID 4663.
- `ROBINHOOD_WALLET_ADDRESS`: the owner's designated Robinhood game treasury.
- `ROBINHOOD_PRIVATE_KEY`: the matching dedicated treasury private key. Enter
  only in Railway, never in Telegram, the repository, screenshots, or chat.
- `ROBINHOOD_HOLDER_WALLET_ADDRESS`: optional separate Robinhood holder-fee vault.
  Without it the 5% is retained as a treasury liability. Once bound, the vault
  cannot silently be changed or removed. Holder distributions remain deferred.
- `ROBINHOOD_CONFIRMATION_MODE=l2` for fast gameplay, or `finalized` for full
  Ethereum finality. An omitted setting selects **finalized**, conservatively.
- `ROBINHOOD_CONFIRMATION_BLOCKS=20` for fast mode (minimum 20).
- `ROBINHOOD_GAS_RESERVE_ETH=0.001` default independent gas reserve. Fund the
  treasury with enough ETH for this reserve plus transfers, even for SID games.
- Keep `SOLANA_HOLDER_REWARDS=deferred` and the existing owner-only `ADMIN_IDS`.

After the values are entered and the dedicated wallet is funded, set
`BOT_CHAIN=multi`. Keep the existing `BOT_MODE=live`, `LIVE_FUNDS_ENABLED=true`,
Telegram token, database reference, and start/predeploy commands. Redeploy once.
Do not create a second service polling the same bot or bypass the instance lock.

Startup verifies signer/address, chain ID, SID metadata, historical state at the
chosen confirmation depth, network binding and the persistent scan baseline.
It adds isolated tables under `coinflip_robinhood` in the existing PostgreSQL
database. Existing public-schema Solana records are not reset or relabeled.
No arbitrary token is automatically approved or bought, and no bridge is used.

## Speed and confirmation policy

Robinhood is an Ethereum layer 2. Sequencer inclusion happens quickly; Ethereum
finality takes much longer. Public checks on November 13 showed about a
15-minute gap between latest and finalized blocks. These are different security
levels, not a 15-minute wait for the transaction to appear.

**Fast mode (`l2`)** accepts a receipt only after 20 subsequent L2 blocks, usually
about five seconds at the observed block cadence. RPC latency and outages can
increase that. The bot labels the network as L2 confirmed; it never calls those
receipts Ethereum-finalized. ETH/ERC-20 balances and metadata are read at the
same confirmation depth, with no fallback to another network or an unverified
latest balance. Payment windows are three minutes. Both deposits must confirm
before the economic result is committed.

Fast confirmations carry sequencer/reorg risk before Ethereum finality. Accepted
receipt block hashes are persisted and checked until Ethereum finality. A changed
accepted block or scanner cursor freezes new signatures and scanning for manual
reconciliation. Already-confirmed payout history can also become uncertain in a
reorg; the bot does not issue an automatic replacement. This detection limits
further exposure but cannot undo an already-broadcast payment or make a fast
confirmation equivalent to Ethereum finality. Use small amounts when testing.

**Finalized mode** waits for Ethereum finality for both deposits and payments and
uses a 30-minute deposit window. It can take 15–25 minutes or more per stage and
is intentionally unsuitable for a fast social game. The official public RPC
returned unavailable historical state at the finalized tag in read-only checks;
this mode needs a provider supplying that state. Startup fails if the selected
policy cannot be checked. RPC failure never silently weakens confirmation policy.

## Deposits and payments

Register public 0x sending and receiving wallets specifically for Robinhood.
Copy the treasury address and exact token-unit amount, send a direct ETH or
ERC-20 transfer on chain 4663, and tap Check Deposit once. No Solana memo is used.
Background checks keep running and update the saved private card. Creator funding
posts the challenge back to its originating group. New-user wallet onboarding
retains the challenge context.

Partial transfers accumulate without extending the deadline. Excess is queued
for refund. Cancellation/timeout returns retained deposits; late or duplicate
supported direct transfers are recovered for refund, not assigned to a new game.
Ambiguous or nonstandard receipts are retained for review. A scanner/database
failure retains its cursor so the block is replayed. Native ETH scanning reads
transaction bodies; ERC-20 scanning uses incoming Transfer logs and independently
verifies calldata, sender, recipient, receipt, block and amount.

Custom tokens must expose standard decimals (0–18), supply and transfer behavior.
Fee-on-transfer, rebasing, blacklist/hook and other nonstandard assets may fail
validation or payout and need manual review. Metadata alone does not prove a
contract safe. Arbitrary malicious token behavior cannot be guaranteed. Wallet
swaps, bridges, exchange withdrawals, smart-wallet forwarded transfers, and
wrong-network transfers are not accepted as ordinary direct deposits.

The existing **90% prize / 5% holder share / 5% burn** split is preserved. Robinhood
burn fees are transfers to `0x000000000000000000000000000000000000dEaD`, including
native ETH. This is an irrecoverable sink transfer, **not a guarantee that an
ERC-20's totalSupply decreases**. There is no universal ERC-20 burn method.
Result/refund cards use compact transaction links to the Robinhood Blockscout
explorer. Leaderboards are scoped to the selected chain and rank estimated net
USD P/L; an unavailable custom-token price stays unranked.

All quantities use integer arithmetic, with uint256 amounts and 18-decimal
precision. Signing reserves all outstanding liabilities and gas. Nonces and
signed bytes are persisted before broadcast. Retries reuse those exact bytes;
unknown or externally consumed nonces require review. There is no automatic fee
bump, new-nonce replacement, wallet rotation, or signing from the holder vault.
A stuck low-fee transaction can hold later nonce-ordered payments until reviewed.

Private commands:

- `/rhdepositcheck TX_HASH`: private owner-only, read-only receipt, request-window, registered-wallet and scanner-cursor diagnostic. No game ID is needed.
- `/rhrefund TX_HASH`: same read-only preview. Adding `CONFIRM` queues a full return of a verified, previously unrecorded direct deposit only after nearby matching requests have closed. It uses the existing unique-receipt ledger and ordinary payment worker; repeated commands cannot queue a second refund. Mismatched senders or missing historical requests require review.
- `/rhstatus GAME_ID`: saved state and payment links; players/original group only.
- `/rhdeposit GAME_ID TX_HASH`: submit an exact historical direct-deposit proof.
- `/rhaudit`: owner-only treasury liabilities and gas/reserve coverage check.
- `/rhrecheck PAYMENT_ID`: owner-only recheck of an original payout hash. No resend.

Use the matching `/sol...` commands for Solana. Do not use the Solana burn-recovery
command for an EVM payment. A Robinhood history freeze requires inspection of the
original block/receipt evidence and ledger before any manual repair.

## Validation and launch boundary

Offline chain checks exercise native and ERC-20 receipt validation, chain/wallet
binding, precision, gas coverage, signed payouts, nonce handling, burn sink and
confirmation policies. Disposable PostgreSQL tests exercise cross-chain group
locking, favorites isolation, concurrent acceptance, partial/excess/late refunds,
settlement/custody accounting, restart recovery and the group-to-DM wallet flow.
Existing Solana regression tests are also required. No production keys, real
funds, production database or real-money mainnet flip are used by these tests.
Source publication/CI does not establish a successful Railway deployment or live
Robinhood operation. Verify deployment first, then use very small end-to-end
ETH/SID games and check payout/refund hashes before inviting broader use.
