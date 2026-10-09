---
status: build plan APPROVED 2026-10-09; building on branch feat/card-billing
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

---

# Build plan (approved 2026-10-09)

## Load-bearing premises (attack these at the gate)

1. **The app never talks to Stripe.** A new Cloudflare Worker, `srs-billing`, holds the Stripe secret,
   sends the sign-in codes and signs Passes. It runs on Workers, not Vercel, because Vercel Hobby
   forbids commercial use.
2. **"Definite answer" means an explicit reason code in a 200 response:** `not_paid`,
   `device_replaced` or `signed_out`. It is **never inferred from an HTTP status.** Any 4xx/5xx,
   timeout, network error or unparseable body counts as "couldn't reach the server", and grace
   applies. (The Discord code treats every 4xx as definitive, which is how a 429 can clear a
   refresh token. This plan must not repeat that.)
3. **`not_paid` is always confirmed live with Stripe.** If D1 (fed by webhooks) says not active, the
   worker asks Stripe directly before answering. If Stripe can't be reached, the worker answers
   "couldn't reach", never `not_paid`. A missed webhook can't lock anyone out.
4. **Premium = Stripe subscription status `active`** (or `trialing`). `past_due`, `unpaid`,
   `canceled` and `incomplete` are not Premium (decision 6).
5. **The Pass is signed with ECDSA P-256 and verified in the app with WebCrypto.** Every WebView2
   and WKWebView supports this, so no Rust crypto crate is needed. Editing the stored Pass
   therefore can't grant Premium.
6. **The session and Pass are stored in a new SQLite `account.db`**, following the `getNotesDb()`
   pattern in `src/lib/db.ts`, not in localStorage. SQLite writes are atomic, and the file sits
   next to data users would notice losing.
7. **Clock safety:** each renewal returns the server time, and the app evaluates expiry using that
   offset, so a wrong PC clock can't expire a valid Pass early.
8. **Grace counts from Pass expiry:** if the Pass expired less than 7 days ago and the last renewal
   only failed to reach the server, Premium stays.

## Architecture

### Worker `workers/billing/` (new; TypeScript, own `package.json`)

| Endpoint | Does |
|---|---|
| `POST /auth/start {email}` | Emails a 6-digit code via Resend. Always returns 200, so it doesn't reveal whether an account exists. Code is hashed, has a 10-min TTL, max 5 attempts; requests are rate-limited per email and per IP. |
| `POST /auth/verify {email, code, deviceId}` | Creates the account if new. Issues a device session (random, stored hashed) and **replaces** the account's previous device. Returns `{session}` plus a renew result. |
| `POST /pass/renew {session}` | `{pass, serverNow}` · `{reason: not_paid \| device_replaced \| signed_out, serverNow}` |
| `POST /checkout {session}` | Creates a Checkout Session: `mode: subscription`, `managed_payments: {enabled: true}`, `customer` set to the account's Stripe customer (locks the email), `success_url` set to the worker's own `/checkout/done` page. Returns `{url}`. |
| `POST /portal {session}` | Stripe Customer Portal URL (cancel / update card). |
| `POST /stripe/webhook` | Verifies the signature (`constructEventAsync` + SubtleCrypto) and upserts the subscription status and period end on `customer.subscription.*`. |
| cron (hourly) | An in-process test renewal for a canary account plus a Stripe reachability check. Posts to a Discord webhook on the first failure and on recovery. |

D1 `srs-billing`: `accounts(id, email UNIQUE, stripe_customer_id)`, `login_codes`,
`devices(account_id UNIQUE, device_id, session_hash)`,
`subscriptions(account_id, stripe_subscription_id, status, current_period_end)`.

### App module `src/lib/card-premium.ts` (deep: small surface, logic hidden)

Three shapes were considered: minimal store + actions; injectable Renewer/PassStore/Clock classes
with a config object; and a Firebase-style `onAuthStateChanged`. **Picked the minimal one**:

