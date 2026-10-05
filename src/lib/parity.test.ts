import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { computeParityStats } from "./slp_parser";

// scripts/parity_fixtures/expected.json is the contract the benchmark script
// (scripts/test_parity.py) is held to. If the parser's stat logic changes on purpose,
// regenerate it with `node scripts/gen_parity_expected.ts` — this test only guards against
// the file silently drifting from the parser it claims to describe.
const DIR = join(__dirname, "../../scripts/parity_fixtures");
const expected = JSON.parse(readFileSync(join(DIR, "expected.json"), "utf8"));

describe("parity fixtures", () => {
  for (const f of readdirSync(DIR).filter((f) => f.endsWith(".slp")).sort()) {
    it(`expected.json matches the app parser for ${f}`, () => {
      const actual = Object.fromEntries(
        computeParityStats(new Uint8Array(readFileSync(join(DIR, f)))).map(({ port, stats }) => [String(port), stats]),
      );
      expect(actual).toEqual(expected[f]);
    });
  }
});
