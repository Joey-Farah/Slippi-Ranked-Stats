<script lang="ts">
  // Everything you've written, in one place — for browsing, cleaning up, and (the part the
  // live panel can't do) writing notes ahead of time about someone you aren't playing yet.
  import { games } from "../../lib/store";
  import { CHARACTERS } from "../../lib/parser";
  import {
    notes,
    groupNotes,
    searchNotes,
    matchupTitle,
    normalizeCode,
    ANY_CHAR,
    addOpponentNote,
    addMatchupNote,
    type NoteKind,
  } from "../../lib/notes";
  import NoteList from "../NoteList.svelte";
  import NoteComposer from "../NoteComposer.svelte";

  const CHAR_NAMES = [...new Set(Object.values(CHARACTERS))].sort((a, b) => a.localeCompare(b));

  // ── New note ─────────────────────────────────────────────────────────────
  let newKind = $state<NoteKind>("opponent");
  let newCode = $state("");
  let newPlayerChar = $state(ANY_CHAR);
  let newOpponentChar = $state("Fox");

  // Everyone you've actually played, most-played first, to back the connect-code datalist.
  // Codes you haven't played are still typable — the field is an input, not a select, so a
  // note can be written about someone from a bracket before you ever queue into them.
  let knownOpponents = $derived((() => {
    const counts = new Map<string, number>();
    for (const g of $games) {
      if (!g.opponent_code) continue;
      const code = normalizeCode(g.opponent_code);
      counts.set(code, (counts.get(code) ?? 0) + 1);
    }
    return [...counts.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([code, n]) => ({ code, games: n }));
  })());

  // The character you play most, so the matchup form opens on your actual matchup instead of
  // whatever sorts first alphabetically.
  let mainChar = $derived((() => {
    const counts = new Map<string, number>();
    for (const g of $games) {
      const name = CHARACTERS[g.player_char_id];
      if (name) counts.set(name, (counts.get(name) ?? 0) + 1);
    }
    return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? ANY_CHAR;
  })());

  let canAdd = $derived(newKind === "opponent" ? newCode.trim().length > 0 : !!newOpponentChar);

  async function addNote(body: string) {
    if (newKind === "opponent") {
      const code = newCode.trim();
      if (!code) return;
      await addOpponentNote(code, "", body);
    } else {
      await addMatchupNote(newPlayerChar, newOpponentChar, body);
    }
  }

  // ── Browse ───────────────────────────────────────────────────────────────
  let query = $state("");
  let kindFilter = $state<"all" | NoteKind>("all");

  let groups = $derived((() => {
    const filtered = searchNotes($notes, query).filter(
      (n) => kindFilter === "all" || n.kind === kindFilter
    );
    return groupNotes(filtered);
  })());

  let counts = $derived({
    all: $notes.length,
    opponent: $notes.filter((n) => n.kind === "opponent").length,
    matchup: $notes.filter((n) => n.kind === "matchup").length,
  });

  const KIND_FILTERS: { id: "all" | NoteKind; label: string }[] = [
    { id: "all", label: "All" },
    { id: "opponent", label: "Players" },
    { id: "matchup", label: "Matchups" },
  ];
</script>

