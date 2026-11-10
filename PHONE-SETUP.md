> Restoration update: This branch now includes the group/private button flow and automatic deposit scanning described in [SOLANA.md](SOLANA.md). SOL and the exact SID mint are defaults for mainnet accounts. Holder pools, burns and daily rewards are implemented. Mainnet is still blocked because current checked Paxeer nodes have no original FLIP contract, so holder supply cannot be verified. Keep the existing recovery settings until the holder source and deployment checks are resolved. No database reset is needed for the additive menu/scanner state. For a future mainnet launch, use a separate ledger from any occupied devnet database.

# Railway setup from an iPhone or iPad

No laptop, local installation or terminal is required for this path. The assistant has prepared the source, deployment configuration and database initialization step. Railway account actions and private credential entry still belong to the owner. Railway is not a connected service available to the assistant. The owner has confirmed a recovery service on Railway; a live Telegram/funds deployment has not been verified.

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

Read [SOLANA.md](SOLANA.md) for commands, deposit proofs, custom-token support and remaining limitations. The original-style Solana interface, native SOL, supported SPL/Token-2022 assets, favorites/default SID and fee handling are implemented. Combined EVM/Solana operation is not restored. The FLIP holder source and actual live validation remain unresolved. Hosting health and automated tests do not establish end-to-end Telegram/payment readiness.

Railway references: [config as code](https://docs.railway.com/reference/config-as-code), [pre-deploy command](https://docs.railway.com/guides/pre-deploy-command).

## Separate mainnet storage, after the holder source is resolved

Do not switch an occupied devnet database to mainnet or erase it. Add a new PostgreSQL service in your personal Railway project and point the bot's `DATABASE_URL` reference at that new service. These account actions use your hosting plan and are not performed automatically by the assistant. Keep the previous database available for historical records and unresolved test obligations.

For the **new empty database only**, keep `BOT_MODE=recovery`, `LIVE_FUNDS_ENABLED=false`, `BOT_CHAIN=solana`, `SOLANA_INIT_FRESH=false`, and set `SOLANA_CLUSTER=mainnet-beta`, a working Solana mainnet `SOLANA_RPC_URL`, the shared `SOLANA_WALLET_ADDRESS`, and `SOLANA_INIT_MAINNET_FRESH=true`. Run the repository's existing pre-deploy command `npm run deploy:prepare` through the Railway settings. It checks the actual mainnet genesis and refuses any nonempty database. It does not enable payments or need private signing credentials. After successful initialization, set `SOLANA_INIT_MAINNET_FRESH=false`. The normal start command stays `npm start`.

A live mainnet launch additionally requires a privately entered matching signing key and bot token, a working HTTPS `FLIP_HOLDER_RPC_URL` that actually serves the original Paxeer FLIP contract, and the two live-mode switches. Startup will refuse an absent FLIP contract, wrong chain or unavailable finalized supply. The official public RPC documentation is https://docs.paxeer.app/public-rpc/ . At the November 10 check, `https://api1.mainnet-beta.paxeer.network`, node 2 and the root unified router reported chain 125 but no code at the old FLIP address. Do not substitute balances or a new token address without resolving which deployment represents the original holders.

Set the public HTTPS `PUBLIC_BASE_URL` or use Railway's generated public domain for mobile deposit and holder-verification pages. Enter your Telegram numeric user ID in private `ADMIN_IDS` for `/solaudit` and `/solrecheck`. Neither command requests signing keys or automatically replaces uncertain transactions. Before inviting testers, verify the actual deployed branch, network, treasury, `/start` menus, wallet links, SID/custom token selection, memo-preserving deposits, full refunds, prize/burn finality and a holder reward cycle. Maintain more than the 0.01 SOL reserved balance for transaction fees and ATA rent. Source tests alone do not verify these live steps.
