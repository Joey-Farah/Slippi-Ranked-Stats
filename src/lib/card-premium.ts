// Premium bought with a card: the app half of the srs-billing worker (workers/billing/).
// Plan and decisions: docs/plans/direct-billing.md. Terms (Premium, Subscription, Device, Pass):
// CONTEXT.md.
//
// The email is the account. Signing in is an emailed 6-digit code, bound to a challenge only
// this app holds, which the worker trades for a session tied to this install's device id.
// Premium is a Pass: a 3-day statement signed by the worker that this device is paid up,
// checked here against the worker's public key, so editing it can't grant anything. It renews
// at launch, every 6 hours, and every few seconds while a Checkout is open. Session and Pass
// are kept in account.db (see db.ts), not in localStorage, so they survive whatever has been
// wiping the Discord route's tokens.
//
// Only a DEFINITE answer from the worker takes Premium away (decision 5): `not_paid`,
// `device_replaced` or `signed_out`. A timeout, an error or an outage keeps the Pass, and keeps
// Premium for 7 days past its expiry (decision 5b).
//
// ⚠ Dev builds only until slice 8 of the plan: every entry point is behind import.meta.env.DEV.
// It feeds `cardPremium` in store.ts, which `isPremium` ORs with the Discord route.

import { writable, type Readable } from "svelte/store";
import { fetch } from "@tauri-apps/plugin-http";
import { open as openUrl } from "@tauri-apps/plugin-shell";
import { loadCardState, saveCardState } from "./db";
import { PASS_PUBLIC_KEY } from "./pass-key";
import { cardPremium } from "./store";

const BILLING_URL = "https://srs-billing-staging.joeyfarah.workers.dev";
const REQUEST_TIMEOUT_MS = 15_000;

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const RENEW_EVERY_MS = 6 * HOUR;
/** While a Checkout is open: poll this often, for this long, until the payment shows up. */
const CHECKOUT_POLL_MS = 3_000;
const CHECKOUT_POLL_FOR_MS = 10 * 60 * 1000;
/** Premium survives this long past Pass expiry while the server can't be reached. */
const GRACE_MS = 7 * DAY;

export type CardAccount =
  | { kind: "signed_out" }
  | { kind: "code_sent"; email: string }
  /** awaitingPayment: a Checkout or the portal is open in the browser and we're polling for it.
   *  paymentFailed: the subscription exists but its last charge was declined; the fix is a new
   *  card in the portal (manageSubscription), NOT subscribe(), which the worker refuses. */
  | { kind: "signed_in"; email: string; awaitingPayment?: boolean; paymentFailed?: boolean }
  | { kind: "premium"; email: string }
  /** Another computer signed in to this account; this one was signed out by it. */
  | { kind: "replaced" }
  /** The server no longer knows this computer's session (see applyReason). Premium carries on
   *  until the Pass it already has expires; signing in again restores everything. */
  | { kind: "sign_in_again"; email: string; premium: boolean };

/** Why a sign-in step failed. Everything that isn't a definite answer is "unreachable". */
export type SignInFailure =
  | "bad_email"
  | "wrong_code"
  | "code_expired"
  | "rate_limited"
  | "email_failed"
  | "storage" // account.db couldn't be read or written
  | "unreachable";

export class SignInError extends Error {
  constructor(readonly reason: SignInFailure) {
    super(reason);
    this.name = "SignInError";
  }
}

/** What survives a restart. */
interface Stored {
  deviceId: string;
  email: string | null;
  session: string | null;
  /** The newest Pass the worker issued, exactly as received. */
  pass: string | null;
  /** serverNow − local clock at the last renewal, so a wrong PC clock can't expire a Pass early. */
  serverOffsetMs: number;
  /** Set when a sign-in was ended by one on another computer. */
  replaced: boolean;
  /** Set when the server answered signed_out for a session this computer still held. */
  needsSignIn: boolean;
}

interface PassPayload {
  v: 1;
  email: string;
  deviceId: string;
  iat: number;
  exp: number;
}

const _account = writable<CardAccount>({ kind: "signed_out" });
export const cardAccount: Readable<CardAccount> = { subscribe: _account.subscribe };

/** null until account.db has been read. */
let stored: Stored | null = null;
/** The stored Pass's payload, once its signature has checked out. Memory only. */
let passPayload: PassPayload | null = null;
/** The code just sent. Memory only: a restart mid-sign-in starts over. */
let pending: { email: string; challenge: string } | null = null;
let awaitingPayment = false;
/** From the last answer about this subscription; memory only (renewal re-learns it at launch). */
let paymentFailed = false;
let renewTimer: ReturnType<typeof setTimeout> | null = null;
let inFlightRenew: Promise<void> | null = null;

