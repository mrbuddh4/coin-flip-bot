> Current scope: Solana only. Keep `SOLANA_HOLDER_REWARDS=deferred` (the default). Prizes and burns run on Solana, while the 5% holder allocation stays reserved. Paxeer availability does not block this mode. No EVM key or FLIP holder RPC is required. A newly minted Solana FLIP token can be considered separately after its exact public mint and reward eligibility are configured.


# Railway setup from an iPhone or iPad

No laptop, local installation or terminal is required for this path. The assistant has prepared the source, deployment configuration and database initialization step. Railway account actions and private credential entry still belong to the owner. Railway is not a connected service available to the assistant. The owner has confirmed a recovery service on Railway; a Solana-mainnet Telegram /start dashboard has now been observed. Financial end-to-end operation is still being verified.

## 1. Put the recovery service online first

1. Open [Railway](https://railway.com/dashboard) in Safari. Select your **personal paid workspace**, not PaxLabs LTD. Keep the old project untouched.
2. Create a new project and add a service from the GitHub repository `mrbuddh4/coin-flip-bot`. Grant Railway GitHub access if prompted.
3. Before adding any credentials, open that service's **Settings > Source** and select branch `recovery-review-2026-11-09`. If Railway starts an automatic build from `main`, cancel that deployment and change the branch. The original main branch is not the restored code. Do not attach old variables or enable payments.
4. Set `BOT_MODE=recovery` and `LIVE_FUNDS_ENABLED=false` in the service's Variables. Deploy the recovery branch. It uses the repository Dockerfile, one replica and `/health` readiness. No Telegram token, wallet key or database is needed at this stage. A healthy deployment confirms only the recovery health service is running.

New hosting and a database use your Railway account's resources and may cost money under your plan. The assistant has not created or purchased them.

## 2. Initialize a new devnet database using the Railway screen

1. In this same new project, add a **new PostgreSQL** service. Do not reuse the inaccessible PaxLabs database.
2. In the bot service, add a Railway reference variable for that database's `DATABASE_URL` using the Variables reference picker. Use the database service's actual name; do not paste its URL into chat or GitHub.
3. Add these public configuration values to the bot service:

```
BOT_MODE=recovery
LIVE_FUNDS_ENABLED=false
BOT_CHAIN=solana
SOLANA_CLUSTER=devnet
SOLANA_RPC_URL=https://api.devnet.solana.com
SOLANA_WALLET_ADDRESS=6izojQcvjazUDZ4jckAnFn15i8fDRkNb4J9NnTpTVBkY
SOLANA_INIT_FRESH=true
```

4. Deploy the saved changes. The configured pre-deploy command, `npm run deploy:prepare`, checks the RPC's actual devnet genesis and initializes the empty test database. It does not need a signing key or Telegram token. Existing public tables cause refusal, not deletion or migration. A wrong or unreachable RPC also stops initialization.
5. After a successful initialization, set `SOLANA_INIT_FRESH=false` and deploy that change. Leaving it true causes the next deployment to refuse the now nonempty database. Default recovery deployments skip initialization and never connect to the database.

There are no commands to type into a shell. Use the service's deployment logs to check initialization; share only a cropped error message with all private variables hidden if something fails.

## 3. Private inputs before the Telegram devnet pilot

The remaining inputs cannot be reconstructed from a public address. Enter these only in Railway's private Variables:

- `TELEGRAM_BOT_TOKEN` for a separate test bot you control. You can create it in Telegram with the verified BotFather account. Do not use the old production bot for this pilot.
- `SOLANA_PRIVATE_KEY` matching the shared public address above, in a supported 64-byte JSON or base58 format. Never send a private key, seed phrase or bot token to the assistant. If you cannot access the matching key from your phone, leave the service in recovery; the public address cannot sign payouts.

Fund the same address with **devnet** SOL for fees and test deposits. Mainnet assets and mainnet custom mints are not devnet test assets. A test mint must exist on devnet. Once configuration and test funds are ready, set `BOT_MODE=live` and `LIVE_FUNDS_ENABLED=true` for the devnet pilot. The genesis gate verifies the selected network. Mainnet has additional holder-source and ledger requirements. Keep one replica, no competing poller, and no existing Telegram webhook. Start with `/start` and then `/flip` in a group.

Read [SOLANA.md](SOLANA.md) for commands, deposit proofs, custom-token support and remaining limitations. The original-style Solana interface, native SOL, supported SPL/Token-2022 assets, favorites/default SID and fee handling are implemented. Combined EVM/Solana operation is not restored. Holder distribution is intentionally deferred; actual live validation remains outstanding. Hosting health and automated tests do not establish end-to-end Telegram/payment readiness.

Railway references: [config as code](https://docs.railway.com/reference/config-as-code), [pre-deploy command](https://docs.railway.com/guides/pre-deploy-command).

## Separate mainnet storage for Solana-only games

Do not switch an occupied devnet database to mainnet or erase it. Add a new PostgreSQL service in your personal Railway project and point the bot's `DATABASE_URL` reference at that new service. These account actions use your hosting plan and are not performed automatically by the assistant. Keep the previous database available for historical records and unresolved test obligations.

For the **new empty database only**, keep `BOT_MODE=recovery`, `LIVE_FUNDS_ENABLED=false`, `BOT_CHAIN=solana`, `SOLANA_INIT_FRESH=false`, and set `SOLANA_CLUSTER=mainnet-beta`, a working Solana mainnet `SOLANA_RPC_URL`, the shared `SOLANA_WALLET_ADDRESS`, and `SOLANA_INIT_MAINNET_FRESH=true`. Run the repository's existing pre-deploy command `npm run deploy:prepare` through the Railway settings. It checks the actual mainnet genesis and refuses any nonempty database. It does not enable payments or need private signing credentials. After successful initialization, set `SOLANA_INIT_MAINNET_FRESH=false`. The normal start command stays `npm start`.

A live mainnet launch additionally requires a privately entered matching signing key and bot token, `SOLANA_HOLDER_REWARDS=deferred`, and the two live-mode switches. Solana-only startup does not query Paxeer or require a FLIP contract. The 5% holder share remains reserved and visible in Fee Accounting. Only a future, explicitly selected Paxeer reward mode would require verifying the old FLIP contract. The official public RPC documentation is https://docs.paxeer.app/public-rpc/ . At the November 10 check, `https://api1.mainnet-beta.paxeer.network`, node 2 and the root unified router reported chain 125 but no code at the old FLIP address. This is why the optional Paxeer reward mode is deferred. No balances or replacement token have been assumed.

Set the public HTTPS `PUBLIC_BASE_URL` or use Railway's generated public domain for mobile deposit pages. Enter your Telegram numeric user ID in private `ADMIN_IDS` for `/solaudit` and `/solrecheck`. Neither command requests signing keys or automatically replaces uncertain transactions. Before inviting testers, verify the actual deployed branch, network, treasury, `/start` menus, wallet links, SID/custom token selection, memo-preserving deposits, full refunds, prize/burn finality and holder custody accounting. Maintain more than the 0.01 SOL reserved balance for transaction fees and ATA rent. Source tests alone do not verify these live steps.

## Optional separate holder-rewards wallet

In the bot service's Variables, set `SOLANA_HOLDER_WALLET_ADDRESS` to the public address of the separate Solana wallet you control. Keep `SOLANA_HOLDER_REWARDS=deferred` and both initialization flags false, then deploy the latest recovery branch. The additive custody tables are prepared automatically; do not reinitialize or replace the mainnet database.

The bot queues the 5% holder share from settled games into this wallet in each original asset. Existing unallocated holder pools also move there; already allocated historical payouts retain their original destinations. The treasury pays transaction fees and any required recipient token-account rent, so allow for that extra fee use. Only finalized transfers become recorded holder-wallet reserves. Unknown/failed transfers stay visible and cannot be automatically sent a second time with new signed bytes.

Receiving this share needs only the public holder-wallet address. Its private key will be needed later for automatic holder payouts, but no such key is loaded or used by this custody-only implementation. Payouts remain deferred pending a supported exact reward token and distribution policy. Enter that key privately in Railway only when the separate payout worker is ready; never send it through chat or put it in GitHub. `/solaudit` can already check the separate wallet's recorded reserves against finalized balances without its key. Once the custody address is bound, removing/changing it refuses startup until a deliberate reconciliation/migration is implemented.

## Updated deposit flow

Type the wager amount in the Telegram chat first. Then copy the shared deposit address and exact amount from the transfer screen. Transfer from your registered sending wallet and tap **Confirm Deposit**. A plain transfer needs an exact token/amount and a unique historical request at its finalized transaction timestamp; use the game memo when requests overlap. New group challenges appear after the creator confirms a matched deposit.

If an older build skipped a memo-free transfer, use the original game's Confirm Deposit button after updating. It replays that request window without sending another deposit. An expired/cancelled game's attributable deposit is recorded for a full refund, rather than reviving the wager. Missing or ambiguous request proof remains for review. Source tests do not prove a refund has finalized.

### Automatic payment transparency

The worker updates the current game screen and the originating group card automatically. The winner announcement includes short Prize, Burn and Holder fee transaction links. Cancelled/expired games include refund links with player and amount; late refunds reopen the same card for updates. Pending/needs-review states remain explicit, and only finalized proof gets a check mark. Holder fee means transfer into holder custody, not distribution to individual holders. No standalone deposit/payment notices or historical catch-up messages are sent. Refresh is an optional manual check. Amount input accepts both `0.01` and `.01`.

The bot also attempts to delete the older verbose notices using its saved delivery message IDs, preserving the database history. Telegram restrictions may prevent deletion of old or inaccessible messages; those are recorded as undeletable. It never deletes unrelated chat messages or financial records.

### Flip reveal order

The group video is sent first and its playback timer starts after Telegram acknowledges delivery. The video message ID and playback deadline persist across restarts, and its Telegram file ID is cached for future flips. Once playback ends, the bot removes the video and posts the result image, then updates its payout confirmation. Private status, statistics and leaderboards hold back the winner until the group result is announced. Blockchain payout processing continues independently; an external wallet/explorer can therefore show payment before the Telegram presentation finishes. Failed video cleanup retries. A restart during an upload with no acknowledged message ID waits up to five minutes before falling back to the result, without automatically uploading another potentially duplicate clip.

## Smooth Telegram navigation

Private menus now edit one saved message in place, including wallet entry,
tokens, wager entry and game status. The saved message survives a restart. A
missing or uneditable message gets a replacement; network timeouts do not cause
an immediate duplicate. Consumed DM commands and inputs are deleted only after
the next screen is acknowledged. Telegram restrictions can prevent deletion.

Buttons carry a screen revision. Old cards, repeated taps and forwarded buttons
cannot change a newer session. Actions are serialized per user. Home offers
Resume for open games and games still completing payouts. Token entry has a
Back button, wager setup shows three steps, and cancellation has a confirmation.
Leaving a menu does not cancel a funded game.

The worker updates a displayed game screen when deposits, results or payment
states change, without taking over Home or another menu. Creator funding still
needs Confirm Deposit (or Post Funded Challenge on the status screen) to publish
the group challenge. Manual deposit checking remains available for reconciliation.

Group setup cards are removed when their owner opens the DM flow, with cleanup
retries for consumed/expired drafts. The challenge updates in place; its used
card and the video are removed when the final result is shown. Failed cleanup
is retried and old keyboards are disabled where Telegram permits it. Final
results and compact transaction links remain as the transparent game history.
Existing untracked messages from older deployments cannot be discovered or
removed retroactively by this version.


## One active flip per group

The database reserves one active game per originating group, including creator funding, challenge acceptance, challenger funding, and the flip presentation. The slot stays occupied after economic settlement until the result is announced and any flip-video cleanup has finished. Cancelled/expired games release it; their refunds continue updating on their existing card. Unconfirmed outgoing payments stay tracked without preventing the next flip after the result.

Concurrent creators are serialized with a PostgreSQL transaction advisory lock. Concurrent accepts lock the same game row: only the first valid player gets the challenger slot and deposit instructions. Later players see that it has already been accepted. The chosen player can reopen the challenge to resume their existing deposit screen. Different groups can run independently. This requires no new variables or database reset.


## Optional challenge-card video

The funded group challenge supports a video with its caption and Accept button on the same card. It edits the caption when the slot is taken, removes the Accept button, and retires the old challenge card when the flip result appears. This clip is separate from the result animation. Set `SOLANA_CHALLENGE_VIDEO` privately in Railway to a Telegram video file ID or an accessible HTTPS MP4 URL, or package the supplied clip as `assets/challenge.mp4`. With neither configured, the existing text challenge is retained. The owner's November 10 Morpheus challenge clip is bundled as `assets/challenge.mp4` (1.4 seconds, H.264 MP4). It is used automatically when `SOLANA_CHALLENGE_VIDEO` is unset. Deploy the latest recovery branch; no media variable or database reset is required. Existing posted challenges keep their current card; new funded challenges use the clip.


## Expired challenge video

The owner's Hannibal Buress “WACK” clip is bundled as `assets/expired.mp4`. When a challenge times out, the bot replaces the existing group card media in place, removes Accept, and keeps the compact refund links in its caption. Refund finality updates that same caption. Manual cancellations keep their existing card. Unfunded drafts do not produce a new group notification. New cancellation records distinguish manual cancellation from expiry; older records retain the generic label. `SOLANA_EXPIRY_VIDEO` optionally overrides the bundled clip with a Telegram file ID or HTTPS video URL. No new variable or database reset is needed.


### One-tap deposit checking

After transferring, tap **Check Deposit** once. The same private card immediately shows that checking is active, without another check button. It confirms automatically when a matching finalized deposit is recorded. A creator’s funded challenge is then published automatically, even if the user navigates Home or the bot restarts. Challenger confirmations advance to the existing animation/result flow. Pending checks expire with the game; existing matching, refund and payment safeguards remain in force. No environment changes or database reset are required.


## Automatic recovery of skipped deposits

The worker periodically replays recent persisted request windows, including closed
requests, without requiring another Check Deposit tap. Previously skipped receipts
are reconsidered even when their transaction is already behind the normal cursor.
Replays rotate through wallets, run at most twice per tick, and are throttled to
once per wallet per 30 seconds after success. A deployment restarts this throttle.

Funding still requires one unique exact request inside its original payment
window. Ambiguous or out-of-window plain transfers never fund a wager. A separate
refund-only reconciliation can return a verified unconsumed exact-asset/exact-amount
transfer to its registered signing wallet after every nearby request has closed.
This recovery margin covers 60 seconds before the request and 15 minutes after its
payment deadline, for attribution to a refund record only. Receipt uniqueness and
the signed-before-send outbox prevent duplicate refunds. Missing timestamps,
unsupported layouts, different sending wallets and transfers outside this bounded
context still need investigation. A refund is complete only when its transaction
is finalized, as shown by the compact refund link.

Deploy the latest recovery branch with the existing mainnet database and variables.
Do not initialize a new database. The worker will recheck the last 24 hours of
request windows automatically; older records remain watched incrementally.


For an unexplained missed payment, privately send `/depositcheck SIGNATURE` to the
bot. A public Explorer/Solscan transaction link is accepted too. This read-only
report compares the chain timestamp and sender against your last three same-asset,
same-amount game requests, including the challenger acceptance time. It shows the
number of exact historical matches, proof validation and recorded/refund state.
It does not import deposits, place a wager or send funds. Share that report to
establish the actual rejection reason instead of inferring it from a pending card.


## Unsupported wallet-history transactions must not block deposits

The scanner now prioritizes newer receipts and isolates lookup failures. A failed
older lookup or later pagination page cannot prevent already fetched valid
payments from being processed. Transient lookup/database errors retain the old
cursor for retry. Unsupported transaction-version errors are retained in the
additive `SolScanReviews` table before the cursor may advance; replays skip those
persisted review records, avoiding a permanent retry loop. No unsupported payment
is guessed or credited. The private administrator `/solaudit` report lists the
latest unsupported signatures for investigation. The existing client supports
legacy/v0, not version 1; upgrading that parser and reconciling the review queue
is separate from allowing supported receipts to proceed.

`/soldeposit GAME_ID SIGNATURE` can now submit a unique finalized memo-free proof
directly, without fetching unrelated wallet history. It still validates the
registered signer, destination, exact historical asset/amount/time match and
receipt uniqueness. A wrong memo is never treated as no memo. An expired or
cancelled game returns the full verified transfer through the durable refund
outbox and is never revived. Normal automatic recovery should perform this after
deployment; the command is a fallback for a known signature.

Deploy the latest recovery branch with the existing database. Runtime preparation
creates only the additional review table; no reset or fresh-init flag is needed.


## Group links and visible private screens

Opening a group creation or Accept link and pressing Telegram's Start button
now opens a fresh private screen at the end of the bot chat. The previous
navigation card is retired only after the new screen has been acknowledged and
saved. Ordinary Wallets, token, amount and deposit navigation still edits the
same card. A failed new-screen send preserves the old card. Old buttons cannot
mutate the new session. This fixes a reproduced hidden-menu issue, not proof
that every failed handoff has that cause.

If Telegram only opens the bot without sending `/start`, press Start. If no new
card appears after that, check the active Railway deployment and polling logs.
Deploy the latest recovery branch; keep the existing database and variables.


## SID wallet transfers with redundant self-signers

The finalized RPC parser sometimes describes a normal wallet's checked token
transfer with `multisigAuthority` plus one identical entry in `signers`, rather
than `authority`. Accept that exact self-signer shape only while retaining the
registered-wallet signature, source token ownership, exact mint/program, canonical
treasury ATA, amount and game-window checks. Actual multisig arrangements or
conflicting/missing signers remain unsupported. The read-only `/depositcheck`
diagnostic uses the same authority interpretation.

This fixes a reproduced rejection of the owner's 69 SID transfer. The existing
periodic replay rechecks recently rejected receipts after deployment without
another Check Deposit tap. An expired game receives a full refund instead of
being reopened. Deploy the latest recovery branch with the existing database
and variables. Never send a replacement deposit to recover an earlier one.


## Challenges stay visible in active groups

While a funded challenge has no challenger, the worker posts a replacement card
about once a minute, then deletes the previous card. The video and Accept link
remain attached to the same game. Acceptance stops reposting. Bumps never reset
the challenge deadline or change deposits. A new expiry notice appears at the
end of the group chat, and its refund links update on that same notice.

The new message is acknowledged and saved before deletion of the old one.
Failed deletion remains tracked for retry and its obsolete buttons are removed.
A Telegram outage can delay posting/deletion; Telegram does not provide an
idempotency key for message sends, so an ambiguous upload timeout cannot promise
exactly-once delivery. Deploy the latest recovery branch with the existing
database and variables; no fresh initialization or variable changes are needed.


## Faster flip presentation

Solana games use the same animation retimed to three seconds in
`assets/coinflip-fast.mp4`, with a separate cache ID so the earlier eleven-second
clip is not reused. The playback clock still starts after Telegram acknowledges
the upload. Result cards refresh on a separate one-second UI timer, even while
the five-second deposit/payment worker is waiting on RPC. The result follows the
clip; confirmed payout links still depend on actual blockchain finality.
Deploy the latest recovery branch with the existing database and variables.
