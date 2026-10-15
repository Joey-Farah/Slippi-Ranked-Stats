// The few Stripe calls the worker makes, over plain fetch: no SDK, so the worker has no runtime
// dependencies and tests fake Stripe at the same fetch boundary as Resend.

// Managed Payments needs 2025-03-31.basil or later. Pinned so a dashboard default can't change
// response shapes under us.
const STRIPE_VERSION = "2025-03-31.basil";

/** Stripe couldn't be reached, or answered with something other than a definite result. */
export class StripeUnreachable extends Error {
  name = "StripeUnreachable";
}

type Param = string | number | boolean | Params | Params[] | undefined;
interface Params {
  [key: string]: Param;
}

export async function stripeRequest<T>(
  env: Env,
  method: "GET" | "POST",
  path: string,
  params: Params = {},
  idempotencyKey?: string,
): Promise<T> {
  const form = formEncode(params);
  const url = `https://api.stripe.com/v1${path}` + (method === "GET" && form ? `?${form}` : "");
  const headers: Record<string, string> = {
    authorization: `Bearer ${env.STRIPE_SECRET_KEY}`,
    "stripe-version": STRIPE_VERSION,
  };
  if (method === "POST") headers["content-type"] = "application/x-www-form-urlencoded";
  if (idempotencyKey) headers["idempotency-key"] = idempotencyKey;

  let res: Response;
  try {
    res = await fetch(url, { method, headers, body: method === "POST" ? form : undefined });
  } catch (err) {
    throw new StripeUnreachable(`Stripe ${method} ${path}: ${err}`);
  }
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new StripeUnreachable(`Stripe ${method} ${path} answered ${res.status}: ${detail.slice(0, 300)}`);
  }
  try {
    return (await res.json()) as T;
  } catch {
    throw new StripeUnreachable(`Stripe ${method} ${path}: unparseable body`);
  }
}

/** Stripe's bracketed form encoding: {a: {b: 1}, c: [{d: 2}]} → a[b]=1&c[0][d]=2. */
export function formEncode(params: Params, prefix = ""): string {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined) continue;
    const name = prefix ? `${prefix}[${key}]` : key;
    if (Array.isArray(value)) {
      value.forEach((item, i) => parts.push(formEncode(item, `${name}[${i}]`)));
    } else if (typeof value === "object") {
      parts.push(formEncode(value, name));
    } else {
      parts.push(`${encodeURIComponent(name)}=${encodeURIComponent(String(value))}`);
    }
  }
  return parts.filter(Boolean).join("&");
}

const SIGNATURE_TOLERANCE_S = 300;

/**
 * Checks a webhook's Stripe-Signature header: HMAC-SHA256 of `${t}.${body}` keyed with the
 * endpoint's signing secret, within 5 minutes of now (so a captured event can't be replayed
 * later). Equivalent to the SDK's constructEventAsync.
 */
export async function verifyWebhookSignature(
  body: string,
  header: string | null,
  secret: string,
  nowMs = Date.now(),
): Promise<boolean> {
  if (!header || !secret) return false;
  let timestamp = "";
  const signatures: string[] = [];
  for (const part of header.split(",")) {
    const [k, v] = part.split("=", 2);
    if (k === "t") timestamp = v ?? "";
    else if (k === "v1" && v) signatures.push(v);
  }
  const t = Number(timestamp);
  if (!timestamp || !Number.isFinite(t) || signatures.length === 0) return false;
  if (Math.abs(nowMs / 1000 - t) > SIGNATURE_TOLERANCE_S) return false;

  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${timestamp}.${body}`));
  const expected = [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return signatures.some((s) => timingSafeEqual(s, expected));
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** The parts of a Stripe subscription the worker reads. */
export interface StripeSubscription {
  id: string;
  customer: string;
  status: string;
  /** Moved onto the items in 2025-03-31.basil; read from either. Seconds. */
  current_period_end?: number;
  items?: { data?: { current_period_end?: number }[] };
}

export function periodEndMs(sub: StripeSubscription): number | null {
  const s = sub.current_period_end ?? sub.items?.data?.[0]?.current_period_end;
  return typeof s === "number" ? s * 1000 : null;
}
