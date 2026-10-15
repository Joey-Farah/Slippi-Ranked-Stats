<script lang="ts">
  // DEV ONLY until slice 8 of docs/plans/direct-billing.md: the card route's sign-in, for
  // testing against the staging worker. Sidebar.svelte renders it behind import.meta.env.DEV.
  // Slice 7 replaces this with the real UI.
  import {
    cardAccount,
    startSignIn,
    confirmCode,
    subscribe,
    signOut,
    SignInError,
    type SignInFailure,
  } from "../lib/card-premium";

  const MESSAGES: Record<SignInFailure, string> = {
    bad_email: "That doesn't look like an email address.",
    wrong_code: "That code isn't right.",
    code_expired: "That code has expired. Send a new one.",
    rate_limited: "Too many codes sent. Try again in an hour.",
    email_failed: "Couldn't send the email. Try again in a minute.",
    storage: "Couldn't read or save your sign-in on this computer. Restarting the app may fix it.",
    unreachable: "Couldn't reach the server. Check your connection and try again.",
  };

  let email = $state("");
  let code = $state("");
  let busy = $state(false);
  let error = $state("");

  async function run(step: () => Promise<void>) {
    busy = true;
    error = "";
    try {
      await step();
      code = "";
    } catch (e) {
      error = MESSAGES[e instanceof SignInError ? e.reason : "unreachable"];
    } finally {
      busy = false;
    }
  }

  const sendCode = () => email.trim() && run(() => startSignIn(email));
  const submitCode = () => code.trim() && run(() => confirmCode(code));
  const startSubscribe = () => run(subscribe);
</script>

<div style="margin-top:10px; padding:8px; border:1px dashed var(--accent); border-radius:6px">
  <div style="font-size:10px; font-weight:700; color:var(--accent); letter-spacing:0.05em; margin-bottom:6px">
    DEV · CARD PREMIUM
  </div>

  {#if $cardAccount.kind === "premium"}
    <div style="font-size:12px; margin-bottom:2px; color:var(--accent); font-weight:700">✓ Premium</div>
    <div style="font-size:11px; color:var(--muted); margin-bottom:6px; overflow-wrap:anywhere">
      {$cardAccount.email}
    </div>
    <button class="btn btn-secondary" style="width:100%; font-size:11px" disabled={busy}
      onclick={() => run(signOut)}>Sign out</button>

  {:else if $cardAccount.kind === "signed_in"}
    <div style="font-size:12px; margin-bottom:6px; overflow-wrap:anywhere">
      Signed in as {$cardAccount.email}
    </div>
    {#if $cardAccount.awaitingPayment}
      <div style="font-size:11px; color:var(--muted); margin-bottom:6px; line-height:1.4">
        Finish checking out in your browser. Premium switches on here by itself.
      </div>
    {:else}
      <button class="btn btn-primary" style="width:100%; font-size:11px; margin-bottom:6px" disabled={busy}
        onclick={startSubscribe}>Subscribe · $5/month</button>
    {/if}
    <button class="btn btn-secondary" style="width:100%; font-size:11px" disabled={busy}
      onclick={() => run(signOut)}>Sign out</button>

  {:else if $cardAccount.kind === "code_sent"}
    <div style="font-size:11px; color:var(--muted); margin-bottom:6px; line-height:1.4; overflow-wrap:anywhere">
      Enter the code sent to {$cardAccount.email}
    </div>
    <input
      type="text"
      inputmode="numeric"
      autocomplete="one-time-code"
      maxlength={6}
      placeholder="123456"
      bind:value={code}
      onkeydown={(e) => { if (e.key === "Enter") submitCode(); }}
      style="font-size:12px; width:100%; margin-bottom:6px; letter-spacing:0.2em"
    />
    <div style="display:flex; gap:6px">
      <button class="btn btn-primary" style="flex:1; font-size:11px" disabled={busy}
        onclick={submitCode}>Sign in</button>
      <button class="btn btn-secondary" style="flex:1; font-size:11px" disabled={busy}
        onclick={() => run(signOut)}>Change email</button>
    </div>

  {:else}
    {#if $cardAccount.kind === "replaced"}
      <div style="font-size:11px; color:var(--muted); margin-bottom:6px; line-height:1.4">
        Signed in on another computer. Sign in again to use Premium here.
      </div>
    {/if}
    <input
      type="email"
      placeholder="you@example.com"
      bind:value={email}
      onkeydown={(e) => { if (e.key === "Enter") sendCode(); }}
      style="font-size:12px; width:100%; margin-bottom:6px"
    />
    <button class="btn btn-primary" style="width:100%; font-size:11px" disabled={busy}
      onclick={sendCode}>Email me a code</button>
  {/if}

  {#if error}
    <div style="font-size:11px; color:#e74c3c; margin-top:6px; line-height:1.4">{error}</div>
  {/if}
</div>
