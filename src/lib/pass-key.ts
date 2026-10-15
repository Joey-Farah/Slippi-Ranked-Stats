// The public half of the key the srs-billing worker signs Passes with (its PASS_SIGNING_KEY
// secret). Public by design: it can only CHECK a Pass, never make one.
//
// ⚠ This is the STAGING key, matching the staging worker the dev build talks to. Slice 8 (go
// live) generates a separate production pair and swaps this for the production public key.
export const PASS_PUBLIC_KEY: JsonWebKey = {
  "kty": "EC",
  "crv": "P-256",
  "x": "pjzjKrq4ktCkUMkHShyFeR0cQ9p5n77IG394PvdvyiI",
  "y": "sYxRNqzzf-RrdLutIePFX8ar1WltAygG4ioprVpdkek"
};
