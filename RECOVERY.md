# Recovery build

This branch provides a diagnostic service for the current EVM/Paxeer bot and an isolated Solana devnet pilot. It is not a release of restored live wagering. See the private owner review for the remaining settlement work.

## Start without credentials

Use Node 24 LTS, run `npm ci --ignore-scripts`, then `npm start`. The default is `BOT_MODE=recovery`. Open `/health` on `PORT` (default 3000). Recovery mode does not initialize models, poll Telegram, accept wagers or send transactions. Its successful health response establishes only that the recovery service is running.

## Inspect the existing deployment

Use the original hosting project and database. Take a database backup first, keep the wagering process stopped, and retain the original wallet identities. Enter credentials only into the hosting provider's private environment fields. Do not paste them into Telegram, GitHub, a document or this README.

Run `npm run preflight` from the hosting console. It reads the PostgreSQL database in a read-only transaction, checks Telegram identity/webhook state without polling, and reads RPC chain information. It does not rewrite the schema, process refunds or reconcile wallet liabilities. It deliberately returns a failing exit code if any required check is not configured or fails. Keep its output private because it includes aggregate financial metadata.

`DATABASE_URL` takes priority over individual DB fields. For private database URLs, run inside the same hosting network. TLS certificate verification follows the driver and connection URL; it is not disabled by the recovery tools.

Set `EVM_CHAIN_ID` to the chain ID from independently verified Paxeer documentation. The live path checks that both the bot and dev wallet addresses match their signing keys. `DB_SCHEMA_MODE=verify` is the default and verifies table/column presence without schema synchronization. It does not establish correct enum values, types or indexes. `create` and `alter` are explicit administrative options for a backed-up database after review, not routine recovery settings.

## Live operation

The live path requires both `BOT_MODE=live` and `LIVE_FUNDS_ENABLED=true`. Do not set these until the owner's private findings have been resolved and old deposits, payouts, refunds and fee pools have been reconciled. These flags are an operational gate, not a proof that the remaining payment logic is correct. There is no automatic migration. Native SOL and custom standard SPL tokens now have an isolated devnet pilot; see [SOLANA.md](SOLANA.md). Mainnet remains blocked by the pilot.

Only one replica may poll Telegram. The lock uses a dedicated PostgreSQL connection before schema work and background jobs. Telegram launch retains pending updates; test old buttons in an isolated test bot before reopening a production group. The health endpoint indicates process readiness, not blockchain solvency.

## Validation

Run `npm test -- --runInBand` with no production credentials. The obsolete Solana test is preserved as `archive/solanaHandler.legacy-test.js` and is not part of the active EVM suite because its implementation was removed previously. The new Solana suite also exercises actual PostgreSQL concurrency and restart behavior when SOLANA_TEST_DATABASE_URL is set to a disposable local server. Telegram polling, wallet compatibility and on-chain transactions must still be checked in isolation before production use.
