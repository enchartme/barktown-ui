<script>
  import { reanalysis, reanalysisFetch } from '$lib/reanalysis.js';
  import { PRIVATE_API_BASE } from '$lib/utils.js';
  let { date, disabled = false } = $props();
  let error = $state('');
  const job = $derived($reanalysis.kind === 'day' && $reanalysis.date === date ? $reanalysis : null);
  async function start() {
    if (!$reanalysis.available || $reanalysis.active || disabled) return;
    error = '';
    try {
      const response = await reanalysisFetch(`${PRIVATE_API_BASE}/api/diary/reanalyze-day`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ date }),
      });
      if (!response.ok) {
        const body = await response.json();
        throw new Error(body.error ?? `HTTP ${response.status}`);
      }
    } catch (e) { error = e.message; }
  }
</script>

<span class="day-reanalysis">
  <button onclick={start} disabled={disabled || !$reanalysis.available || $reanalysis.active}
    title={$reanalysis.active ? "Re-analysis is in progress; wait for it to finish" : "Re-score all available source recordings for this day using current detector settings"}
    aria-label={`Re-analyze recordings for ${date}`}>Re-analyze day</button>
  {#if job}
    <span class="progress" role="status">
      {job.preparing ? 'Preparing…' : `${job.active ? 'Processing' : 'Finished'} ${job.completed}/${job.total}`}
      {#if job.failed} · {job.failed} failed{/if}
      {#if job.skipped} · {job.skipped} without source{/if}
    </span>
    {#if job.errors?.length}<span class="error" role="alert">{job.errors[0].error}</span>{/if}
  {/if}
  {#if error}<span class="error" role="alert">{error}</span>{/if}
</span>

<style>
  .day-reanalysis { display: inline-flex; align-items: center; flex-wrap: wrap; gap: 0.4rem; max-width: 100%; font: 12px var(--font-body); }
  button { max-width: 100%; padding: 0.25rem 0.45rem; border: 1px solid #ccc; border-radius: 4px; background: #fafafa; color: #2255bb; cursor: pointer; font: inherit; }
  button:disabled { opacity: 0.45; cursor: not-allowed; }
  .progress { color: #666; }
  .error { color: #a32b20; }
  @media print { .day-reanalysis { display: none; } }
</style>
