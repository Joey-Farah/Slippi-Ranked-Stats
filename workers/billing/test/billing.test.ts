import { env, exports } from "cloudflare:workers";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Stripe and Resend are both faked at the fetch boundary. The fake Stripe holds customers and
// subscriptions in memory; a test "pays" by putting an active subscription there, exactly what
// Checkout would leave behind.
interface FakeSub {
  id: string;
  customer: string;
  status: string;
  items: { data: { current_period_end: number }[] };
}
let sent: { to: string; text: string }[] = [];
let stripe: {
  down: boolean;
  customers: { id: string; email: string; idempotencyKey: string | null }[];
  subs: FakeSub[];
  checkouts: URLSearchParams[];
  calls: string[];
};

beforeEach(() => {
  sent = [];
  stripe = { down: false, customers: [], subs: [], checkouts: [], calls: [] };
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.href === "https://api.resend.com/emails") {
      const body = JSON.parse(String(init?.body));
      sent.push({ to: [body.to].flat()[0], text: body.text });
      return Response.json({ id: "email_1" });
    }
    if (url.host !== "api.stripe.com") throw new Error(`unexpected fetch: ${url}`);
    const headers = new Headers(init?.headers);
    expect(headers.get("authorization")).toBe("Bearer sk_test_fake");
    expect(headers.get("stripe-version")).toBe("2025-03-31.basil");
    stripe.calls.push(`${init?.method} ${url.pathname}`);
    if (stripe.down) return new Response("upstream timeout", { status: 503 });

    const form = new URLSearchParams(String(init?.body ?? ""));
    if (init?.method === "GET" && url.pathname === "/v1/subscriptions") {
      expect(url.searchParams.get("status")).toBe("all");
      const data = stripe.subs.filter((s) => s.customer === url.searchParams.get("customer"));
      return Response.json({ object: "list", data });
    }
    if (init?.method === "POST" && url.pathname === "/v1/customers") {
      const key = headers.get("idempotency-key");
      const existing = stripe.customers.find((c) => key && c.idempotencyKey === key);
      if (existing) return Response.json({ id: existing.id });
      const customer = { id: `cus_${stripe.customers.length + 1}`, email: form.get("email")!, idempotencyKey: key };
      stripe.customers.push(customer);
      return Response.json({ id: customer.id });
    }
    if (init?.method === "POST" && url.pathname === "/v1/checkout/sessions") {
      stripe.checkouts.push(form);
      return Response.json({ id: "cs_test_1", url: "https://checkout.stripe.com/c/pay/cs_test_1" });
    }
    throw new Error(`unexpected Stripe call: ${init?.method} ${url.pathname}`);
  });
});

const ORIGIN = "https://billing.test";
const DAY = 24 * 60 * 60 * 1000;

async function call(path: string, body: unknown, headers: Record<string, string> = {}) {
  const res = await exports.default.fetch(
    new Request(`${ORIGIN}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", "CF-Connecting-IP": "203.0.113.7", ...headers },
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
  );
  return { status: res.status, body: (await res.json()) as Record<string, any> };
}

/** Signs in through the real endpoints; returns the session. */
async function signIn(email = "player@example.com", deviceId = "device-a"): Promise<string> {
  const start = await call("/auth/start", { email });
  const code = sent.filter((m) => m.to === email).at(-1)!.text.match(/\b\d{6}\b/)![0];
  const verify = await call("/auth/verify", { challenge: start.body.challenge, code, deviceId });
  expect(verify.status).toBe(200);
  return verify.body.session;
}

const renew = (session: string) => call("/pass/renew", { session });
const checkout = (session: string) => call("/checkout", { session });

/** What paying at Checkout leaves in Stripe. */
function pay(customer = stripe.customers.at(-1)!.id, status = "active", id = "sub_1"): FakeSub {
  const sub = { id, customer, status, items: { data: [{ current_period_end: 1_900_000_000 }] } };
  stripe.subs = stripe.subs.filter((s) => s.id !== id).concat(sub);
  return sub;
}

async function webhook(type: string, sub: FakeSub, created = Math.floor(Date.now() / 1000), secret = "whsec_test_fake") {
  const body = JSON.stringify({ id: "evt_1", type, created, data: { object: sub } });
  const t = Math.floor(Date.now() / 1000);
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${t}.${body}`));
  const v1 = [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return call("/stripe/webhook", body, { "stripe-signature": `t=${t},v1=${v1}` });
}

/** Verifies a Pass the way the app does: public key only. */
async function readPass(pass: string): Promise<Record<string, any>> {
  const [body, sig] = pass.split(".");
  const key = await crypto.subtle.importKey("jwk", JSON.parse(env.TEST_PASS_PUBLIC_KEY), { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
  const bytes = (s: string) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));
  const ok = await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, key, bytes(sig), new TextEncoder().encode(body));
  if (!ok) throw new Error("bad signature");
  return JSON.parse(new TextDecoder().decode(bytes(body)));
}

