-- Fresh, separate ledger. Never run against the old PaxLabs schema as an implicit migration.
CREATE TABLE IF NOT EXISTS "SolGames" (
  id text PRIMARY KEY,
  state jsonb NOT NULL,
  "createdAt" timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS "SolDeposits" (
  signature text PRIMARY KEY,
  "gameId" text NOT NULL REFERENCES "SolGames"(id),
  "userId" text NOT NULL,
  amount numeric(20,0) NOT NULL CHECK (amount > 0),
  "createdAt" timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS "SolOutbox" (
  id text PRIMARY KEY,
  "gameId" text NOT NULL REFERENCES "SolGames"(id),
  payment jsonb NOT NULL,
  status text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','SIGNED','CONFIRMED','REVIEW')),
  signed jsonb,
  "lastError" text,
  "createdAt" timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS sol_outbox_pending ON "SolOutbox"(status);
CREATE TABLE IF NOT EXISTS "SolTokens" (
  "userId" text NOT NULL,
  mint text NOT NULL,
  metadata jsonb NOT NULL,
  PRIMARY KEY ("userId", mint)
);
