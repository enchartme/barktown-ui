<script>
  import { hitFilters, autoApprovalThresholds, settingsError, loadSettings, saveSettings } from '$lib/settings.js';
  import { AUTO_APPROVAL_CONTROLS, DEFAULT_AUTO_APPROVAL } from '$lib/auto-approval.js';
  import { DEFAULT_HIT_FILTERS, FILTER_DEFINITIONS } from '$lib/hit-filters.js';
  import { sampleLabelColor } from '$lib/sample-labels.js';

  let open = $state(false);
  let tab = $state('filters');
  let drafts = $state({ ...DEFAULT_HIT_FILTERS });
  let approvalDrafts = $state({ ...DEFAULT_AUTO_APPROVAL });
  let busy = $state(false);
  let error = $state('');
  let saved = $state(false);

  async function show() {
    open = !open;
    if (!open) return;
    error = '';
    saved = false;
    drafts = { ...$hitFilters };
    approvalDrafts = { ...$autoApprovalThresholds };
    busy = true;
    try { await loadSettings(); drafts = { ...$hitFilters }; approvalDrafts = { ...$autoApprovalThresholds }; }
    catch (e) { error = e.message; }
    finally { busy = false; }
  }

  async function save() {
    if (busy) return;
    error = '';
    saved = false;
    for (const { name: label, ranges } of tab === 'filters' ? FILTER_DEFINITIONS : []) {
      const min = drafts[`filter_${label}_min`];
      const max = drafts[`filter_${label}_max`];
      if (!Number.isFinite(min) || !Number.isFinite(max) || min < ranges.min[0] || min > ranges.min[1] || max < ranges.max[0] || max > ranges.max[1] || min > max) {
        error = `${label}: minimum must be ${ranges.min[0]} to ${ranges.min[1]}, maximum ${ranges.max[0]} to ${ranges.max[1]}, with minimum ≤ maximum.`;
        return;
      }
    }
    if (tab === 'approval') {
      for (const control of AUTO_APPROVAL_CONTROLS) {
        const value = approvalDrafts[control.key];
        if (!Number.isFinite(value) || value < control.min || value > control.max || (control.integer && !Number.isInteger(value))) {
          error = `${control.label} must be between ${control.min} and ${control.max}.`;
          return;
        }
      }
    }
    busy = true;
    try { await saveSettings(tab === 'filters' ? drafts : approvalDrafts); saved = true; }
    catch (e) { error = e.message; }
    finally { busy = false; }
  }
</script>

<svelte:window onkeydown={event => { if (event.key === 'Escape') open = false; }} />

