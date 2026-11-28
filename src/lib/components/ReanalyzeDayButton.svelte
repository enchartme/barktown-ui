<script>
  import { formatNumber } from '$lib/number-format.js';
  import { reanalysis, reanalysisFetch } from '$lib/reanalysis.js';
  import { PRIVATE_API_BASE } from '$lib/utils.js';
  let { date, disabled = false } = $props();
  const blockedReason = $derived(
    $reanalysis.active ? 'Re-analysis is already in progress. Wait for it to finish.'
    : !$reanalysis.available ? 'The private re-analysis API is unavailable. Check your Tailnet connection.'
    : disabled ? 'No recordings in this day have an available source recording for re-analysis.'
    : '',
  );
  let error = $state('');
  let confirming = $state(false);
  let threshold = $state(0.9);
  $effect(() => {
    void date;
    confirming = false;
    threshold = 0.9;
    error = '';
  });
  function confirm() {
    if (!$reanalysis.available || $reanalysis.active || disabled) return;
    threshold = 0.9;
    error = '';
    confirming = true;
  }
  const job = $derived($reanalysis.kind === 'day' && $reanalysis.date === date ? $reanalysis : null);
  async function start() {
    if (!confirming || !$reanalysis.available || $reanalysis.active || disabled) return;
    confirming = false;
    error = '';
    try {
      const response = await reanalysisFetch(`${PRIVATE_API_BASE}/api/diary/reanalyze-day`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ date, candidateThreshold: threshold }),
      });
      if (!response.ok) {
        const body = await response.json();
        throw new Error(body.error ?? `HTTP ${response.status}`);
      }
    } catch (e) { error = e.message; }
  }
</script>

<span class="day-reanalysis">
  {#if confirming}
    <span class="confirmation">
      <span>Re-analyze day?</span>
      <label class="threshold" title="Classifier threshold for this day's re-analysis only">
        <span>t {formatNumber(threshold, 2)}</span>
        <input type="range" min="0.8" max="1" step="0.01" bind:value={threshold}
          disabled={disabled || !$reanalysis.available || $reanalysis.active}
          aria-label={`Re-analysis classifier threshold for ${date}`} />
      </label>
      <span class="reanalyze-control" class:blocked={Boolean(blockedReason)} title={blockedReason || undefined}>
      <button class="confirm-run" onclick={start}
        disabled={disabled || !$reanalysis.available || $reanalysis.active}
        title={blockedReason || 'Start day re-analysis'}
        aria-label={`Start re-analysis for ${date}`}>Run</button>
      </span>
      <button onclick={() => { confirming = false; }} aria-label="Cancel day re-analysis">Cancel</button>
    </span>
  {:else}
    <span class="reanalyze-control" class:blocked={Boolean(blockedReason)} title={blockedReason || undefined}>
    <button class="reanalyze-button" onclick={confirm} disabled={disabled || !$reanalysis.available || $reanalysis.active}
      title={blockedReason || "Re-score all available source recordings for this day using current detector settings"}
      aria-label={`Re-analyze recordings for ${date}`}>🔁</button>
    </span>
  {/if}
  {#if job?.active}
    <span class="progress" role="status">
      {job.preparing ? 'Preparing…' : `Processing ${formatNumber(job.completed)}/${formatNumber(job.total)}`}
      {#if job.failed} · {job.failed} failed{/if}
      {#if job.skipped} · {job.skipped} without source{/if}
    </span>
  {/if}
  {#if job?.errors?.length}<span class="error" role="alert">{job.errors[0].error}</span>{/if}
  {#if error}<span class="error" role="alert">{error}</span>{/if}
</span>

<style>
  .reanalyze-control { display: inline-flex; }
  .reanalyze-control.blocked { cursor: not-allowed; }
  .reanalyze-control button:disabled { pointer-events: none; }
  .day-reanalysis { display: inline-flex; align-items: center; justify-content: flex-end; flex-wrap: wrap; gap: 0.4rem; max-width: 100%; color: #777; font-family: var(--font-tiny); font-size: var(--font-size-tiny); font-weight: 500; }
  button { max-width: 100%; padding: 0.25rem 0.45rem; border: 1px solid #ccc; border-radius: 4px; background: #fafafa; color: #2255bb; cursor: pointer; font: inherit; }
  button:disabled { opacity: 0.45; cursor: not-allowed; }
  .confirmation { display: inline-flex; align-items: center; justify-content: flex-end; flex-wrap: wrap; gap: 0.4rem; }
  .threshold { display: inline-flex; align-items: center; gap: 0.2rem; white-space: nowrap; }
  .threshold span { min-width: 2.85rem; text-align: right; font-variant-numeric: tabular-nums; }
  .threshold input { width: 3.75rem; margin: 0; accent-color: #2255bb; cursor: pointer; }
  .confirm-run { background: #2255bb; border-color: #2255bb; color: #fff; }
  .reanalyze-button { border: 0; background: transparent; font-size: 16px; line-height: 1; }
  .reanalyze-button:hover:not(:disabled) { background: #e8f4ff; }
  .progress { text-align: right; }
  .error { color: #a32b20; }
  @media print { .day-reanalysis { display: none; } }
</style>
