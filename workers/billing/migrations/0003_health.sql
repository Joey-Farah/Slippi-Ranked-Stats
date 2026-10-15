-- The hourly self-test's last result (one row). Kept so an alert goes out only when the state
-- changes: once when something starts failing, once when it recovers. Timestamps are Unix ms.
CREATE TABLE health (
  id         INTEGER PRIMARY KEY CHECK (id = 1),
  status     TEXT NOT NULL,          -- 'ok' or 'failing'
  failing    TEXT,                   -- the failing checks, comma-separated
  since      INTEGER NOT NULL,       -- when the current status began
  checked_at INTEGER NOT NULL
);
