-- Sign-in: accounts keyed by email, emailed one-time codes, and the one Device per account.
-- Timestamps are Unix milliseconds.

CREATE TABLE accounts (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  email              TEXT NOT NULL UNIQUE,
  stripe_customer_id TEXT,
  created_at         INTEGER NOT NULL
);

-- One row per code sent. Only the newest row for an email is ever accepted, so asking for a
-- new code retires the old one. The code itself is never stored, only its hash.
CREATE TABLE login_codes (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  email      TEXT NOT NULL,
  ip         TEXT NOT NULL,
  code_hash  TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  attempts   INTEGER NOT NULL DEFAULT 0,
  used       INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_login_codes_email ON login_codes (email, created_at);
CREATE INDEX idx_login_codes_ip ON login_codes (ip, created_at);

-- One Device per account: signing in again replaces the row (newest wins).
CREATE TABLE devices (
  account_id   INTEGER PRIMARY KEY REFERENCES accounts (id),
  device_id    TEXT NOT NULL,
  session_hash TEXT NOT NULL UNIQUE,
  created_at   INTEGER NOT NULL
);
