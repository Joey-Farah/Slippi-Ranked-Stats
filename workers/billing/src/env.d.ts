declare namespace Cloudflare {
  interface GlobalProps {
    mainModule: typeof import("./index");
  }
  interface Env {
    DB: D1Database;
    /** "Name <address>" the sign-in code is sent from. */
    EMAIL_FROM: string;
    /** Secret. Absent on staging until Resend is set up. */
    RESEND_API_KEY?: string;
    /** "1" on staging only: with no RESEND_API_KEY, log codes instead of failing. */
    ALLOW_LOGGED_CODES?: string;
    /** The $5/month Price Checkout sells. Not a secret. */
    STRIPE_PRICE_ID: string;
    /** Secret. A test-mode key on staging. */
    STRIPE_SECRET_KEY: string;
    /** Secret. The webhook endpoint's signing secret (whsec_…). */
    STRIPE_WEBHOOK_SECRET: string;
    /** Secret. The ECDSA P-256 private key Passes are signed with, as a JWK string. */
    PASS_SIGNING_KEY: string;
    /** The public half the APP ships (src/lib/pass-key.ts), as a JWK string. Not a secret; the
     *  self-test checks fresh Passes verify against it. */
    PASS_PUBLIC_KEY?: string;
    /** Where the self-test's alerts go. */
    ALERT_EMAIL?: string;
    /** Names this deployment in alerts, e.g. "staging". */
    ENVIRONMENT_NAME?: string;
  }
}

interface Env extends Cloudflare.Env {}
