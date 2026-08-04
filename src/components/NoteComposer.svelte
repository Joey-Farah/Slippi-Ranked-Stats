<script lang="ts">
  // The "write one down" box. Enter submits, because the moment you actually use this is
  // between games with a queue timer running.
  let {
    placeholder = "Add a note…",
    disabled = false,
    // Opens at a few lines rather than one: a single-line box reads as a search field and makes
    // a two-sentence note feel like it doesn't belong. Still resizable past this.
    rows = 3,
    onsubmit,
  }: {
    placeholder?: string;
    disabled?: boolean;
    rows?: number;
    onsubmit: (body: string) => void | Promise<void>;
  } = $props();

  let value = $state("");
  let busy = $state(false);

  async function submit() {
    const body = value.trim();
    if (!body || busy || disabled) return;
    busy = true;
    // Cleared up front so the next note can be typed while the write lands. It's a local
    // SQLite insert — if it somehow failed, a refresh puts the truth back on screen.
    value = "";
    try {
      await onsubmit(body);
    } finally {
      busy = false;
    }
  }

  function onKey(e: KeyboardEvent) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  }
</script>

<div class="composer">
  <textarea
    bind:value
    onkeydown={onKey}
    {placeholder}
    {disabled}
    {rows}
  ></textarea>
  <button
    type="button"
    onclick={submit}
    disabled={disabled || busy || value.trim().length === 0}
  >Add</button>
</div>

<style>
  /* Button sits beside the box, pinned to its bottom edge. Stretching it to the full height of
     a multi-line textarea turns "Add" into a huge slab. */
  .composer {
    display: flex;
    gap: 8px;
    align-items: flex-end;
  }

  textarea {
    flex: 1;
    min-width: 0;
    resize: vertical;
    font-family: inherit;
    font-size: 12.5px;
    line-height: 1.5;
    color: var(--text);
    background: var(--bg);
    border: 1px solid var(--border);
    border-radius: 6px;
    padding: 6px 9px;
  }

  textarea:focus {
    outline: none;
    border-color: var(--accent);
  }

  textarea::placeholder {
    color: var(--muted);
  }

  button {
    flex-shrink: 0;
    width: 84px;
    padding: 9px 0;
    border-radius: 6px;
    cursor: pointer;
    font-family: inherit;
    font-size: 12px;
    font-weight: 700;
    border: 1px solid var(--border);
    background: var(--bg);
    color: var(--text);
  }

  button:disabled {
    opacity: 0.4;
    cursor: default;
  }

  button:not(:disabled):hover {
    border-color: #2ecc7155;
    background: #2ecc7122;
    color: var(--accent);
  }
</style>
