// Premium bought with a card: the app half of the srs-billing worker (workers/billing/).
// Plan and decisions: docs/plans/direct-billing.md. Terms (Premium, Subscription, Device, Pass):
// CONTEXT.md.
//
// The email is the account. Signing in is an emailed 6-digit code, which the worker trades for
// a session tied to this install's device id. Both are kept in account.db (see db.ts), not in
// localStorage, so they survive whatever has been wiping the Discord route's tokens.
//
// ⚠ Dev builds only until slice 8 of the plan: every entry point is behind import.meta.env.DEV.
// This route is separate from the Discord one and doesn't touch `isPremium` yet.

import { writable, type Readable } from "svelte/store";
import { fetch } from "@tauri-apps/plugin-http";
import { loadCardState, saveCardState } from "./db";

const BILLING_URL = "https://srs-billing-staging.joeyfarah.workers.dev";
const REQUEST_TIMEOUT_MS = 15_000;

export type CardAccount =
  | { kind: "signed_out" }
  | { kind: "code_sent"; email: string }
  | { kind: "signed_in"; email: string };

/** Why a sign-in step failed. Everything that isn't a definite answer is "unreachable". */
export type SignInFailure =
  | "bad_email"
  | "wrong_code"
  | "code_expired"
  | "rate_limited"
  | "email_failed"
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
}

const _account = writable<CardAccount>({ kind: "signed_out" });
export const cardAccount: Readable<CardAccount> = { subscribe: _account.subscribe };

let stored: Stored = { deviceId: "", email: null, session: null };
/** The email a code was just sent to. Memory only: a restart mid-sign-in starts over. */
let pendingEmail: string | null = null;

export async function initCardPremium(): Promise<void> {
  const fromDisk = parseStored(await loadCardState());
  stored = fromDisk ?? { deviceId: crypto.randomUUID(), email: null, session: null };
  if (!fromDisk) await saveCardState(JSON.stringify(stored));
  publish();
}

export async function startSignIn(email: string): Promise<void> {
  const reply = await call("/auth/start", { email });
  if (reply.ok !== true) throw new SignInError("unreachable");
  pendingEmail = email.trim();
  publish();
}

export async function confirmCode(code: string): Promise<void> {
  if (!pendingEmail) throw new SignInError("code_expired");
  const reply = await call("/auth/verify", {
    email: pendingEmail,
    code: code.trim(),
    deviceId: stored.deviceId,
  });
  if (typeof reply.session !== "string" || typeof reply.email !== "string") {
    throw new SignInError("unreachable");
  }
  stored = { ...stored, email: reply.email, session: reply.session };
  await saveCardState(JSON.stringify(stored));
  pendingEmail = null;
  publish();
}

/** Also abandons a sign-in that's waiting for its code. The device id is kept. */
export async function signOut(): Promise<void> {
  pendingEmail = null;
  stored = { ...stored, email: null, session: null };
  await saveCardState(JSON.stringify(stored));
  publish();
}

function publish(): void {
  if (pendingEmail) _account.set({ kind: "code_sent", email: pendingEmail });
  else if (stored.session && stored.email) _account.set({ kind: "signed_in", email: stored.email });
  else _account.set({ kind: "signed_out" });
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
    };
  } catch {
    return null;
  }
}

const WORKER_FAILURES: Record<string, SignInFailure> = {
  bad_request: "bad_email",
  wrong_code: "wrong_code",
  code_expired: "code_expired",
  rate_limited: "rate_limited",
  email_failed: "email_failed",
};

/**
 * POST to the worker. Resolves with the reply's body; rejects with a SignInError taken from
 * the body's `error` code. The HTTP status is never read: callers recognise success by its
 * shape, and anything else (network error, timeout, an HTML error page) is "unreachable".
 */
async function call(path: string, body: object): Promise<Record<string, unknown>> {
  let reply: unknown;
  try {
    const res = await fetch(BILLING_URL + path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    reply = await res.json();
  } catch {
    throw new SignInError("unreachable");
  }
  if (!reply || typeof reply !== "object" || Array.isArray(reply)) {
    throw new SignInError("unreachable");
  }
  const r = reply as Record<string, unknown>;
  if (typeof r.error === "string") throw new SignInError(WORKER_FAILURES[r.error] ?? "unreachable");
  return r;
}
