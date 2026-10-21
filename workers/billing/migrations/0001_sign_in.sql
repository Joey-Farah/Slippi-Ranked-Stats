-- Sign-in: accounts keyed by email, emailed one-time codes, and the one live session per
-- account. Timestamps are Unix milliseconds.

CREATE TABLE accounts (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  email              TEXT NOT NULL UNIQUE,
  stripe_customer_id TEXT,
  created_at         INTEGER NOT NULL
);

-- One row per code sent. Each code is bound to a random challenge that only the app that
-- asked for it holds, so knowing someone's email is not enough to spend their code's tries or
-- retire it. Neither the challenge nor the code is stored, only hashes; the code's hash is
-- salted with the challenge, so this table alone can't be brute-forced back into live codes.
CREATE TABLE login_codes (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  challenge_hash TEXT NOT NULL UNIQUE,
  email          TEXT NOT NULL,
  ip_bucket      TEXT NOT NULL,
  code_hash      TEXT NOT NULL,
  created_at     INTEGER NOT NULL,
  attempts       INTEGER NOT NULL DEFAULT 0,
  used           INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_login_codes_email ON login_codes (email, created_at);
CREATE INDEX idx_login_codes_ip ON login_codes (ip_bucket, created_at);

-- Every session ever issued. Signing in on a new Device stamps the previous one replaced_at
-- rather than deleting it, so a renewal can tell "replaced by another device" (a definite
-- answer) from a session the server has never seen.
CREATE TABLE sessions (
  session_hash TEXT PRIMARY KEY,
  account_id   INTEGER NOT NULL REFERENCES accounts (id),
  device_id    TEXT NOT NULL,
  created_at   INTEGER NOT NULL,
  replaced_at  INTEGER
);
-- One Device per account: at most one live session.
CREATE UNIQUE INDEX idx_sessions_live ON sessions (account_id) WHERE replaced_at IS NULL;