export async function initCardPremium(): Promise<void> {
  await load();
  publish();
  if (stored?.session) await renewNow();
  scheduleRenewal(RENEW_EVERY_MS);
}

export async function startSignIn(email: string): Promise<void> {
  await load(); // a load that failed at launch gets another chance here
  const reply = await call("/auth/start", { email }, START_FAILURES);
  if (reply.ok !== true || typeof reply.challenge !== "string") {
    throw new SignInError("unreachable");
  }
  pending = { email: email.trim(), challenge: reply.challenge };
  publish();
}

export async function confirmCode(code: string): Promise<void> {
  if (!pending) throw new SignInError("code_expired");
  const device = await load();
  const reply = await call(
    "/auth/verify",
    { challenge: pending.challenge, code: code.trim(), deviceId: device.deviceId },
    VERIFY_FAILURES
  );
  if (typeof reply.session !== "string" || typeof reply.email !== "string") {
    throw new SignInError("unreachable");
  }
  // The worker has already made this the account's Device, so this run is signed in even if
  // saving it fails; the failure only means the next launch won't remember it.
  stored = {
    ...device,
    email: reply.email,
    session: reply.session,
    pass: null,
    replaced: false,
    needsSignIn: false,
  };
  passPayload = null;
  pending = null;
  publish();
  await persist();
  // Someone who already pays, signing in on a new computer, gets Premium straight away.
  await renewNow();
}

/**
 * Opens Stripe Checkout in the browser, then renews every few seconds until the payment shows
 * up (or 10 minutes pass). Throws a SignInError if Checkout couldn't be started.
 */
export async function subscribe(): Promise<void> {
  const s = await load();
  if (!s.session) throw new SignInError("unreachable");
  const reply = await call("/checkout", { session: s.session }, {});
  if (await applyReason(reply)) return;
  if (reply.alreadyPremium === true) {
    await renewNow();
    return;
  }
  if (reply.paymentFailed === true) {
    paymentFailed = true;
    publish();
    return;
  }
  if (typeof reply.url !== "string" || !reply.url.startsWith("https://")) {
    throw new SignInError("unreachable");
  }
  await openUrl(reply.url);
  awaitingPayment = true;
  publish();
  pollForPayment(Date.now() + CHECKOUT_POLL_FOR_MS);
}

/**
 * Opens Stripe's Customer Portal: cancel, or change the card. When Premium is off because a
 * charge was declined, it then renews every few seconds (up to 10 minutes) so Premium returns by
 * itself once Stripe's retry with the new card goes through.
 */
export async function manageSubscription(): Promise<void> {
  const s = await load();
  if (!s.session) throw new SignInError("unreachable");
  const reply = await call("/portal", { session: s.session }, {});
  if (await applyReason(reply)) return;
  if (typeof reply.url !== "string" || !reply.url.startsWith("https://")) {
    throw new SignInError("unreachable");
  }
  await openUrl(reply.url);
  if (!isPremiumNow(s, passPayload)) {
    awaitingPayment = true;
    publish();
    pollForPayment(Date.now() + CHECKOUT_POLL_FOR_MS);
  }
}

/**
 * Also abandons a sign-in that's waiting for its code. The device id is kept. Tells the worker to
 * end the session too, best effort: this computer is signed out whether or not that call lands
 * (offline, worker down), and a session left alive server-side is harmless, it just can't renew
 * once another sign-in replaces it.
 */
export async function signOut(): Promise<void> {
  const session = stored?.session;
  pending = null;
  awaitingPayment = false;
  paymentFailed = false;
  passPayload = null;
  if (stored) stored = { ...stored, email: null, session: null, pass: null, replaced: false, needsSignIn: false };
  publish();
  if (session) call("/auth/signout", { session }, {}).catch(() => {});
  if (stored) await persist();
}

// ── Renewal ────────────────────────────────────────────────────────────────────────────────

/** One renewal at a time: a second caller waits for the one already running. */
function renewNow(): Promise<void> {
  inFlightRenew ??= renew().finally(() => (inFlightRenew = null));
  return inFlightRenew;
}

