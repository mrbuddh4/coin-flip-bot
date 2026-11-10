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

The worker automatically sends deposit and outgoing-payment status notices to both players privately and the group where the flip began. Each includes the exact asset, amount, wallets and transaction link when signed; only finalized proof is labeled confirmed. This includes expired-game refunds, burn allocations and holder-wallet custody transfers, even after the challenge card closes. Holder custody is not a distribution to holders. A blocked chat retries without preventing other destinations or payments. Accepted notices are remembered across restarts; a lost Telegram response can exceptionally cause a duplicate notice, never a replacement payment. One notice per destination per five-second worker pass limits chat bursts. Existing ledger receipts receive an initial catch-up notice after this upgrade. Refresh remains an optional manual status check. Amount input accepts both `0.01` and `.01`.

### Flip reveal order

The group video is sent first and its playback timer starts after Telegram acknowledges delivery. The video message ID and playback deadline persist across restarts, and its Telegram file ID is cached for future flips. Once playback ends, the bot removes the video and posts the result image, then updates its payout confirmation. Private status, statistics, leaderboards and automatic payment notices hold back the winner until the group result is announced. Deposit notices remain immediate. Blockchain payout processing continues independently; an external wallet/explorer can therefore show payment before the Telegram presentation finishes. Failed video cleanup retries. A restart during an upload with no acknowledged message ID waits up to five minutes before falling back to the result, without automatically uploading another potentially duplicate clip.
