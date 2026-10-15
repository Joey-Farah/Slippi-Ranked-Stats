import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig(async () => {
  const migrations = await readD1Migrations("./migrations");
  // A throwaway Pass key pair per run: the worker signs with the private half, the tests verify
  // with the public half exactly as the app does.
  const pair = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  const privateJwk = await crypto.subtle.exportKey("jwk", pair.privateKey);
  const publicJwk = await crypto.subtle.exportKey("jwk", pair.publicKey);
  return {
    plugins: [
      cloudflareTest({
        wrangler: { configPath: "./wrangler.toml" },
        miniflare: {
          bindings: {
            TEST_MIGRATIONS: migrations,
            RESEND_API_KEY: "test-resend-key",
            STRIPE_SECRET_KEY: "sk_test_fake",
            STRIPE_WEBHOOK_SECRET: "whsec_test_fake",
            STRIPE_PRICE_ID: "price_test_5usd",
            PASS_SIGNING_KEY: JSON.stringify(privateJwk),
            TEST_PASS_PUBLIC_KEY: JSON.stringify(publicJwk),
            PASS_PUBLIC_KEY: JSON.stringify(publicJwk),
            ALERT_EMAIL: "owner@example.com",
            ENVIRONMENT_NAME: "test",
          },
        },
      }),
    ],
    test: { setupFiles: ["./test/setup.ts"] },
  };
});