async function renew(): Promise<void> {
  const s = stored;
  if (!s?.session) return;
  let reply: Record<string, unknown>;
  try {
    reply = await call("/pass/renew", { session: s.session }, {});
  } catch {
    // Couldn't reach the server, or it couldn't reach Stripe: never a reason to drop Premium.
    // The Pass stays as it is, and grace (isPremiumNow) covers it past expiry.
    publish();
    return;
  }
  // Signed out (or in again) while this was in flight: the answer is about a stale session.
  if (stored?.session !== s.session) return;
  if (await applyReason(reply)) return;

  const serverNow = typeof reply.serverNow === "number" ? reply.serverNow : null;
  const payload = typeof reply.pass === "string" ? await verifyPass(reply.pass, s) : null;
  if (!payload || serverNow === null) {
    // A 200 that isn't a valid Pass is garbage, not an answer: treated like no reply at all.
    publish();
    return;
  }
  passPayload = payload;
  awaitingPayment = false;
  paymentFailed = false;
  await update({
    pass: reply.pass as string,
    serverOffsetMs: serverNow - Date.now(),
  });
}

/** Acts on a definite `reason`, if the reply has one. Returns whether it did. */
async function applyReason(reply: Record<string, unknown>): Promise<boolean> {
  switch (reply.reason) {
    case "not_paid":
      // Still signed in; just not Premium. A pending Checkout keeps polling.
      passPayload = null;
      paymentFailed = reply.paymentFailed === true;
      await update({ pass: null });
      return true;
    case "no_subscription":
      // The portal has nothing to show someone who never checked out. Not a sign-out.
      paymentFailed = false;
      publish();
      return true;
    case "signed_out":
      // Only this computer can end its own session (signOut), and a sign-in elsewhere answers
      // device_replaced. So the server not knowing a session we still hold means the server lost
      // it: our failure, not the player's. Decision 5: keep the Pass until it expires (no grace),
      // and ask them to sign in again.
      awaitingPayment = false;
      paymentFailed = false;
      await update({ session: null, needsSignIn: true, replaced: false });
      return true;
    case "device_replaced":
      passPayload = null;
      awaitingPayment = false;
      paymentFailed = false;
      await update({
        email: null,
        session: null,
        pass: null,
        replaced: true,
        needsSignIn: false,
      });
      return true;
    default:
      return false;
  }
}

function scheduleRenewal(delay: number): void {
  if (renewTimer) clearTimeout(renewTimer);
  renewTimer = setTimeout(async () => {
    await renewNow().catch(() => {});
    publish(); // expiry is time-based: re-evaluate even if nothing came back
    scheduleRenewal(RENEW_EVERY_MS);
  }, delay);
}

function pollForPayment(until: number): void {
  setTimeout(async () => {
    if (!awaitingPayment) return;
    await renewNow().catch(() => {});
    if (passPayload || Date.now() >= until || !stored?.session) {
      awaitingPayment = false;
      publish();
      return;
    }
    pollForPayment(until);
  }, CHECKOUT_POLL_MS);
}

// ── The Pass ───────────────────────────────────────────────────────────────────────────────

let publicKey: Promise<CryptoKey> | null = null;

/** The payload if `pass` is signed by the worker and is for this device and account, else null. */
async function verifyPass(pass: string, s: Stored): Promise<PassPayload | null> {
  try {
    const [body, sig, extra] = pass.split(".");
    if (!body || !sig || extra !== undefined) return null;
    publicKey ??= crypto.subtle.importKey(
      "jwk",
      PASS_PUBLIC_KEY,
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["verify"]
    );
    const ok = await crypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" },
      await publicKey,
      fromBase64url(sig),
      new TextEncoder().encode(body)
    );
    if (!ok) return null;
    const p = JSON.parse(new TextDecoder().decode(fromBase64url(body)));
    if (p?.v !== 1 || typeof p.exp !== "number" || typeof p.iat !== "number") return null;
    if (p.deviceId !== s.deviceId || p.email !== s.email) return null;
    return p as PassPayload;
  } catch {
    return null;
  }
}

