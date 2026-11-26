import { get, writable } from 'svelte/store';
import { PRIVATE_API_BASE } from './utils.js';
import { reanalysis } from './reanalysis.js';

export const AUTO_APPROVAL_CONTROLS = Object.freeze([
  { key: 'auto_approve_require_all', label: 'Approval conditions', min: 0, max: 1, integer: true, value: 1, options: [
    { value: 1, label: 'AND — all 4' }, { value: 0, label: 'OR — at least 1' },
  ] },
  { key: 'auto_approve_mean_loudness_min', label: 'Mean loudness ≥', min: 1, max: 10, step: .1, value: 4, unit: 'x', digits: 1 },
  { key: 'auto_approve_density_min', label: 'Density ≥', min: 0, max: 100, step: 1, value: 50, unit: '%', digits: 0 },
  { key: 'auto_approve_delta_mean_min', label: 'Δμ ≥', min: .5, max: 1, step: .01, value: .9, unit: '', digits: 2 },
  { key: 'auto_approve_delta_sigma_max', label: 'Δσ ≤', min: 0, max: 1, step: .01, value: .1, unit: '', digits: 2, helpId: 'delta-sigma-help' },
  { key: 'auto_approve_trim_sparse_tails_s', label: 'Trim sparse tails (s)', min: 0, max: 120, step: 1, value: 0, unit: 's', digits: 0, helpId: 'sparse-tails-help' },
  { key: 'auto_approve_bundle_count', label: 'Bundle (count)', min: 1, max: 5, step: 1, value: 1, unit: '', digits: 0, integer: true },
]);
export const DEFAULT_AUTO_APPROVAL = Object.freeze(Object.fromEntries(AUTO_APPROVAL_CONTROLS.map(control => [control.key, control.value])));
export const autoApprovalRunning = writable(false);

export async function autoApproveDay(date) {
  if (get(autoApprovalRunning)) throw new Error('Automatic approval is already in progress.');
  if (get(reanalysis).active) throw new Error('Wait for re-analysis to finish.');
  autoApprovalRunning.set(true);
  try {
    const response = await fetch(`${PRIVATE_API_BASE}/api/diary/auto-approve-day`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ date }), signal: AbortSignal.timeout(15000),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error ?? `HTTP ${response.status}`);
    if (!Array.isArray(result.items) || !Number.isInteger(result.approved) || !Number.isInteger(result.skipped)) throw new Error('Invalid automatic approval response');
    if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent('approval-update', { detail: result }));
    return result;
  } finally { autoApprovalRunning.set(false); }
}
