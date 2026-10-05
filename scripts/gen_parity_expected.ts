/**
 * Writes scripts/parity_fixtures/expected.json — the app parser's (slp_parser.ts) per-port
 * benchmarked stats for every fixture replay. scripts/test_parity.py holds the benchmark script
 * to these numbers; src/lib/parity.test.ts fails if this file goes stale against the parser.
 *
 * Run after any intended change to slp_parser.ts stat logic:
 *   node scripts/gen_parity_expected.ts
 *
 * Fixtures are public replays from huggingface erickfm/slippi-public-dataset-v3.7, each picked
 * because it exercised a real parser disagreement (see the fixture filenames).
 */
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { computeParityStats } from "../src/lib/slp_parser.ts";

const dir = join(import.meta.dirname, "parity_fixtures");
const out: Record<string, Record<string, Record<string, number | null>>> = {};
for (const f of readdirSync(dir).filter((f) => f.endsWith(".slp")).sort()) {
  out[f] = {};
  for (const { port, stats } of computeParityStats(new Uint8Array(readFileSync(join(dir, f))))) {
    out[f][String(port)] = stats;
  }
}
writeFileSync(join(dir, "expected.json"), JSON.stringify(out, null, 2) + "\n");
console.log(`wrote ${Object.keys(out).length} fixtures`);
