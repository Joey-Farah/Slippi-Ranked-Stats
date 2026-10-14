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
  }
}

interface Env extends Cloudflare.Env {}