describe("subscribing", () => {
  it("opens a Managed Payments Checkout for the signed-in account", async () => {
    const session = await signIn();
    const res = await checkout(session);

    expect(res).toMatchObject({ status: 200, body: { url: "https://checkout.stripe.com/c/pay/cs_test_1" } });
    const form = stripe.checkouts[0];
    expect(Object.fromEntries(form)).toMatchObject({
      mode: "subscription",
      customer: "cus_1",
      "line_items[0][price]": "price_test_5usd",
      "line_items[0][quantity]": "1",
      "managed_payments[enabled]": "true",
      success_url: `${ORIGIN}/checkout/done`,
      cancel_url: `${ORIGIN}/checkout/cancelled`,
    });
    expect(stripe.customers).toMatchObject([{ email: "player@example.com" }]);
  });

  it("reuses the account's Stripe customer on every later checkout", async () => {
    const session = await signIn();
    await checkout(session);
    await checkout(session);
    expect(stripe.customers).toHaveLength(1);
    expect(stripe.checkouts.map((f) => f.get("customer"))).toEqual(["cus_1", "cus_1"]);
  });

  it("doesn't open a second subscription for someone already paying", async () => {
    const session = await signIn();
    await checkout(session);
    pay();
    const res = await checkout(session);
    expect(res.body).toMatchObject({ alreadyPremium: true });
    expect(stripe.checkouts).toHaveLength(1);
  });

  it("says Stripe is unreachable rather than failing silently", async () => {
    const session = await signIn();
    stripe.down = true;
    expect(await checkout(session)).toEqual({ status: 503, body: { error: "stripe_unreachable" } });
  });
});

describe("renewing the Pass", () => {
  it("issues a signed 3-day Pass once the subscription is paid, even before any webhook", async () => {
    const session = await signIn("player@example.com", "device-a");
    await checkout(session);
    pay();

    const before = Date.now();
    const res = await renew(session);
    expect(res.status).toBe(200);
    expect(res.body.serverNow).toBeGreaterThanOrEqual(before);
    const pass = await readPass(res.body.pass);
    expect(pass).toMatchObject({ v: 1, email: "player@example.com", deviceId: "device-a" });
    expect(pass.exp - pass.iat).toBe(3 * DAY);
  });

  it("can't be forged: a Pass with its payload edited fails verification", async () => {
    const session = await signIn();
    await checkout(session);
    pay();
    const { pass } = (await renew(session)).body;
    const [, sig] = pass.split(".");
    const forged = btoa(JSON.stringify({ v: 1, email: "x@y.z", deviceId: "d", iat: 0, exp: 9e15 })).replace(/=+$/, "");
    await expect(readPass(`${forged}.${sig}`)).rejects.toThrow("bad signature");
  });

  it("answers not_paid for an account that never checked out, without asking Stripe", async () => {
    const session = await signIn();
    expect((await renew(session)).body).toMatchObject({ reason: "not_paid" });
    expect(stripe.calls).toEqual([]);
  });

  it("answers not_paid when Stripe confirms nothing is active", async () => {
    const session = await signIn();
    await checkout(session);
    pay(undefined, "past_due");
    expect((await renew(session)).body).toMatchObject({ reason: "not_paid" });
  });

  it("treats only active and trialing as Premium", async () => {
    const session = await signIn();
    await checkout(session);
    for (const status of ["past_due", "unpaid", "canceled", "incomplete", "incomplete_expired", "paused"]) {
      pay(undefined, status);
      expect((await renew(session)).body, status).toMatchObject({ reason: "not_paid" });
    }
    pay(undefined, "trialing");
    expect((await renew(session)).body.pass).toBeTypeOf("string");
  });

  it("never says not_paid when Stripe can't be reached", async () => {
    const session = await signIn();
    await checkout(session);
    pay();
    stripe.down = true;
    expect(await renew(session)).toEqual({ status: 503, body: { error: "stripe_unreachable" } });
  });

  it("serves a paid account from the webhook's record without asking Stripe", async () => {
    const session = await signIn();
    await checkout(session);
    expect((await webhook("customer.subscription.created", pay())).status).toBe(200);
    stripe.calls = [];
    stripe.down = true; // proves the answer didn't come from Stripe
    expect((await renew(session)).body.pass).toBeTypeOf("string");
    expect(stripe.calls).toEqual([]);
  });

  it("re-checks with Stripe when the webhook says the subscription ended", async () => {
    const session = await signIn();
    await checkout(session);
    await webhook("customer.subscription.created", pay());
    const ended = pay(undefined, "canceled");
    await webhook("customer.subscription.deleted", ended);
    expect((await renew(session)).body).toMatchObject({ reason: "not_paid" });
    expect(stripe.calls).toContain("GET /v1/subscriptions");
  });

  it("says signed_out for a session the server never issued", async () => {
    expect((await renew("not-a-real-session")).body).toMatchObject({ reason: "signed_out" });
  });

  it("says device_replaced once the account signs in on another computer", async () => {
    const first = await signIn("player@example.com", "device-a");
    await signIn("player@example.com", "device-b");
    expect((await renew(first)).body).toMatchObject({ reason: "device_replaced" });
    expect((await checkout(first)).body).toMatchObject({ reason: "device_replaced" });
  });

  it("puts the new device's id in its Pass", async () => {
    await signIn("player@example.com", "device-a");
    const second = await signIn("player@example.com", "device-b");
    await checkout(second);
    pay();
    expect(await readPass((await renew(second)).body.pass)).toMatchObject({ deviceId: "device-b" });
  });

  it("refuses a request without a session", async () => {
    expect(await renew("")).toEqual({ status: 400, body: { error: "bad_request" } });
  });
});