function fromBase64url(s: string): Uint8Array<ArrayBuffer> {
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

/**
 * Premium now? A Pass that hasn't expired by the server's clock, or one that expired less than
 * 7 days ago (grace).
 *
 * Grace needs no "was the server unreachable?" flag: every definite answer deletes the Pass
 * (applyReason) and every good renewal replaces it, so an expired Pass still being here means
 * no answer has come back since it was issued. That also covers launch, before the first
 * renewal returns, so a returning player doesn't see Premium blink off and on.
 */
function isPremiumNow(s: Stored, p: PassPayload | null): boolean {
  if (!p) return false;
  const serverNow = Date.now() + s.serverOffsetMs;
  if (s.session) return serverNow - p.exp < GRACE_MS;
  // Lost by the server (signed_out): honour the Pass to its expiry, but no grace on top.
  return s.needsSignIn && serverNow < p.exp;
}

// ── account.db ─────────────────────────────────────────────────────────────────────────────

async function update(patch: Partial<Stored>): Promise<void> {
  if (!stored) return;
  stored = { ...stored, ...patch };
  publish();
  await persist().catch(() => {}); // this run already has the new state; see confirmCode
}

async function load(): Promise<Stored> {
  if (stored) return stored;
  let text: string | null;
  try {
    text = await loadCardState();
  } catch {
    throw new SignInError("storage");
  }
  const fromDisk = parseStored(text);
  stored = fromDisk ?? {
    deviceId: crypto.randomUUID(),
    email: null,
    session: null,
    pass: null,
    serverOffsetMs: 0,
    replaced: false,
    needsSignIn: false,
  };
  if (!fromDisk) await persist();
  // A stored Pass is re-checked on every launch; it counts only if its signature still holds.
  passPayload = stored.pass ? await verifyPass(stored.pass, stored) : null;
  return stored;
}

async function persist(): Promise<void> {
  try {
    await saveCardState(JSON.stringify(stored));
  } catch {
    throw new SignInError("storage");
  }
}

function publish(): void {
  const s = stored;
  let next: CardAccount;
  if (pending) next = { kind: "code_sent", email: pending.email };
  else if (s?.session && s.email) {
    next = isPremiumNow(s, passPayload)
      ? { kind: "premium", email: s.email }
      : {
          kind: "signed_in",
          email: s.email,
          ...(awaitingPayment ? { awaitingPayment: true } : {}),
          ...(paymentFailed ? { paymentFailed: true } : {}),
        };
  } else if (s?.needsSignIn && s.email) {
    next = { kind: "sign_in_again", email: s.email, premium: isPremiumNow(s, passPayload) };
  } else if (s?.replaced) next = { kind: "replaced" };
  else next = { kind: "signed_out" };
  _account.set(next);
  cardPremium.set(next.kind === "premium" || (next.kind === "sign_in_again" && next.premium));
}

function parseStored(text: string | null): Stored | null {
  if (!text) return null;
  try {
    const s = JSON.parse(text);
    if (typeof s?.deviceId !== "string" || !s.deviceId) return null;
    return {
      deviceId: s.deviceId,
      email: typeof s.email === "string" ? s.email : null,
      session: typeof s.session === "string" ? s.session : null,
      pass: typeof s.pass === "string" ? s.pass : null,
      serverOffsetMs: Number.isFinite(s.serverOffsetMs) ? s.serverOffsetMs : 0,
      replaced: s.replaced === true,
      needsSignIn: s.needsSignIn === true,
    };
  } catch {
    return null;
  }
}

const START_FAILURES: Record<string, SignInFailure> = {
  bad_request: "bad_email",
  rate_limited: "rate_limited",
  email_failed: "email_failed",
};

// bad_request here can only mean a mangled challenge or device id; starting over fixes both.
const VERIFY_FAILURES: Record<string, SignInFailure> = {
  wrong_code: "wrong_code",
  code_expired: "code_expired",
  bad_request: "code_expired",
};

/**
 * POST to the worker. Resolves with the reply's body; rejects with a SignInError taken from
 * the body's `error` code. The HTTP status is never read: callers recognise success by its
 * shape, and anything else (network error, timeout, an HTML error page) is "unreachable".
 */
async function call(
  path: string,
  body: object,
  failures: Record<string, SignInFailure>
): Promise<Record<string, unknown>> {
  // ⚠ Not AbortSignal.timeout: Tauri's fetch never removes its abort listener, so a timeout
  // firing after the reply was read cancels a request Rust has already freed. That rejects
  // with "resource id is invalid" outside any await, and main.ts blanks the whole app on it.
  // The timer has to die with the request.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  let reply: unknown;
  try {
    const res = await fetch(BILLING_URL + path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    reply = await res.json();
  } catch {
    throw new SignInError("unreachable");
  } finally {
    clearTimeout(timer);
  }
  if (!reply || typeof reply !== "object" || Array.isArray(reply)) {
    throw new SignInError("unreachable");
  }
  const r = reply as Record<string, unknown>;
  if (typeof r.error === "string") {
    throw new SignInError(Object.hasOwn(failures, r.error) ? failures[r.error] : "unreachable");
  }
  return r;
}
