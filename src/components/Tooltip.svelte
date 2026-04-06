<script lang="ts">
  let { text }: { text: string } = $props();
  let visible = $state(false);
</script>

<span
  class="wrap"
  onmouseenter={() => visible = true}
  onmouseleave={() => visible = false}
>
  <span class="icon">i</span>
  {#if visible}
    <div class="box">{text}</div>
  {/if}
</span>

<style>
.wrap {
  position: relative;
  display: inline-flex;
  align-items: center;
  margin-left: 5px;
  vertical-align: middle;
  cursor: default;
}
.icon {
  width: 14px;
  height: 14px;
  border-radius: 50%;
  border: 1px solid var(--muted);
  color: var(--muted);
  font-size: 9px;
  font-style: italic;
  font-weight: 700;
  font-family: serif;
  display: flex;
  align-items: center;
  justify-content: center;
  opacity: 0.5;
  transition: opacity 0.1s;
  line-height: 1;
  flex-shrink: 0;
}
.wrap:hover .icon {
  opacity: 1;
}
.box {
  position: absolute;
  bottom: calc(100% + 7px);
  left: 50%;
  transform: translateX(-50%);
  background: #1a1a1a;
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 8px 11px;
  font-size: 11px;
  font-style: normal;
  font-weight: 400;
  font-family: sans-serif;
  color: var(--fg);
  line-height: 1.5;
  width: max-content;
  max-width: 230px;
  white-space: normal;
  text-align: left;
  z-index: 200;
  box-shadow: 0 4px 14px rgba(0,0,0,0.45);
  pointer-events: none;
}
</style>
