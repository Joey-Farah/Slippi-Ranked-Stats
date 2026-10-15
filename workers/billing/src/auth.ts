// Sign-in with an emailed 6-digit code. The email is the account.
//
// /auth/start emails a code and answers with a random challenge; /auth/verify takes the two
// together. Only the app that asked holds the challenge, so someone who merely knows a
// player's email can't spend that code's tries or retire it. They can still ask for codes of
// their own, which is what the per-email limits bound: at most 10 codes × 5 tries a day.

import { sendSignInCode } from "./email";
import { json } from "./http";

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

const CODE_TTL_MS = 10 * MINUTE;
const MAX_ATTEMPTS = 5;
const CODES_PER_EMAIL_PER_HOUR = 5;
const CODES_PER_EMAIL_PER_DAY = 10;
const CODES_PER_IP_PER_HOUR = 20;

export async function startSignIn(request: Request, env: Env): Promise<Response> {
  const body = await readJson(request);
  const email = normalizeEmail(body?.email);
  if (!email) return json({ error: "bad_request" }, 400);

  const now = Date.now();
  const challenge = randomToken();
  const code = randomCode();
  // The limits are checked inside the INSERT, as one statement, so a burst of parallel
  // requests can't all pass a separate count before any of them writes. They apply whether or
  // not the account exists, so the answer reveals nothing about who has signed up.
  const inserted = await env.DB.prepare(
    `INSERT INTO login_codes (challenge_hash, email, ip_bucket, code_hash, created_at)
     SELECT ?1, ?2, ?3, ?4, ?5
     WHERE (SELECT COUNT(*) FROM login_codes WHERE email = ?2 AND created_at > ?6) < ?7
       AND (SELECT COUNT(*) FROM login_codes WHERE email = ?2 AND created_at > ?8) < ?9
       AND (SELECT COUNT(*) FROM login_codes WHERE ip_bucket = ?3 AND created_at > ?6) < ?10`,
  )
    .bind(
      await sha256(challenge),
      email,
      rateBucket(request.headers.get("CF-Connecting-IP") ?? "unknown"),
      await sha256(`${challenge}:${code}`),
      now,
      now - HOUR,
      CODES_PER_EMAIL_PER_HOUR,
      now - DAY,
      CODES_PER_EMAIL_PER_DAY,
      CODES_PER_IP_PER_HOUR,
    )
    .run();
  if (inserted.meta.changes !== 1) return json({ error: "rate_limited" }, 429);

  try {
    await sendSignInCode(env, email, code);
  } catch (err) {
    console.error("sign-in email failed:", err);
    // Nobody received this code, so it shouldn't use up a rate-limit slot: an email outage
    // would otherwise lock players out for an hour after it ends.
    await env.DB.prepare("DELETE FROM login_codes WHERE id = ?")
      .bind(inserted.meta.last_row_id)
      .run();
    return json({ error: "email_failed" }, 502);
  }
  return json({ ok: true, challenge });
}

