// Sending the sign-in code. Resend in production; the worker log on staging until Resend is
// set up (see ALLOW_LOGGED_CODES in wrangler.toml).

import { secret } from "./http";

export async function sendSignInCode(env: Env, to: string, code: string): Promise<void> {
  const text =
    `Your Slippi Ranked Stats sign-in code is ${code}\n\n` +
    `It expires in 10 minutes. If you didn't ask for it, you can ignore this email.`;

  const apiKey = secret(env.RESEND_API_KEY);
  if (!apiKey) {
    if (env.ALLOW_LOGGED_CODES !== "1") throw new Error("RESEND_API_KEY is not set");
    console.log(`[staging] sign-in code for ${to}: ${code}`);
    return;
  }

  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      authorization: `Bearer ${apiKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      from: env.EMAIL_FROM,
      to,
      subject: "Your Slippi Ranked Stats sign-in code",
      text,
    }),
  });
  if (!res.ok) throw new Error(`Resend answered ${res.status}`);
}

/**
 * An alert to the owner (the hourly self-test). Never throws: a failed alert is logged, and the
 * next state change tries again. With no Resend key (staging before it's set up) it's only logged.
 */
export async function sendAlert(env: Env, subject: string, text: string): Promise<void> {
  const apiKey = secret(env.RESEND_API_KEY);
  if (!apiKey || !env.ALERT_EMAIL) {
    console.log(`[alert, not emailed] ${subject}\n${text}`);
    return;
  }
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({ from: env.EMAIL_FROM, to: env.ALERT_EMAIL, subject, text }),
    });
    if (!res.ok) console.error(`alert email failed: Resend answered ${res.status}`);
  } catch (err) {
    console.error("alert email failed:", err);
  }
}
