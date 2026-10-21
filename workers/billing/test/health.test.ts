import { createExecutionContext, createScheduledController, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index";
import { runHealthCheck } from "../src/health";

// Stripe and Resend faked at the fetch boundary, as in the other suites.
let alerts: { to: string; subject: string; text: string }[];
let stripeDown: boolean;
let priceActive: boolean;

beforeEach(() => {
  alerts = [];
  stripeDown = false;
  priceActive = true;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.href === "https://api.resend.com/emails") {
      const body = JSON.parse(String(init?.body));
      alerts.push({ to: body.to, subject: body.subject, text: body.text });
      return Response.json({ id: "email_1" });
    }
    if (url.host === "api.stripe.com" && url.pathname === "/v1/prices/price_test_5usd") {
      if (stripeDown) return new Response("upstream timeout", { status: 503 });
      return Response.json({ id: "price_test_5usd", active: priceActive, recurring: { interval: "month" } });
    }
    throw new Error(`unexpected fetch: ${url}`);
  });
});

const HOUR = 60 * 60 * 1000;
const T0 = Date.UTC(2026, 9, 15, 12);

describe("the hourly self-test", () => {
  it("passes every check when everything works, and stays quiet", async () => {
    const results = await runHealthCheck(env, T0);
    expect(results.filter((r) => !r.ok)).toEqual([]);
    expect(results.map((r) => r.name)).toEqual(
      ["database", "stripe", "stripe webhook secret", "pass signing", "email"]);
    expect(alerts).toEqual([]);
  });

  it("emails the owner once when something breaks, not every hour, and once on recovery", async () => {
    await runHealthCheck(env, T0);
    stripeDown = true;
    await runHealthCheck(env, T0 + HOUR);
    await runHealthCheck(env, T0 + 2 * HOUR);
    await runHealthCheck(env, T0 + 3 * HOUR);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({ to: "owner@example.com", subject: expect.stringContaining("stripe failing") });
    expect(alerts[0].text).toContain("503");

    stripeDown = false;
    await runHealthCheck(env, T0 + 4 * HOUR);
    expect(alerts).toHaveLength(2);
    expect(alerts[1].subject).toContain("recovered");
    expect(alerts[1].text).toContain("180 min");
    await runHealthCheck(env, T0 + 5 * HOUR);
    expect(alerts).toHaveLength(2);
  });

  it("emails again if a DIFFERENT check starts failing while one already is", async () => {
    stripeDown = true;
    await runHealthCheck(env, T0);
    priceActive = false;
    stripeDown = false; // now the price check fails for another reason, same check name
    await runHealthCheck(env, T0 + HOUR);
    expect(alerts).toHaveLength(1); // still just "stripe": one alert
    const broken = { ...env, STRIPE_WEBHOOK_SECRET: "" };
    await runHealthCheck(broken, T0 + 2 * HOUR);
    expect(alerts).toHaveLength(2);
    expect(alerts[1].subject).toContain("stripe, stripe webhook secret");
  });

  it("catches a signing key the app can't verify, which would quietly end every subscriber's Premium", async () => {
    const other = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"])) as CryptoKeyPair;
    const wrongPublic = JSON.stringify(await crypto.subtle.exportKey("jwk", other.publicKey));
    const results = await runHealthCheck({ ...env, PASS_PUBLIC_KEY: wrongPublic }, T0);
    expect(results.find((r) => r.name === "pass signing")).toMatchObject({
      ok: false, detail: expect.stringContaining("does NOT verify"),
    });
    expect(alerts[0].subject).toContain("pass signing failing");
  });

  it("flags a missing app public key, and a missing email key", async () => {
    const results = await runHealthCheck({ ...env, PASS_PUBLIC_KEY: "", RESEND_API_KEY: "" }, T0);
    expect(results.filter((r) => !r.ok).map((r) => r.name)).toEqual(["pass signing", "email"]);
  });

  it("runs from the cron trigger", async () => {
    stripeDown = true;
    const ctx = createExecutionContext();
    await worker.scheduled!(createScheduledController({ cron: "17 * * * *" }), env, ctx);
    await waitOnExecutionContext(ctx);
    expect(alerts).toHaveLength(1);
    const row = await env.DB.prepare("SELECT status, failing FROM health").first();
    expect(row).toEqual({ status: "failing", failing: "stripe" });
  });
});