<div class="filter-settings">
  <button class="settings-toggle" onclick={show} aria-label="Bark settings" aria-expanded={open}>⚙️</button>
  {#if open}
    <section class="settings-card" aria-label="Bark settings">
      <div class="card-heading"><strong>Bark settings</strong><button onclick={() => open = false} aria-label="Close bark settings">✕</button></div>
      <div class="tabs" role="tablist" aria-label="Bark settings">
        <button role="tab" id="bark-filters-tab" aria-selected={tab === 'filters'} aria-controls="bark-filters-panel" disabled={busy} onclick={() => { tab = 'filters'; saved = false; error = ''; }}>Hide barks from view</button>
        <button role="tab" id="auto-approval-tab" aria-selected={tab === 'approval'} aria-controls="auto-approval-panel" disabled={busy} onclick={() => { tab = 'approval'; saved = false; error = ''; }}>Auto-approve</button>
      </div>
      {#if tab === 'filters'}
      <div role="tabpanel" id="bark-filters-panel" aria-labelledby="bark-filters-tab">
      <p>Filter bark hits and bark counts visible in the Diary and Report views. Hits that don't pass the filter stay a little bit visible for admins (on Tailnet)</p>
        <div class="filter-grid">
          <span>Filter</span><span>Min</span><span>Max</span>
          {#each FILTER_DEFINITIONS as filter}
            {@const label = filter.name}
            {#if label === 'negative' || label === 'delta'}
              <hr class="filter-divider" />
            {/if}
            {#if label === 'positive' || label === 'negative' || label === 'delta'}
              <span class="aggregate-filter" title={filter.description}>
                {#if label === 'delta'}Delta:<br />top positive<br />– top negative{:else}{filter.displayName}{/if}
              </span>
            {:else}
              <span class="sample-label-pill" style:background={sampleLabelColor(label)} title={filter.description}>{label}</span>
            {/if}
            {#each ['min', 'max'] as bound}
              <label class="slider-control">
                <input type="range" min={filter.ranges[bound][0]} max={filter.ranges[bound][1]} step="0.01" aria-label="{filter.displayName ?? label} {bound === 'min' ? 'minimum' : 'maximum'}" bind:value={drafts[`filter_${label}_${bound}`]} oninput={() => saved = false} onchange={() => save()} disabled={busy} />
                <output>{drafts[`filter_${label}_${bound}`].toFixed(2)}</output>
              </label>
            {/each}
          {/each}
        </div>
        <div class="actions"><button type="button" disabled={busy} onclick={() => { drafts = { ...DEFAULT_HIT_FILTERS }; void save(); }}>Reset ranges</button></div>
      </div>
      {:else}
      <div role="tabpanel" id="auto-approval-panel" aria-labelledby="auto-approval-tab">
        <p>Approve unapproved records using the day’s Auto-approve button. {approvalDrafts.auto_approve_require_all === 0 ? 'At least 1 approval condition must pass' : 'All 4 approval conditions must pass'}, using every detected window inside the proposed trim, including hidden barks. At least two windows with loudness and both positive and negative scores are required.</p>
        <div class="approval-grid">
          {#each AUTO_APPROVAL_CONTROLS as control}
            <label for={control.key}>{control.label}</label>
            <label class="slider-control">
              {#if control.options}
              <select id={control.key} bind:value={approvalDrafts[control.key]} aria-label={control.label} onchange={() => save()} disabled={busy}>
                {#each control.options as option}<option value={option.value}>{option.label}</option>{/each}
              </select>
              {:else}
              <input id={control.key} type="range" min={control.min} max={control.max} step={control.step} bind:value={approvalDrafts[control.key]} aria-label={control.label} aria-describedby={control.helpId} oninput={() => saved = false} onchange={() => save()} disabled={busy || (control.key === 'auto_approve_bundle_count' && approvalDrafts.auto_approve_trim_sparse_tails_s === 0)} />
              <output>{control.key === 'auto_approve_trim_sparse_tails_s' && approvalDrafts[control.key] === 0 ? 'Off (0s)' : `${approvalDrafts[control.key].toFixed(control.digits)}${control.unit}`}</output>
              {/if}
            </label>
            {#if control.key === 'auto_approve_delta_sigma_max'}
              <p id="delta-sigma-help" class="control-help">Δσ measures variation in window delta. Lower is stricter; 0.10 is the starting limit.</p>
            {/if}
            {#if control.key === 'auto_approve_bundle_count'}
              <p id="sparse-tails-help" class="control-help">0s turns trimming off. A bundle must fit within the time limit and have an extra window less than that limit before or after it. Keep from the first qualifying group through the last, including all sessions and gaps between them. Trim is saved only when the record passes approval.</p>
            {/if}
          {/each}
        </div>
        <div class="actions"><button type="button" disabled={busy} onclick={() => { approvalDrafts = { ...DEFAULT_AUTO_APPROVAL }; void save(); }}>Reset thresholds</button></div>
      </div>
      {/if}
      {#if error || $settingsError}<p class="error" role="alert">{error || $settingsError}</p>{/if}
      {#if saved}<p role="status">{tab === 'filters' ? 'Filters saved.' : 'Thresholds saved.'}</p>{/if}
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
  .filter-grid { display: grid; grid-template-columns: minmax(0, 1.3fr) repeat(2, minmax(0, 1fr)); gap: 8px; align-items: center; }
  .tabs { display: flex; gap: 4px; margin: 12px 0; border-bottom: 1px solid #ddd; }
  .tabs button { flex: 1; padding: 8px 4px; border: 0; border-bottom: 2px solid transparent; background: none; color: #777; }
  .tabs button[aria-selected="true"] { color: #2255bb; border-bottom-color: #2255bb; font-weight: 700; }
  .approval-grid { display: grid; grid-template-columns: 1fr 1.4fr; gap: 14px 12px; align-items: center; margin: 20px 0; }
  .approval-grid select { width: 100%; min-width: 0; padding: 6px; border: 1px solid #ccc; border-radius: 4px; background: #fff; color: #333; font: inherit; }
  .control-help { grid-column: 1 / -1; margin: -8px 0 0; color: #777; }
  .filter-grid > span { align-self: start; }
  .filter-divider { grid-column: 1 / -1; width: 100%; margin: 4px 0; border: 0; border-top: 1px solid #e0e0dc; }
  .aggregate-filter { font-weight: 700; line-height: 1.4; }
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
