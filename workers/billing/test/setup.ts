import { applyD1Migrations, reset } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, vi } from "vitest";

declare global {
  namespace Cloudflare {
    interface Env {
      TEST_MIGRATIONS: import("cloudflare:test").D1Migration[];
      /** The public half of PASS_SIGNING_KEY, as a JWK string. */
      TEST_PASS_PUBLIC_KEY: string;
    }
  }
}

beforeEach(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

afterEach(async () => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  await reset();
});
