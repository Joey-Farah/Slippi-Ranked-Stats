// Paying for Premium and proving it: /pass/renew, /checkout, the Stripe webhook, and the pages
// Stripe sends the browser back to.
//
// The one rule that matters (decision 5): only a DEFINITE answer takes Premium away, and a
// definite answer is always an explicit `reason` in a 200. "Not paid" in particular is only
// said after Stripe itself confirms it; if Stripe can't be reached the answer is an error,
// which the app treats as "couldn't reach the server" and keeps its Pass.

import { boundedString, readJson, sha256 } from "./auth";
import { json, secret } from "./http";
import { PASS_TTL_MS, signPass } from "./pass";
import { periodEndMs, stripeRequest, verifyWebhookSignature, type StripeSubscription } from "./stripe";

/** Stripe statuses that are Premium (premise 4). past_due, unpaid, canceled, incomplete… aren't. */
const PREMIUM_STATUSES = new Set(["active", "trialing"]);
/** A live subscription whose last charge was declined: Stripe is still retrying it. */
const PAYMENT_FAILED_STATUSES = new Set(["past_due", "unpaid"]);

interface Account {
  id: number;
  email: string;
  stripe_customer_id: string | null;
  device_id: string;
}

type SessionLookup =
  | { kind: "live"; account: Account }
  | { kind: "replaced" }
  | { kind: "unknown" };

async function lookupSession(env: Env, session: string): Promise<SessionLookup> {
  const row = await env.DB.prepare(
    `SELECT a.id, a.email, a.stripe_customer_id, s.device_id, s.replaced_at
     FROM sessions s JOIN accounts a ON a.id = s.account_id
     WHERE s.session_hash = ?`,
  )
    .bind(await sha256(session))
    .first<Account & { replaced_at: number | null }>();
  if (!row) return { kind: "unknown" };
  if (row.replaced_at !== null) return { kind: "replaced" };
  const { replaced_at: _, ...account } = row;
  return { kind: "live", account };
}

/** A definite answer about a session that can't renew, or null if it's live. */
function sessionReason(lookup: SessionLookup, serverNow: number): Response | null {
  if (lookup.kind === "unknown") return json({ reason: "signed_out", serverNow });
  if (lookup.kind === "replaced") return json({ reason: "device_replaced", serverNow });
  return null;
}

/**
 * Whether a webhook has told us the account is paid FOR THE CURRENT PERIOD. A recorded "active"
 * only counts until that period ends: every renewal sends a fresh webhook with the next period's
 * end, so an expired one means we missed what happened next (a declined renewal, say), and the
 * caller asks Stripe instead of trusting a stale "active" forever.
 */
async function hasPremiumInCache(env: Env, accountId: number): Promise<boolean> {
  const row = await env.DB.prepare(
    `SELECT 1 FROM subscriptions
     WHERE account_id = ? AND status IN ('active', 'trialing')
       AND (current_period_end IS NULL OR current_period_end > ?)
     LIMIT 1`,
  )
    .bind(accountId, Date.now())
    .first();
  return row !== null;
}

/**
 * Asks Stripe for the customer's subscriptions and records them. `premium`: one is paid up.
 * `paymentFailed`: none is, but one is past_due/unpaid, so the player's card needs fixing (and
 * a fresh Checkout would open a SECOND subscription while Stripe keeps retrying the first).
 * Throws StripeUnreachable rather than ever guessing.
 */
async function liveStatus(env: Env, account: Account): Promise<{ premium: boolean; paymentFailed: boolean }> {
  if (!account.stripe_customer_id) return { premium: false, paymentFailed: false };
  const list = await stripeRequest<{ data: StripeSubscription[] }>(env, "GET", "/subscriptions", {
    customer: account.stripe_customer_id,
    status: "all",
    limit: 100,
  });
  const now = Date.now();
  for (const sub of list.data) await recordSubscription(env, account.id, sub, now);
  const premium = list.data.some((s) => PREMIUM_STATUSES.has(s.status));
  return { premium, paymentFailed: !premium && list.data.some((s) => PAYMENT_FAILED_STATUSES.has(s.status)) };
}

