-- Subscriptions as Stripe last told us about them (webhooks, or a live check during a renewal).
-- One row per Stripe subscription: an account that cancels and later resubscribes has several.
-- This table is a cache, never the final word on "not paid": a renewal that finds nothing
-- active here asks Stripe before saying so. Timestamps are Unix milliseconds.
CREATE TABLE subscriptions (
  stripe_subscription_id TEXT PRIMARY KEY,
  account_id             INTEGER NOT NULL REFERENCES accounts (id),
  status                 TEXT NOT NULL,
  current_period_end     INTEGER,
  updated_at             INTEGER NOT NULL
);
CREATE INDEX idx_subscriptions_account ON subscriptions (account_id);

CREATE UNIQUE INDEX idx_accounts_stripe_customer ON accounts (stripe_customer_id)
  WHERE stripe_customer_id IS NOT NULL;
