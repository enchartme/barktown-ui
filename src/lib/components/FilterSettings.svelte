<script>
  import { hitFilters, settingsError, loadSettings, saveSettings } from '$lib/settings.js';
  import { DEFAULT_HIT_FILTERS, FILTER_DEFINITIONS } from '$lib/hit-filters.js';
  import { sampleLabelColor } from '$lib/sample-labels.js';

  let open = $state(false);
  let drafts = $state({ ...DEFAULT_HIT_FILTERS });
  let busy = $state(false);
  let error = $state('');
  let saved = $state(false);

  async function show() {
    open = !open;
    if (!open) return;
    error = '';
    saved = false;
    drafts = { ...$hitFilters };
    busy = true;
    try { await loadSettings(); drafts = { ...$hitFilters }; }
    catch (e) { error = e.message; }
    finally { busy = false; }
  }

  async function save() {
    if (busy) return;
    error = '';
    saved = false;
    for (const { name: label, ranges } of FILTER_DEFINITIONS) {
      const min = drafts[`filter_${label}_min`];
      const max = drafts[`filter_${label}_max`];
      if (!Number.isFinite(min) || !Number.isFinite(max) || min < ranges.min[0] || min > ranges.min[1] || max < ranges.max[0] || max > ranges.max[1] || min > max) {
        error = `${label}: minimum must be ${ranges.min[0]} to ${ranges.min[1]}, maximum ${ranges.max[0]} to ${ranges.max[1]}, with minimum ≤ maximum.`;
        return;
      }
    }
    busy = true;
    try { await saveSettings(drafts); saved = true; }
    catch (e) { error = e.message; }
    finally { busy = false; }
  }
</script>

<svelte:window onkeydown={event => { if (event.key === 'Escape') open = false; }} />

<div class="filter-settings">
  <button class="settings-toggle" onclick={show} aria-label="Window filter settings" aria-expanded={open}>⚙️</button>
  {#if open}
    <section class="settings-card" aria-label="Window filter settings">
      <div class="card-heading"><strong>Window filters</strong><button onclick={() => open = false} aria-label="Close window filters">✕</button></div>
      <p>Show windows whose available label and aggregate scores fall within every range. Applies to everyone’s diary/report windows and bark counts. Missing scores stay visible.</p>
        <div class="filter-grid">
          <span>Filter</span><span>Min</span><span>Max</span>
          {#each FILTER_DEFINITIONS as filter}
            {@const label = filter.name}
            {#if label === 'negative' || label === 'delta'}
              <hr class="filter-divider" />
            {/if}
            {#if label === 'positive' || label === 'negative' || label === 'delta'}
              <span class="aggregate-filter" title={filter.description}>{label}</span>
            {:else}
              <span class="sample-label-pill" style:background={sampleLabelColor(label)} title={filter.description}>{label}</span>
            {/if}
            {#each ['min', 'max'] as bound}
              <label class="slider-control">
                <input type="range" min={filter.ranges[bound][0]} max={filter.ranges[bound][1]} step="0.01" aria-label="{label} {bound === 'min' ? 'minimum' : 'maximum'}" bind:value={drafts[`filter_${label}_${bound}`]} oninput={() => saved = false} onchange={() => save()} disabled={busy} />
                <output>{drafts[`filter_${label}_${bound}`].toFixed(2)}</output>
              </label>
            {/each}
          {/each}
        </div>
        <div class="actions"><button type="button" disabled={busy} onclick={() => { drafts = { ...DEFAULT_HIT_FILTERS }; void save(); }}>Reset ranges</button></div>
      {#if error || $settingsError}<p class="error" role="alert">{error || $settingsError}</p>{/if}
      {#if saved}<p role="status">Filters saved.</p>{/if}
    </section>
  {/if}
</div>

<style>
  .filter-settings { position: relative; }
  .settings-toggle { cursor: pointer; background: transparent; border: 1px solid #ddd; border-radius: 4px; padding: 4px 8px; }
  .settings-card { position: absolute; top: calc(100% + 8px); right: 0; z-index: 10000; width: min(360px, calc(100vw - 32px)); max-height: 80vh; overflow-y: auto; box-sizing: border-box; padding: 16px; background: white; color: #333; border: 1px solid #e0e0dc; border-radius: 8px; box-shadow: 0 8px 32px rgb(0 0 0 / 15%); font-family: var(--font-tiny); font-size: var(--font-size-tiny); }
  .card-heading, .actions { display: flex; justify-content: space-between; align-items: center; gap: 8px; }
  .card-heading strong { font-family: var(--font-heading); font-size: var(--font-size-small); font-weight: var(--font-heading-weight); }
  p { line-height: 1.4; margin: 10px 0; }
  .filter-grid { display: grid; grid-template-columns: max-content repeat(2, minmax(0, 1fr)); gap: 8px; align-items: center; }
  .filter-divider { grid-column: 1 / -1; width: 100%; margin: 4px 0; border: 0; border-top: 1px solid #e0e0dc; }
  .aggregate-filter { font-weight: 700; }
  .sample-label-pill { justify-self: start; font-family: var(--font-monospace); font-size: var(--font-size-tiny); font-weight: 700; text-transform: uppercase; padding: 0.1rem 0.4rem; border-radius: 8px; color: #fff; }
  .slider-control { display: flex; flex-direction: column; min-width: 0; gap: 2px; }
  input[type="range"] { width: 100%; min-width: 0; margin: 0; accent-color: #1a1a1a; cursor: pointer; }
  input:disabled { opacity: 0.4; cursor: default; }
  output { align-self: flex-end; font-family: var(--font-monospace); font-size: var(--font-size-tiny); font-variant-numeric: tabular-nums; }
  .actions { margin-top: 14px; }
  button { cursor: pointer; font-family: var(--font-tiny); font-size: var(--font-size-tiny); }
  .card-heading button { border: none; border-radius: 3px; background: none; color: #aaa; padding: 0.1rem 0.35rem; line-height: 1; }
  .card-heading button:hover { background: #eee; color: #333; }
  .actions button { border: 1px solid #d0d0cc; border-radius: 4px; background: #fff; color: #333; padding: 0.35rem 0.85rem; font-weight: 500; }
  .actions button:hover:not(:disabled) { opacity: 0.75; }
  button:disabled { opacity: 0.4; cursor: default; }
  .error { color: #b42318; }
  @media print { .filter-settings { display: none; } }
</style>