/** Upserts one subscription. A row only moves forward in time, so a late webhook can't undo a newer state. */
async function recordSubscription(env: Env, accountId: number, sub: StripeSubscription, asOf: number) {
  await env.DB.prepare(
    `INSERT INTO subscriptions (stripe_subscription_id, account_id, status, current_period_end, updated_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (stripe_subscription_id) DO UPDATE SET
       status = excluded.status,
       current_period_end = excluded.current_period_end,
       updated_at = excluded.updated_at
     WHERE excluded.updated_at >= subscriptions.updated_at`,
  )
    .bind(sub.id, accountId, sub.status, periodEndMs(sub), asOf)
    .run();
}

// ── POST /pass/renew {session} ───────────────────────────────────────────────────────────────

export async function renewPass(request: Request, env: Env): Promise<Response> {
  const session = boundedString((await readJson(request))?.session, 200);
  if (!session) return json({ error: "bad_request" }, 400);

  const serverNow = Date.now();
  const lookup = await lookupSession(env, session);
  const reason = sessionReason(lookup, serverNow);
  if (reason || lookup.kind !== "live") return reason!;
  const { account } = lookup;

  if (!(await hasPremiumInCache(env, account.id))) {
    // The cache only ever confirms Premium. "Not paid" comes from Stripe or not at all, so a
    // missed or late webhook can't lock anyone out (premise 3).
    let live;
    try {
      live = await liveStatus(env, account);
    } catch (err) {
      console.error("renew: Stripe unreachable:", err);
      return json({ error: "stripe_unreachable" }, 503);
    }
    if (!live.premium) {
      return json({ reason: "not_paid", ...(live.paymentFailed ? { paymentFailed: true } : {}), serverNow });
    }
  }

  const pass = await signPass(env, {
    v: 1,
    email: account.email,
    deviceId: account.device_id,
    iat: serverNow,
    exp: serverNow + PASS_TTL_MS,
  });
  return json({ pass, serverNow });
}

// ── POST /checkout {session} ─────────────────────────────────────────────────────────────────

export async function startCheckout(request: Request, env: Env): Promise<Response> {
  const session = boundedString((await readJson(request))?.session, 200);
  if (!session) return json({ error: "bad_request" }, 400);

  const serverNow = Date.now();
  const lookup = await lookupSession(env, session);
  const reason = sessionReason(lookup, serverNow);
  if (reason || lookup.kind !== "live") return reason!;
  const { account } = lookup;

  try {
    // Already paying, or paying with a declined card? Don't open a second subscription: the app
    // renews, or sends the player to the portal to fix the card.
    if (await hasPremiumInCache(env, account.id)) return json({ alreadyPremium: true, serverNow });
    const live = await liveStatus(env, account);
    if (live.premium) return json({ alreadyPremium: true, serverNow });
    if (live.paymentFailed) return json({ paymentFailed: true, serverNow });
    const customer = account.stripe_customer_id ?? (await createCustomer(env, account));
    const origin = new URL(request.url).origin;
    const checkout = await stripeRequest<{ url: string }>(env, "POST", "/checkout/sessions", {
      mode: "subscription",
      customer, // locks Checkout's email to the account's
      client_reference_id: String(account.id),
      line_items: [{ price: env.STRIPE_PRICE_ID, quantity: 1 }],
      managed_payments: { enabled: true },
      success_url: `${origin}/checkout/done`,
      cancel_url: `${origin}/checkout/cancelled`,
    });
    return json({ url: checkout.url, serverNow });
  } catch (err) {
    console.error("checkout: Stripe unreachable:", err);
    return json({ error: "stripe_unreachable" }, 503);
  }
}

/** One Stripe customer per account, ever: the idempotency key makes a retried create return the same one. */
async function createCustomer(env: Env, account: Account): Promise<string> {
  const customer = await stripeRequest<{ id: string }>(
    env,
    "POST",
    "/customers",
    { email: account.email, metadata: { account_id: String(account.id) } },
    `srs-customer-${account.id}`,
  );
  await env.DB.prepare("UPDATE accounts SET stripe_customer_id = ? WHERE id = ? AND stripe_customer_id IS NULL")
    .bind(customer.id, account.id)
    .run();
  return customer.id;
}