```ts
export const cardAccount: Readable<
  | { kind: "signed_out" }
  | { kind: "code_sent"; email: string }
  | { kind: "signed_in"; email: string; reason?: "not_paid" }
  | { kind: "premium"; email: string }
  | { kind: "replaced" }>;          // "signed in on another computer"
export function initCardPremium(): Promise<void>;   // load, verify, schedule renewals
export function startSignIn(email: string): Promise<void>;
export function confirmCode(code: string): Promise<void>;
export function subscribe(): Promise<void>;          // opens Checkout, polls renew until paid
export function manageSubscription(): Promise<void>;
export function signOut(): Promise<void>;
```

Hidden inside: a **pure** `decide(stored, event, now) → stored` reducer (all the grace, expiry,
definite-vs-unreachable and clock-offset rules, which is where the failure tests go); Pass
verification; `account.db` I/O; the renewal timer (at launch, every 6 h, and every 3 s for up to
10 min after opening Checkout).

**Combining with Discord (`src/lib/store.ts`):** the persisted `isPremium` writable becomes
`discordPremium` and **keeps its `srs_isPremium` key**, so there's no migration. Add a `cardPremium`
writable and `isPremium = derived(… d || c)`. Every `$isPremium` reader is unchanged. Only
`discord.ts` and `App.svelte:141` write it today; they switch to `discordPremium`.

**Capability:** no change. The existing `https://*.workers.dev/**` fetch scope already covers
`srs-discord-check.joeyfarah.workers.dev`, so it covers `srs-billing` too.

## Slices (each is RED → GREEN, demoable, and its own small commits)

1. **Sign-in round trip** (touches every layer but Stripe): app email → worker → Resend → code → app
   shows "Signed in as x", and it survives a restart. Worker tests (Miniflare): code expiry,
   attempt cap, rate limit, always-200. App: reducer tests plus a dev-build demo against a
   **staging** worker.
2. **Subscribe → Premium:** "Subscribe" opens test-mode Checkout; pay with 4242 → webhook → renew
   returns a signed Pass → the app verifies it → `isPremium` → Premium tabs unlock. Includes the
   `discordPremium || cardPremium` merge, tested so a Discord patron is unaffected.
3. **Not paying ends Premium:** a Stripe **test clock** advances to renewal with a declining card →
   `not_paid` (confirmed live) → Premium off. Fix the card → Premium returns by itself. Also covers
   cancel via the portal.
4. **One device, newest wins:** sign in on a second install → the first gets `device_replaced` → "Signed
   in on another computer".
5. **Never lock out on our failures:** a reducer test matrix with a fake clock covering 5xx, 4xx,
   429, timeout, garbage body, clock skew, expiry inside and past 7 days of grace, and a corrupt Pass.
   Then an E2E run with the worker stopped mid-session.
6. **Hourly self-test + Discord alert** (cron), verified by deliberately breaking the canary on staging.
7. **UI polish:** Sidebar/PremiumGate branches for the card route, manage-subscription and sign-out
   links, short plain copy.
8. **Go live:** live keys, production worker, a version bump, and short plain release notes.

## What Joey has to do (I never handle secrets; he runs `! wrangler secret put …`)

- Stripe dashboard: **activate Managed Payments and accept its terms** (gated on Stripe's review), and
  create the $5/month product with an eligible software tax code. Test mode is enough to start.
- Resend account, and verify a sending subdomain of slippirankedstats.com. DNS lives in Cloudflare;
  ⚠ don't touch the grey-cloud `@`/`www` records.
- Create the D1 database and worker (I give the exact commands), set secrets (`STRIPE_SECRET_KEY`,
  `STRIPE_WEBHOOK_SECRET`, `RESEND_API_KEY`, `PASS_SIGNING_KEY`, `ALERT_DISCORD_WEBHOOK`), and add a
  private Discord channel webhook for alerts.

## New dependencies

Worker only: `stripe`, `wrangler`, `vitest`, `@cloudflare/vitest-pool-workers`. **App: none.**

## Verification

- `npm test` (app reducer + Pass verification) and `workers/billing` tests (Miniflare + D1) green;
  `tsc` + `vite build` clean.
- E2E in `npm run tauri dev` against the staging worker in Stripe test mode, for each slice's demo:
  sign in → restart → still signed in; pay 4242 → Premium; test-clock decline → Premium off; second
  device → first replaced; stop worker → Premium stays; expire past grace → off.
- Before release: the Discord route regression check (a patron install keeps Premium with no card
  account).
