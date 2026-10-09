---
status: grill done 2026-10-09; build plan awaiting approval, NOT implemented
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
| 8 | **Stripe Managed Payments** (Stripe is merchant of record). | Plain Stripe would make Joey the seller, owing EU/UK VAT from the first sale there. Managed Payments collects and files it in 80+ countries for ~3.5% extra (~14¢ on $5). Paddle is the fallback if Stripe's eligibility review says no. |
| 9 | **Sign in first, then pay.** The app sends a code, then "Subscribe" opens Stripe Checkout with that email prefilled and locked; Premium switches on in the app within seconds of paying. | The code proves the email before any money moves, so nobody pays for a subscription the app can't find. |
| 10 | **The Discord/Patreon/Ko-fi route is out of scope** — untouched, no device limit. The app is Premium if EITHER the existing Discord check OR a valid Pass says so; the two never interact. | Joey: keep it separate. Sharing on that route means handing over a Discord password, so a limit would stop little and would change things for existing patrons. |

## Premises (attack these)

- **The app can never talk to Stripe directly.** Checking payment needs the Stripe secret key,
  and anything in the app can be pulled out (the source is public on GitHub). A server holds the
  key, sends sign-in codes and answers "is this Device Premium?".
- **That server is a Cloudflare Worker, not Vercel.** Vercel's free Hobby plan doesn't allow
  commercial use, which is why The Lombardi Project removed its Stripe checkout in Sept 2026.
  `srs-discord-check`, telemetry and feedback already run on Workers.
- ~~Both routes end in the same Pass.~~ Dropped 2026-10-09 by decision 10. The Discord
  route's every-launch re-check bug stays its own ticket (`dev_notes.md`, 2026-10-09 banner).
- **The Pass is stored by the app's Rust side, in a file, not in webview localStorage.** That
  storage is the prime suspect in the open persistence report.
- Email sending via **Resend** (free tier), the provider The Lombardi Project's docs had planned.

## Managed Payments facts (from `stripe docs`, 2026-10-09)

- **Eligible:** US-based businesses; software is a supported category. Access is gated on a
  Stripe eligibility review. The product needs an eligible digital-goods tax code.
- **Works with Checkout Sessions and Payment Links**, and subscriptions via Billing. Not with
  Elements, so checkout is always a Stripe-hosted page in the browser.
- **Customers see "Sold through Link"** at checkout and `LINK.COM* <descriptor>` on their statement.
- **Stripe sends receipts, invoices and subscription emails**, and customers cancel or update
  their card on link.com. We build no billing-management UI and send only sign-in codes.
- Stripe handles disputes and transaction support; if it asks for input and gets none in 48h it
  may refund on its own. ⚠ Keep the support email in the Stripe dashboard current.
- The fee isn't on the docs pages; the ~3.5% surcharge comes from third-party comparisons.
  Confirm it on the dashboard.

## Still open

- Lifetime price (non-blocking).
