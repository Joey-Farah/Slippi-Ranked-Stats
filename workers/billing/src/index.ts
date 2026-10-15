// srs-billing: the server half of buying Premium with a card. See docs/plans/direct-billing.md.
//
// Every API response is JSON. Failures carry an explicit `error` code in the body; the app reads
// that code, never the HTTP status, to decide what happened. The two GET routes are the pages
// Stripe Checkout sends the browser back to.

import { signOut, startSignIn, verifySignIn } from "./auth";
import { checkoutCancelled, checkoutDone, openPortal, portalDone, renewPass, startCheckout, stripeWebhook } from "./billing";
import { json } from "./http";

type Handler = (request: Request, env: Env) => Promise<Response>;

const ROUTES: Record<string, { method: "GET" | "POST"; handler: Handler }> = {
  "/auth/start": { method: "POST", handler: startSignIn },
  "/auth/verify": { method: "POST", handler: verifySignIn },
  "/auth/signout": { method: "POST", handler: signOut },
  "/pass/renew": { method: "POST", handler: renewPass },
  "/checkout": { method: "POST", handler: startCheckout },
  "/portal": { method: "POST", handler: openPortal },
  "/stripe/webhook": { method: "POST", handler: stripeWebhook },
  "/checkout/done": { method: "GET", handler: checkoutDone },
  "/checkout/cancelled": { method: "GET", handler: checkoutCancelled },
  "/portal/done": { method: "GET", handler: portalDone },
};

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const route = ROUTES[new URL(request.url).pathname];
    if (!route) return json({ error: "not_found" }, 404);
    if (request.method !== route.method) return json({ error: "method_not_allowed" }, 405);
    return route.handler(request, env);
  },
} satisfies ExportedHandler<Env>;
