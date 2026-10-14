import { exports } from "cloudflare:workers";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Every email the worker hands to Resend, captured instead of sent.
let sent: { to: string; text: string }[] = [];

beforeEach(() => {
  sent = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url !== "https://api.resend.com/emails") throw new Error(`unexpected fetch: ${url}`);
    const body = JSON.parse(String(init?.body));
    sent.push({ to: [body.to].flat()[0], text: body.text });
    return Response.json({ id: "email_1" });
  });
});

async function post(path: string, body: unknown, ip = "203.0.113.7") {
  const res = await exports.default.fetch(
    new Request(`https://billing.test${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", "CF-Connecting-IP": ip },
      body: JSON.stringify(body),
    }),
  );
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

/** The 6-digit code in the newest email sent to `email`. */
function codeSentTo(email: string): string {
  const mail = sent.filter((m) => m.to === email).at(-1);
  const code = mail?.text.match(/\b\d{6}\b/)?.[0];
  if (!code) throw new Error(`no code was emailed to ${email}`);
  return code;
}

const EMAIL = "player@example.com";
const DEVICE = "device-a";

describe("sign-in round trip", () => {
  it("emails a 6-digit code that verifies into a session", async () => {
    const start = await post("/auth/start", { email: EMAIL });
    expect(start).toEqual({ status: 200, body: { ok: true } });

    const verify = await post("/auth/verify", {
      email: EMAIL,
      code: codeSentTo(EMAIL),
      deviceId: DEVICE,
    });
    expect(verify.status).toBe(200);
    expect(verify.body.email).toBe(EMAIL);
    expect(verify.body.session).toMatch(/^[\w-]{40,}$/);
  });
});
