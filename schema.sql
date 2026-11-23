-- Codfish D1 schema. Times are unix milliseconds.

CREATE TABLE IF NOT EXISTS users (
  id          TEXT PRIMARY KEY,
  email       TEXT NOT NULL UNIQUE,
  settings    TEXT NOT NULL DEFAULT '{}',
  created_at  INTEGER NOT NULL,
  -- Prepaid credit for the house model, in millionths of a dollar. Only Stripe top-ups (not built yet) add to it.
  credit_micro INTEGER NOT NULL DEFAULT 0
);

-- One pending sign-in code per email address. The code itself is never stored, only an HMAC of it.
CREATE TABLE IF NOT EXISTS login_codes (
  email       TEXT PRIMARY KEY,
  code_hash   TEXT NOT NULL,
  expires_at  INTEGER NOT NULL,
  attempts    INTEGER NOT NULL DEFAULT 0,
  sent_at     INTEGER NOT NULL,
  hour_start  INTEGER NOT NULL,
  hour_sends  INTEGER NOT NULL DEFAULT 1
);

-- Session cookie tokens, stored as SHA-256 hashes.
CREATE TABLE IF NOT EXISTS sessions (
  token_hash  TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at  INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id);

-- Users' own model API keys, encrypted with AES-GCM under the Worker's SECRET.
CREATE TABLE IF NOT EXISTS api_keys (
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider    TEXT NOT NULL,
  enc         TEXT NOT NULL,
  last4       TEXT NOT NULL,
  updated_at  INTEGER NOT NULL,
  PRIMARY KEY (user_id, provider)
);

CREATE TABLE IF NOT EXISTS proofs (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title       TEXT NOT NULL,
  kind        TEXT NOT NULL CHECK (kind IN ('lean', 'sketch')),
  source      TEXT NOT NULL,
  analysis    TEXT,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS proofs_user ON proofs(user_id, updated_at DESC);

-- House-model metering. user_id '*' holds the global daily total used for the kill switch.
CREATE TABLE IF NOT EXISTS usage (
  user_id       TEXT NOT NULL,
  day           TEXT NOT NULL,
  calls         INTEGER NOT NULL DEFAULT 0,
  neurons       REAL NOT NULL DEFAULT 0,
  charged_micro INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, day)
);

-- Every change to a user's credit, so balances can be audited against Stripe.
CREATE TABLE IF NOT EXISTS credit_ledger (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  delta_micro INTEGER NOT NULL,
  reason      TEXT NOT NULL,
  ref         TEXT,
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS credit_ledger_user ON credit_ledger(user_id, created_at DESC);