export async function verifySignIn(request: Request, env: Env): Promise<Response> {
  const body = await readJson(request);
  const challenge = boundedString(body?.challenge, 200);
  const code = boundedString(body?.code, 20).trim();
  const deviceId = boundedString(body?.deviceId, 128);
  if (!challenge || !deviceId) return json({ error: "bad_request" }, 400);

  const row = await env.DB.prepare(
    "SELECT id, email, code_hash, created_at FROM login_codes WHERE challenge_hash = ?",
  )
    .bind(await sha256(challenge))
    .first<{ id: number; email: string; code_hash: string; created_at: number }>();
  if (!row || Date.now() - row.created_at > CODE_TTL_MS) {
    return json({ error: "code_expired" }, 400);
  }
  // Count the try before checking it, in one conditional write, so parallel guesses can't
  // slip past the cap.
  const tried = await env.DB.prepare(
    `UPDATE login_codes SET attempts = attempts + 1
     WHERE id = ? AND attempts < ? AND used = 0
     RETURNING attempts`,
  )
    .bind(row.id, MAX_ATTEMPTS)
    .first<{ attempts: number }>();
  if (!tried) return json({ error: "code_expired" }, 400);
  if (row.code_hash !== (await sha256(`${challenge}:${code}`))) {
    const left = MAX_ATTEMPTS - tried.attempts;
    return json({ error: left > 0 ? "wrong_code" : "code_expired" }, 400);
  }
  // Claimed in one conditional write, so two requests racing with the same code can't both win.
  const claim = await env.DB.prepare("UPDATE login_codes SET used = 1 WHERE id = ? AND used = 0")
    .bind(row.id)
    .run();
  if (claim.meta.changes !== 1) return json({ error: "code_expired" }, 400);

  const now = Date.now();
  const account = await env.DB.prepare(
    `INSERT INTO accounts (email, created_at) VALUES (?, ?)
     ON CONFLICT (email) DO UPDATE SET email = excluded.email
     RETURNING id`,
  )
    .bind(row.email, now)
    .first<{ id: number }>();

  // Newest sign-in wins: the account's live session, if any, is marked replaced (kept, not
  // deleted) in the same transaction that issues this one.
  const session = randomToken();
  await env.DB.batch([
    env.DB.prepare(
      "UPDATE sessions SET replaced_at = ? WHERE account_id = ? AND replaced_at IS NULL",
    ).bind(now, account!.id),
    env.DB.prepare(
      "INSERT INTO sessions (session_hash, account_id, device_id, created_at) VALUES (?, ?, ?, ?)",
    ).bind(await sha256(session), account!.id, deviceId, now),
  ]);

  return json({ session, email: row.email });
}

/**
 * Ends a session for good, so a later renewal with it answers `signed_out`. Only the holder of
 * the session can end it. Always `{ok: true}`, whether or not the session existed: signing out
 * twice, or after another computer replaced this one, isn't an error. A replaced session is left
 * on record (deleting it would turn that computer's `device_replaced` into `signed_out`).
 */
export async function signOut(request: Request, env: Env): Promise<Response> {
  const session = boundedString((await readJson(request))?.session, 200);
  if (!session) return json({ error: "bad_request" }, 400);
  await env.DB.prepare("DELETE FROM sessions WHERE session_hash = ? AND replaced_at IS NULL")
    .bind(await sha256(session))
    .run();
  return json({ ok: true });
}

export async function readJson(request: Request): Promise<Record<string, unknown> | null> {
  try {
    const body = await request.json();
    return body && typeof body === "object" ? (body as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export function boundedString(value: unknown, max: number): string {
  return typeof value === "string" && value.length <= max ? value : "";
}

// A plain address only. Anything Resend would parse as more than one recipient or as a
// display name ("a<b@c.d>", "a@b.c,d@e.f", quoted local parts) is refused rather than
// normalised, so one mailbox can't be given several identities to dodge the per-email limits.
const EMAIL_RE =
  /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/;

function normalizeEmail(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const email = value.trim().toLowerCase();
  return email.length <= 254 && EMAIL_RE.test(email) ? email : null;
}

/** IPv4 as is; IPv6 by its /64, since a single user is routinely handed a whole /64. */
function rateBucket(ip: string): string {
  if (!ip.includes(":")) return ip;
  if (ip.includes(".")) return ip.slice(ip.lastIndexOf(":") + 1); // IPv4-mapped
  const [head, tail] = ip.toLowerCase().split("::");
  const left = head ? head.split(":") : [];
  const right = tail ? tail.split(":") : [];
  const groups =
    tail === undefined
      ? left
      : [...left, ...Array(8 - left.length - right.length).fill("0"), ...right];
  return groups.slice(0, 4).map((g) => g.replace(/^0+(?=.)/, "")).join(":") + "::/64";
}

/** Uniform over 000000–999999: rejection-samples away the modulo bias of a raw u32. */
function randomCode(): string {
  const buf = new Uint32Array(1);
  do crypto.getRandomValues(buf);
  while (buf[0] >= 4_294_000_000);
  return String(buf[0] % 1_000_000).padStart(6, "0");
}

function randomToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

export async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
