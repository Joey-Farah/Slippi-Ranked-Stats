// Sign-in with an emailed 6-digit code. The email is the account.

import { sendSignInCode } from "./email";
import { json } from "./http";

export async function startSignIn(request: Request, env: Env): Promise<Response> {
  const body = await readJson(request);
  const email = normalizeEmail(body?.email);
  if (!email) return json({ error: "bad_request" }, 400);

  const code = randomCode();
  await env.DB.prepare(
    "INSERT INTO login_codes (email, ip, code_hash, created_at) VALUES (?, ?, ?, ?)",
  )
    .bind(email, clientIp(request), await sha256(`${email}:${code}`), Date.now())
    .run();

  await sendSignInCode(env, email, code);
  return json({ ok: true });
}

export async function verifySignIn(request: Request, env: Env): Promise<Response> {
  const body = await readJson(request);
  const email = normalizeEmail(body?.email);
  const code = typeof body?.code === "string" ? body.code.trim() : "";
  const deviceId = typeof body?.deviceId === "string" ? body.deviceId : "";
  if (!email || !deviceId) return json({ error: "bad_request" }, 400);

  const row = await env.DB.prepare(
    "SELECT id, code_hash FROM login_codes WHERE email = ? ORDER BY id DESC LIMIT 1",
  )
    .bind(email)
    .first<{ id: number; code_hash: string }>();
  if (!row) return json({ error: "code_expired" }, 400);
  if (row.code_hash !== (await sha256(`${email}:${code}`))) {
    return json({ error: "wrong_code" }, 400);
  }

  const now = Date.now();
  const account = await env.DB.prepare(
    `INSERT INTO accounts (email, created_at) VALUES (?, ?)
     ON CONFLICT (email) DO UPDATE SET email = excluded.email
     RETURNING id`,
  )
    .bind(email, now)
    .first<{ id: number }>();

  const session = randomToken();
  await env.DB.prepare(
    `INSERT INTO devices (account_id, device_id, session_hash, created_at) VALUES (?, ?, ?, ?)
     ON CONFLICT (account_id) DO UPDATE SET
       device_id = excluded.device_id,
       session_hash = excluded.session_hash,
       created_at = excluded.created_at`,
  )
    .bind(account!.id, deviceId, await sha256(session), now)
    .run();

  return json({ session, email });
}

async function readJson(request: Request): Promise<Record<string, unknown> | null> {
  try {
    const body = await request.json();
    return body && typeof body === "object" ? (body as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function normalizeEmail(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const email = value.trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) && email.length <= 254 ? email : null;
}

function clientIp(request: Request): string {
  return request.headers.get("CF-Connecting-IP") ?? "unknown";
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

async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
