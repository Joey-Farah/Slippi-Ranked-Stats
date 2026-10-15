// The public half of the key the srs-billing worker signs Passes with (its PASS_SIGNING_KEY
// secret). Public by design: it can only CHECK a Pass, never make one.
//
// Two pairs, one per worker: dev builds talk to staging (card-premium.ts BILLING_URL), release
// builds to production, so a Pass from one can never unlock the other.

const STAGING: JsonWebKey = {
  "kty": "EC",
  "crv": "P-256",
  "x": "pjzjKrq4ktCkUMkHShyFeR0cQ9p5n77IG394PvdvyiI",
  "y": "sYxRNqzzf-RrdLutIePFX8ar1WltAygG4ioprVpdkek"
};

// Written by workers/billing/scripts/setup-production.mjs, which also stores the private half.
const PRODUCTION: JsonWebKey = {
  "kty": "EC",
  "crv": "P-256",
  "x": "bC_LMcXLECoVeF42XlD96MZcxZoC2ih89pNInMgz_p4",
  "y": "EbDMKOs41QPzufNzalnN-u4Zfh6HWM4hP_Yhs5PUVVg"
};

export const PASS_PUBLIC_KEY: JsonWebKey = import.meta.env.DEV ? STAGING : PRODUCTION;
