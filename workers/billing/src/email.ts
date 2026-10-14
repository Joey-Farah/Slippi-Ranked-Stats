// Sending the sign-in code. Resend in production; the worker log on staging until Resend is
// set up (see ALLOW_LOGGED_CODES in wrangler.toml).

export async function sendSignInCode(env: Env, to: string, code: string): Promise<void> {
  const text =
    `Your Slippi Ranked Stats sign-in code is ${code}\n\n` +
    `It expires in 10 minutes. If you didn't ask for it, you can ignore this email.`;

  if (!env.RESEND_API_KEY) {
    if (env.ALLOW_LOGGED_CODES !== "1") throw new Error("RESEND_API_KEY is not set");
    console.log(`[staging] sign-in code for ${to}: ${code}`);
    return;
  }

  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      authorization: `Bearer ${env.RESEND_API_KEY}`,
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
