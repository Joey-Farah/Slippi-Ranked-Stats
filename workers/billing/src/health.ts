// The hourly self-test (slice 6): everything a paying player depends on that could break without
// anyone noticing, checked end to end, with an email to the owner when the state CHANGES (once
// when something starts failing, once when it recovers), never every hour.
//
// Email, not Discord (Joey, 2026-10-15): the card route exists so nobody has to go through the
// Discord server, and the owner's alerts don't need it either. It reuses the Resend setup the
// sign-in codes already have. If Resend itself is down the alert can't go out, but then sign-in
// codes fail too and players report it.

import { sendAlert } from "./email";
import { secret } from "./http";
import { PASS_TTL_MS, signPass } from "./pass";
import { stripeRequest } from "./stripe";

export interface CheckResult {
  name: string;
  ok: boolean;
  detail?: string;
}

/** Each check, independently: one failing doesn't hide the others. */
export async function selfTest(env: Env): Promise<CheckResult[]> {
  const checks: [string, () => Promise<string | void>][] = [
    ["database", async () => {
      await env.DB.prepare("SELECT COUNT(*) FROM accounts").first();
    }],
    ["stripe", async () => {
      // Our key works and the Price Checkout sells exists and is on sale.
      const price = await stripeRequest<{ active: boolean; recurring: unknown }>(
        env, "GET", `/prices/${env.STRIPE_PRICE_ID}`);
      if (!price.active) return `price ${env.STRIPE_PRICE_ID} is not active`;
      if (!price.recurring) return `price ${env.STRIPE_PRICE_ID} is not a subscription price`;
    }],
    ["stripe webhook secret", async () => {
      if (!secret(env.STRIPE_WEBHOOK_SECRET).startsWith("whsec_")) return "STRIPE_WEBHOOK_SECRET is not set";
    }],
    ["pass signing", async () => {
      // Sign as for a real renewal, then verify with the public key the APP ships: a key the app
      // can't verify would quietly turn every renewal into "no valid Pass" for every subscriber.
      const now = Date.now();
      const pass = await signPass(env, { v: 1, email: "self-test@invalid", deviceId: "self-test", iat: now, exp: now + PASS_TTL_MS });
      if (!env.PASS_PUBLIC_KEY) return "PASS_PUBLIC_KEY (the app's public key) is not configured";
      const key = await crypto.subtle.importKey("jwk", JSON.parse(env.PASS_PUBLIC_KEY),
        { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
      const [body, sig] = pass.split(".");
      const b64 = (s: string) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));
      const ok = await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, key, b64(sig), new TextEncoder().encode(body));
      if (!ok) return "a Pass signed now does NOT verify with the app's public key";
    }],
    ["email", async () => {
      if (!secret(env.RESEND_API_KEY) && env.ALLOW_LOGGED_CODES !== "1") return "RESEND_API_KEY is not set";
    }],
  ];
  return Promise.all(checks.map(async ([name, run]): Promise<CheckResult> => {
    try {
      const problem = await run();
      return problem ? { name, ok: false, detail: problem } : { name, ok: true };
    } catch (err) {
      return { name, ok: false, detail: String(err).slice(0, 300) };
    }
  }));
}

/** Runs the self-test, records it, and emails the owner if the state changed. */
export async function runHealthCheck(env: Env, now = Date.now()): Promise<CheckResult[]> {
  const results = await selfTest(env);
  const failing = results.filter((r) => !r.ok);
  const status = failing.length ? "failing" : "ok";
  const failingNames = failing.map((r) => r.name).join(", ");

  const prev = await env.DB.prepare("SELECT status, failing, since FROM health WHERE id = 1")
    .first<{ status: string; failing: string | null; since: number }>();
  const changed = !prev ? status === "failing" : prev.status !== status || (prev.failing ?? "") !== failingNames;
  const since = !prev || prev.status !== status ? now : prev.since;

  await env.DB.prepare(
    `INSERT INTO health (id, status, failing, since, checked_at) VALUES (1, ?, ?, ?, ?)
     ON CONFLICT (id) DO UPDATE SET status = excluded.status, failing = excluded.failing,
       since = excluded.since, checked_at = excluded.checked_at`,
  ).bind(status, failingNames || null, since, now).run();

  if (changed) {
    const where = env.ENVIRONMENT_NAME ?? "card billing";
    if (status === "failing") {
      await sendAlert(env, `⚠ Slippi Ranked Stats ${where}: ${failingNames} failing`, [
        `The hourly self-test of ${where} found a problem (${new Date(now).toISOString()}):`,
        "",
        ...failing.map((r) => `- ${r.name}: ${r.detail ?? "failed"}`),
        "",
        "Card subscribers keep Premium for 7 days past their Pass while the server can't answer,",
        "so this isn't locking anyone out yet. You'll get one more email when it recovers.",
      ].join("\n"));
    } else if (prev && prev.status === "failing") {
      const mins = Math.round((now - prev.since) / 60000);
      await sendAlert(env, `✓ Slippi Ranked Stats ${where}: recovered`,
        `Every self-test check passes again (${new Date(now).toISOString()}), after about ${mins} min failing.`);
    }
  }
  return results;
}
