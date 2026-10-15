// The Pass: proof, signed by this worker, that a Device is Premium until `exp`.
//
// Format: base64url(JSON payload) "." base64url(ECDSA P-256 / SHA-256 signature, raw r‖s).
// The app holds only the public key and checks the signature with WebCrypto, so editing a
// stored Pass can't grant Premium. The private key is the PASS_SIGNING_KEY secret, a JWK.

import { secret } from "./http";

export const PASS_TTL_MS = 3 * 24 * 60 * 60 * 1000;

export interface PassPayload {
  /** Always 1 for now; lets a later format be told apart. */
  v: 1;
  email: string;
  deviceId: string;
  /** Issued and expires, Unix milliseconds by the server's clock. */
  iat: number;
  exp: number;
}

let cachedKey: { jwk: string; key: CryptoKey } | null = null;

async function signingKey(env: Env): Promise<CryptoKey> {
  const jwk = secret(env.PASS_SIGNING_KEY);
  if (cachedKey?.jwk === jwk) return cachedKey.key;
  const key = await crypto.subtle.importKey(
    "jwk",
    JSON.parse(jwk),
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"],
  );
  cachedKey = { jwk, key };
  return key;
}

export async function signPass(env: Env, payload: PassPayload): Promise<string> {
  const body = base64url(new TextEncoder().encode(JSON.stringify(payload)));
  const sig = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    await signingKey(env),
    new TextEncoder().encode(body),
  );
  return `${body}.${base64url(new Uint8Array(sig))}`;
}

function base64url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
