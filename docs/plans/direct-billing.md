---
status: grilling in progress, NOT implemented (started 2026-10-09)
date: 2026-10-09
---

# Direct billing: buying Premium in the app with a card

A second way to get **Premium**, for people who don't want to go through Patreon/Ko-fi and
the Discord server. Terms (**Premium**, **Subscription**, **Device**, **Pass**) are defined in
`CONTEXT.md`. Per `CLAUDE.md`, nothing touching premium gating gets built before this plan is
approved.

## Decided (Joey, 2026-10-09)

| # | Decision | Why |
|---|---|---|
| 1 | **$5/month subscription**, matching the cheapest Patreon tier. | Same recurring income as today. |
| 1b | A **lifetime** option may come later, tentatively **$100** (20 months). It's not blocking: lifetime is the same unlock with no end date, so it changes no architecture. | |
| 2 | **Sign in with an emailed 6-digit code.** The email is the account. | Stripe Checkout already collects it, and it works the same on a new PC or after a reinstall. |
| 3 | **One Device per account; the newest sign-in wins.** Signing in elsewhere moves Premium there instead of blocking. | 99% of players use one machine. Sharing a code is far less effort than building from source, so it's worth stopping. |
| 4 | **The Pass lasts 3 days and renews automatically** at launch and every few hours while the app is open. | A month-long pass would let one sign-in on a friend's PC give both machines Premium for a month. |
| 5 | **Only a definite server answer removes Premium:** "signed in on another device" or "not paid". Timeouts, server errors and outages never do. | Joey: nobody gets locked out because we shipped a bug. |
| 5b | **7 days of grace** past Pass expiry while the server can't be reached, plus an **hourly automated test renewal that alerts Joey on Discord**. | Without grace, lockouts start within hours of an outage: anyone who hasn't opened the app in 3+ days already has an expired Pass. 7 days covers once-a-week players. |
| 6 | **A declined renewal ends Premium.** If Stripe's automatic retry later charges the card, Premium returns at the next renewal on its own. | Joey: no payment, no access. |
| 7 | **The Discord/Patreon route stays permanently**, next to the card option. | It pulls people into the community. The card route is for people who'd rather skip all that. |

## Premises (attack these)

- **The app can never talk to Stripe directly.** Checking payment needs the Stripe secret key,
  and anything in the app can be pulled out (the source is public on GitHub). A server holds the
  key, sends sign-in codes and answers "is this Device Premium?".
- **That server is a Cloudflare Worker, not Vercel.** Vercel's free Hobby plan doesn't allow
  commercial use, which is why The Lombardi Project removed its Stripe checkout in Sept 2026.
  `srs-discord-check`, telemetry and feedback already run on Workers.
- **Both routes end in the same Pass.** The server decides Premium from either Stripe or the
  Discord role; the app only ever handles a Pass. For Discord users, the server checks the role
  with the bot token by user id, so the app stops refreshing Discord OAuth tokens. That
  refresh is the code behind the open "re-check every launch" report (see `dev_notes.md`,
  2026-10-09 banner).
- **The Pass is stored by the app's Rust side, in a file, not in webview localStorage.** That
  storage is the prime suspect in the open persistence report.
- Email sending via **Resend** (free tier), the provider The Lombardi Project's docs had planned.

## Still open

- Payment provider / tax handling (who is merchant of record).
- Does the 1-Device limit apply to Discord-route users too?
- Purchase flow order: sign in then pay, or pay then sign in?
- Lifetime price (non-blocking).
