// Sets up the PRODUCTION billing worker (slice 8 of docs/plans/direct-billing.md), printing no
// secret and writing none to disk:
//   1. applies the database migrations to the production D1 (srs-billing),
//   2. generates the production Pass key pair: the public half goes into wrangler.toml and
//      src/lib/pass-key.ts (commit those), the private half straight into the PASS_SIGNING_KEY
//      secret,
//   3. deploys the worker,
//   4. stores the Resend API key, read from the clipboard (copy it when asked).
// Then run scripts/setup-stripe.ps1 -Production for the Stripe key + webhook.
//
//   node workers/billing/scripts/setup-production.mjs
//
// Safe to re-run: an existing key pair is kept (pass --new-key to replace it, which signs every
// card subscriber out of Premium until their app renews... and the shipped app's public key
// then no longer matches, so only do that before release). --skip-resend skips step 4;
// --resend-only does just step 4.

import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const workerDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const appKeyFile = join(workerDir, "..", "..", "src", "lib", "pass-key.ts");
const tomlFile = join(workerDir, "wrangler.toml");
const args = new Set(process.argv.slice(2));

function wrangler(cmdArgs, input) {
  const r = spawnSync("npx", ["wrangler", ...cmdArgs], {
    cwd: workerDir,
    input,
    stdio: [input === undefined ? "inherit" : "pipe", "inherit", "inherit"],
    shell: process.platform === "win32",
  });
  if (r.status !== 0) {
    console.error(`\nwrangler ${cmdArgs[0]} ${cmdArgs[1] ?? ""} failed; stopping. Re-running is safe.`);
    process.exit(1);
  }
}

// The production [vars] block is the first PASS_PUBLIC_KEY line in wrangler.toml (staging's
// lives under [env.staging.vars], further down).
const PROD_VAR = /^PASS_PUBLIC_KEY = .*$/m;

if (!args.has("--resend-only")) {
console.log("1/4  Database migrations");
wrangler(["d1", "migrations", "apply", "srs-billing", "--remote"]);

let toml = readFileSync(tomlFile, "utf8");
const hasKey = !/^PASS_PUBLIC_KEY = ""$/m.test(toml);
let privateJwk = null;
if (hasKey && !args.has("--new-key")) {
  console.log("2/4  Pass key pair already set up; keeping it");
} else {
  console.log("2/4  Generating the production Pass key pair");
  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const { kty, crv, x, y } = await crypto.subtle.exportKey("jwk", pair.publicKey);
  const pub = { kty, crv, x, y };
  privateJwk = JSON.stringify(await crypto.subtle.exportKey("jwk", pair.privateKey));

  toml = toml.replace(PROD_VAR, `PASS_PUBLIC_KEY = '${JSON.stringify(pub)}'`);
  writeFileSync(tomlFile, toml);
  const app = readFileSync(appKeyFile, "utf8");
  const updated = app.replace(/const PRODUCTION: JsonWebKey = \{[^}]*\};/,
    `const PRODUCTION: JsonWebKey = ${JSON.stringify(pub, null, 2)};`);
  if (updated === app && !app.includes(pub.x)) {
    console.error("Couldn't find the PRODUCTION key in src/lib/pass-key.ts; nothing deployed.");
    process.exit(1);
  }
  writeFileSync(appKeyFile, updated);
  console.log("     Public half written to wrangler.toml and src/lib/pass-key.ts");
}

console.log("3/4  Deploying srs-billing");
wrangler(["deploy"]);
if (privateJwk) {
  wrangler(["secret", "put", "PASS_SIGNING_KEY"], privateJwk);
  console.log("     PASS_SIGNING_KEY stored (not shown)");
}
}

if (args.has("--skip-resend")) process.exit(0);
console.log("4/4  Resend API key: create one at resend.com -> API Keys (Sending access is enough),");
console.log("     then copy it. Waiting up to 10 minutes for a re_... key on the clipboard...");
const deadline = Date.now() + 10 * 60_000;
let key = null;
while (Date.now() < deadline) {
  const clip = execFileSync("powershell", ["-NoProfile", "-Command", "Get-Clipboard -Raw"], { encoding: "utf8" }).trim();
  if (clip.startsWith("re_")) { key = clip; break; }
  await new Promise((r) => setTimeout(r, 700));
}
if (!key) {
  console.error("No re_... key showed up. Copy one, then re-run with --resend-only.");
  process.exit(1);
}
wrangler(["secret", "put", "RESEND_API_KEY"], key);
console.log("     RESEND_API_KEY stored (not shown). Now run setup-stripe.ps1 -Production.");