// ── POST /portal {session} ───────────────────────────────────────────────────────────────────

/**
 * A Stripe Customer Portal link: cancel, or change the card. Under Managed Payments the portal is
 * the only way to change a subscription's card (the API can't set its default payment method),
 * and the way to fix a declined renewal. link.com offers the same to anyone with a Link account.
 */
export async function openPortal(request: Request, env: Env): Promise<Response> {
  const session = boundedString((await readJson(request))?.session, 200);
  if (!session) return json({ error: "bad_request" }, 400);

  const serverNow = Date.now();
  const lookup = await lookupSession(env, session);
  const reason = sessionReason(lookup, serverNow);
  if (reason || lookup.kind !== "live") return reason!;
  const { account } = lookup;
  // Never checked out: no Stripe customer, so nothing to manage. Definite, so it's a 200.
  if (!account.stripe_customer_id) return json({ reason: "no_subscription", serverNow });

  try {
    const portal = await stripeRequest<{ url: string }>(env, "POST", "/billing_portal/sessions", {
      customer: account.stripe_customer_id,
      return_url: `${new URL(request.url).origin}/portal/done`,
    });
    return json({ url: portal.url, serverNow });
  } catch (err) {
    console.error("portal: Stripe unreachable:", err);
    return json({ error: "stripe_unreachable" }, 503);
  }
}

// ── POST /stripe/webhook ─────────────────────────────────────────────────────────────────────

const SUBSCRIPTION_EVENTS = new Set([
  "customer.subscription.created",
  "customer.subscription.updated",
  "customer.subscription.deleted",
  "customer.subscription.paused",
  "customer.subscription.resumed",
]);

export async function stripeWebhook(request: Request, env: Env): Promise<Response> {
  const body = await request.text();
  const ok = await verifyWebhookSignature(body, request.headers.get("stripe-signature"), secret(env.STRIPE_WEBHOOK_SECRET));
  if (!ok) return json({ error: "bad_signature" }, 400);

  let event: { type?: string; created?: number; data?: { object?: StripeSubscription } };
  try {
    event = JSON.parse(body);
  } catch {
    return json({ error: "bad_request" }, 400);
  }
  const sub = event.data?.object;
  if (!event.type || !SUBSCRIPTION_EVENTS.has(event.type) || !sub?.id || !sub.customer) {
    return json({ received: true }); // not one we act on; 200 so Stripe doesn't retry it
  }
  const account = await env.DB.prepare("SELECT id FROM accounts WHERE stripe_customer_id = ?")
    .bind(sub.customer)
    .first<{ id: number }>();
  if (account) {
    // Ordered by the event's own time, so Stripe redelivering an old event can't overwrite a newer one.
    await recordSubscription(env, account.id, sub, (event.created ?? 0) * 1000);
  }
  return json({ received: true });
}

// ── GET /checkout/done, /checkout/cancelled ──────────────────────────────────────────────────

export async function checkoutDone(): Promise<Response> {
  return page("You're subscribed", "Thanks! Premium switches on in Slippi Ranked Stats within a few seconds. You can close this tab.");
}

export async function checkoutCancelled(): Promise<Response> {
  return page("Checkout cancelled", "Nothing was charged. You can close this tab and subscribe from the app any time.");
}

export async function portalDone(): Promise<Response> {
  return page("All set", "Any changes you made apply in Slippi Ranked Stats within a few minutes. You can close this tab.");
}

function page(title: string, message: string): Response {
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>${title} · Slippi Ranked Stats</title>
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#161616;color:#eee;
font:16px/1.5 system-ui,sans-serif;padding:16px}main{max-width:420px;text-align:center}
h1{font-size:22px;color:#2ecc71;margin:0 0 8px}</style></head>
<body><main><h1>${title}</h1><p>${message}</p></main></body></html>`;
  return new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } });
}