<div class="card" style="margin-bottom: 16px">
  <div class="section-title" style="margin-bottom: 4px">Notes</div>
  <div class="muted" style="font-size: 12px; line-height: 1.5; margin-bottom: 12px">
    Quick reminders about people you play and matchups you struggle with. Anything here shows up
    on the <strong>Live Session</strong> tab the moment that opponent is detected — before the
    match starts. Notes are never shown on the stream overlay.
  </div>

  <!-- New note -->
  <div class="new">
    <div class="row">
      <div class="seg" role="group" aria-label="Note kind">
        <button
          type="button"
          class:on={newKind === "opponent"}
          onclick={() => (newKind = "opponent")}
        >A player</button>
        <button
          type="button"
          class:on={newKind === "matchup"}
          onclick={() => { newKind = "matchup"; if (newPlayerChar === ANY_CHAR) newPlayerChar = mainChar; }}
        >A matchup</button>
      </div>

      {#if newKind === "opponent"}
        <input
          class="field"
          bind:value={newCode}
          list="srs-known-opponents"
          placeholder="Connect code, e.g. FOX#123"
          spellcheck="false"
        />
        <datalist id="srs-known-opponents">
          {#each knownOpponents as o}
            <option value={o.code}>{o.games} game{o.games === 1 ? "" : "s"}</option>
          {/each}
        </datalist>
      {:else}
        <select class="field" bind:value={newPlayerChar} aria-label="Your character">
          <!-- "Any character" is for facts about the opposing character rather than about the
               pairing — useful if you play more than one. -->
          <option value={ANY_CHAR}>Any character (me)</option>
          {#each CHAR_NAMES as c}
            <option value={c}>{c}</option>
          {/each}
        </select>
        <span class="vs">vs</span>
        <select class="field" bind:value={newOpponentChar} aria-label="Their character">
          {#each CHAR_NAMES as c}
            <option value={c}>{c}</option>
          {/each}
        </select>
      {/if}
    </div>

    <NoteComposer
      placeholder={newKind === "opponent"
        ? `Add a note on ${newCode.trim() ? normalizeCode(newCode) : "this player"}…`
        : `Add a note on ${matchupTitle(newPlayerChar, newOpponentChar)}…`}
      disabled={!canAdd}
      onsubmit={addNote}
    />
  </div>
</div>

<!-- Browse -->
<div class="card">
  <div class="row" style="margin-bottom: 12px">
    <div class="seg" role="group" aria-label="Filter by kind">
      {#each KIND_FILTERS as f}
        <button type="button" class:on={kindFilter === f.id} onclick={() => (kindFilter = f.id)}>
          {f.label}
          <span class="pill">{counts[f.id]}</span>
        </button>
      {/each}
    </div>
    <input
      class="field"
      bind:value={query}
      placeholder="Search notes, players, characters…"
      spellcheck="false"
    />
  </div>

  {#if $notes.length === 0}
    <div class="blank">
      <div style="font-size: 22px; margin-bottom: 6px" aria-hidden="true">🗒️</div>
      <div style="font-size: 13px; font-weight: 600; margin-bottom: 4px">No notes yet</div>
      <div class="muted" style="font-size: 12px; line-height: 1.5">
        Write one above, or jot one straight from the Live Session tab while you're playing.
      </div>
    </div>
  {:else if groups.length === 0}
    <div class="blank muted" style="font-size: 12px">Nothing matches that filter.</div>
  {:else}
    <div class="groups">
      {#each groups as g (g.key)}
        <section class="group" class:matchup={g.kind === "matchup"}>
          <div class="group-head">
            <span class="group-title">{g.title}</span>
            {#if g.subtitle}<span class="group-sub">{g.subtitle}</span>{/if}
            <span class="pill">{g.notes.length}</span>
          </div>
          <NoteList notes={g.notes} />
        </section>
      {/each}
    </div>
  {/if}
</div>

<style>
  .new {
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 10px;
    background: rgba(255, 255, 255, 0.02);
  }

  .row {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
    margin-bottom: 8px;
  }

  .seg {
    display: flex;
    gap: 4px;
    flex-shrink: 0;
  }

  .seg button {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 6px 11px;
    border-radius: 6px;
    cursor: pointer;
    font-family: inherit;
    font-size: 12px;
    font-weight: 700;
    border: 1px solid var(--border);
    background: var(--bg);
    color: var(--muted);
  }

  .seg button.on {
    border-color: #2ecc7155;
    background: #2ecc7122;
    color: var(--accent);
  }

  .field {
    flex: 1;
    min-width: 150px;
    font-family: inherit;
    font-size: 12.5px;
    color: var(--text);
    background: var(--bg);
    border: 1px solid var(--border);
    border-radius: 6px;
    padding: 7px 9px;
  }

  .field:focus {
    outline: none;
    border-color: var(--accent);
  }

  .vs {
    font-size: 11px;
    color: var(--muted);
    flex-shrink: 0;
  }

  .pill {
    font-size: 10px;
    font-weight: 700;
    color: var(--muted);
    background: rgba(255, 255, 255, 0.06);
    border-radius: 999px;
    padding: 1px 6px;
  }

  .groups {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  .group {
    border: 1px solid var(--border);
    border-left: 3px solid #f39c12;
    border-radius: 8px;
    padding: 9px 10px;
    background: var(--bg);
  }

  /* Matchup notes read as a different category at a glance — same shape, different accent. */
  .group.matchup {
    border-left-color: var(--highlight);
  }

  .group-head {
    display: flex;
    align-items: baseline;
    gap: 8px;
    flex-wrap: wrap;
    margin-bottom: 5px;
  }

  .group-title {
    font-size: 13px;
    font-weight: 700;
  }

  .group-sub {
    font-size: 11px;
    color: var(--muted);
  }

  .blank {
    text-align: center;
    padding: 28px 16px;
  }
</style>
