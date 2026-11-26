<script>
  import { autoApproveDay, autoApprovalRunning } from '$lib/auto-approval.js';
  import { reanalysis } from '$lib/reanalysis.js';

  let { date, disabled = false } = $props();
  let confirming = $state(false);
  let error = $state('');
  let result = $state(null);
  let running = $state(false);
  const blockedReason = $derived(
    $reanalysis.active ? 'Wait for re-analysis to finish.'
    : $autoApprovalRunning ? 'Automatic approval is already in progress.'
    : !$reanalysis.available ? 'The private API is unavailable. Check your Tailnet connection.'
    : disabled ? 'No unapproved audio records in this day.' : '',
  );
  $effect(() => { void date; confirming = false; error = ''; result = null; });
  async function start() {
    if (!confirming || blockedReason) return;
    confirming = false;
    error = '';
    result = null;
    running = true;
    try { result = await autoApproveDay(date); }
    catch (e) { error = e.message; }
    finally { running = false; }
  }
</script>

<span class="day-auto-approval">
  {#if confirming}
    <span>Auto-approve unapproved records?</span>
    <button class="confirm-run" onclick={start} disabled={Boolean(blockedReason)} title={blockedReason || undefined}>Run</button>
    <button onclick={() => confirming = false}>Cancel</button>
  {:else}
    <span title={blockedReason || 'Approve records that meet all saved thresholds'}>
      <button class="approve-button" onclick={() => { confirming = true; result = null; error = ''; }} disabled={Boolean(blockedReason)} aria-label={running ? `Approving records for ${date}` : `Auto-approve records for ${date}`} aria-busy={running}>
        <svg class="approve-icon" aria-hidden="true" focusable="false" clip-rule="evenodd" fill-rule="evenodd" stroke-linejoin="round" stroke-miterlimit="2" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
          <path d="m9.831 16.198.002-.003-1.113-.996-.004.004-2.468-2.202c-.144-.128-.322-.191-.5-.191-.417 0-.749.337-.749.75 0 .206.084.412.249.56l2.478 2.21-.767.873-4.71-4.202c-.144-.128-.322-.191-.5-.191-.416 0-.749.337-.749.75 0 .206.084.412.25.56l5.268 4.7c.143.128.321.191.499.191.206 0 .41-.084.559-.25l1.264-1.437 1.677 1.496c.143.128.321.191.499.191.206 0 .409-.084.558-.25l11.234-12.499c.129-.143.192-.322.192-.501 0-.419-.338-.75-.748-.75-.206 0-.411.084-.559.249l-10.735 11.943zm-.451-1.75 1.114.996 8.316-9.182c.128-.143.191-.322.191-.501 0-.419-.337-.75-.748-.75-.206 0-.411.084-.559.249z" fill-rule="nonzero" />
        </svg>
      </button>
    </span>
  {/if}
  {#if result}<span role="status">{result.approved} approved{#if result.trimmed} · {result.trimmed} trimmed{/if} · {result.skipped} left for review</span>{/if}
  {#if error}<span class="error" role="alert">{error}</span>{/if}
</span>

<style>
  .day-auto-approval { display: inline-flex; align-items: center; justify-content: flex-end; flex-wrap: wrap; gap: 0.4rem; max-width: 100%; color: #777; font-family: var(--font-tiny); font-size: var(--font-size-tiny); font-weight: 500; }
  button { padding: 0.25rem 0.45rem; border: 1px solid #ccc; border-radius: 4px; background: #fafafa; color: #2255bb; cursor: pointer; font: inherit; }
  button:disabled { opacity: 0.45; cursor: not-allowed; }
  button:hover:not(:disabled) { background: #e8f4ff; }
  .approve-button { display: inline-flex; align-items: center; justify-content: center; border: 0; background: transparent; line-height: 1; }
  .approve-button:hover:not(:disabled) { background: #eaf7ec; }
  .approve-icon { width: 20px; height: 20px; box-sizing: border-box; padding: 2px; border-radius: 3px; background: #4caf50; fill: #fff; }
  .confirm-run { background: #2255bb; border-color: #2255bb; color: #fff; }
  .error { color: #a32b20; }
  @media print { .day-auto-approval { display: none; } }
</style>