describe("the Stripe webhook", () => {
  it("is refused without a valid signature, and records nothing", async () => {
    const session = await signIn();
    await checkout(session);
    expect((await webhook("customer.subscription.created", pay(), undefined, "whsec_wrong")).status).toBe(400);
    const unsigned = await call("/stripe/webhook", JSON.stringify({ type: "customer.subscription.created" }));
    expect(unsigned.status).toBe(400);
    const rows = await env.DB.prepare("SELECT COUNT(*) AS n FROM subscriptions").first<{ n: number }>();
    expect(rows!.n).toBe(0);
  });

  it("is refused when its signature is more than 5 minutes old", async () => {
    const session = await signIn();
    await checkout(session);
    const sub = pay();
    vi.useFakeTimers({ toFake: ["Date"] });
    const signedAt = Date.now();
    vi.setSystemTime(signedAt - 6 * 60 * 1000);
    const body = JSON.stringify({ type: "customer.subscription.created", created: 0, data: { object: sub } });
    const t = Math.floor(Date.now() / 1000);
    const key = await crypto.subtle.importKey("raw", new TextEncoder().encode("whsec_test_fake"), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${t}.${body}`));
    const v1 = [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, "0")).join("");
    vi.setSystemTime(signedAt);
    expect((await call("/stripe/webhook", body, { "stripe-signature": `t=${t},v1=${v1}` })).status).toBe(400);
  });

  it("can't be rolled back by an older event arriving late", async () => {
    const session = await signIn();
    await checkout(session);
    const now = Math.floor(Date.now() / 1000);
    await webhook("customer.subscription.updated", pay(undefined, "active"), now);
    await webhook("customer.subscription.updated", pay(undefined, "incomplete"), now - 60);
    const row = await env.DB.prepare("SELECT status FROM subscriptions").first<{ status: string }>();
    expect(row!.status).toBe("active");
  });

  it("acknowledges events it doesn't act on, so Stripe stops retrying them", async () => {
    const res = await webhook("invoice.paid", { id: "in_1", customer: "cus_x", status: "paid", items: { data: [] } });
    expect(res).toEqual({ status: 200, body: { received: true } });
  });
});

describe("the pages Checkout returns to", () => {
  it("are plain pages telling the player to go back to the app", async () => {
    for (const [path, text] of [["/checkout/done", "subscribed"], ["/checkout/cancelled", "Nothing was charged"]]) {
      const res = await exports.default.fetch(new Request(`${ORIGIN}${path}`));
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("text/html");
      expect(await res.text()).toContain(text);
    }
  });

  it("only answer GET", async () => {
    const res = await exports.default.fetch(new Request(`${ORIGIN}/checkout/done`, { method: "POST" }));
    expect(res.status).toBe(405);
  });
});
