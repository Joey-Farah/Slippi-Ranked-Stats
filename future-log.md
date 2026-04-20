# Future Feature Log

Ideas noted for later. Move entries into a **Shipped** section when they land, with a link to the relevant doc or commit.

---

## Ideas

### Multi-connect-code profiles
**Noted:** 2026-04-19 · Source: user feedback

Use case: a user happens to have multiple connect codes (all theirs — alts, old code, code changes) and wants their stats viewed as one combined picture rather than switching between DBs.

Current DB is per-code (`data/{CODE}.db`); needs either a "profile" abstraction that aggregates across codes, or runtime union on queries.

**Shape so far:**
- Stats/matchups/sessions/grades all union across the profile's codes
- Rating (current + history chart) is per-code — user picks which code to view via a dropdown/selector; defaults to a "primary" code on the profile
- Live Session watches one code at a time (same selector)
- Default profile = single code (back-compat); adding a second code is opt-in

**Still open:** session detection across codes (same session or separate?), how "primary" is set, whether profiles are stored in a new DB or just as metadata keyed to existing per-code DBs.

---

### Richer session history
**Noted:** 2026-04-19 · Source: user feedback

The Session History table in `AllTimeStats.svelte` currently shows `# | Date | Duration | Sets | W | L | Win %`. Meanwhile the Last Session / Recent Session tab has way more per-session stats (momentum chart, stage win %, character breakdown, session-level stats, etc.).

Give past sessions the same treatment — surface the rich data historically, not just for the latest session.

**Requirement:** whatever shape we pick, clicking into a past session should render the **exact same view** the Recent Session tab shows — full parity, not a cut-down version.

**Implementation approach:** factor the Recent Session view into a reusable component that takes a `Session` as a prop. Recent Session tab becomes `<SessionView session={latest} />`; historical drill-in becomes `<SessionView session={picked} />`. Picker lives in the Session History table (click a row).

Data is already there — all sessions are grouped in the `sessions` store; each one has the full set list, so anything Recent Session computes from one session can be computed for any session.

**Still open:** expand-in-place vs. dedicated detail route (parity requirement is satisfied either way; picking between them is a UX call).

---

## Shipped

### Post-Set Letter Grade
**Noted:** 2026-04-14 · **Shipped:** 2026-04-17

Became the full Set Grading System — 18 stats, 15 scored across 3 categories (Neutral, Punish, Defense) plus 3 execution stats shown as info-only, graded against community baselines from 177,538 HuggingFace replays. Visible in the Grading tab (free/premium split) and as a post-set card in the Live Session tab (premium-only).

See [`docs/grading_methodology.md`](docs/grading_methodology.md) for how grading works and [`docs/dev_notes.md`](docs/dev_notes.md) for implementation state.
