// srs-billing: the server half of buying Premium with a card. See docs/plans/direct-billing.md.
//
// Every response is JSON. Failures carry an explicit `error` code in the body; the app reads
// that code, never the HTTP status, to decide what happened.

import { startSignIn, verifySignIn } from "./auth";
import { json } from "./http";

const ROUTES: Record<string, (request: Request, env: Env) => Promise<Response>> = {
  "/auth/start": startSignIn,
  "/auth/verify": verifySignIn,
};

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const route = ROUTES[new URL(request.url).pathname];
    if (!route) return json({ error: "not_found" }, 404);
    if (request.method !== "POST") return json({ error: "method_not_allowed" }, 405);
    return route(request, env);
  },
} satisfies ExportedHandler<Env>;
