import { writable } from 'svelte/store';
import { PRIVATE_API_BASE } from './utils.js';

const initial = { available: false, active: false, currentIds: [] };
let state = initial;
let pending = false;
let polling;
let previous;
let requestSequence = 0;
let appliedSequence = 0;
export const reanalysis = writable(initial, () => {
  let stopped = false;
  async function poll() {
    await refreshReanalysis();
    if (!stopped) polling = setTimeout(poll, state.available ? 1000 : 10000);
  }
  if (typeof window !== 'undefined') void poll();
  return () => { stopped = true; clearTimeout(polling); };
});
function publish(next) {
  state = next;
  reanalysis.set({ ...next, active: next.active || pending });
}

export async function refreshReanalysis() {
  const sequence = ++requestSequence;
  try {
    const response = await fetch(`${PRIVATE_API_BASE}/api/reanalysis`, {
      cache: 'no-store', signal: AbortSignal.timeout(4000),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const next = await response.json();
    if (!Array.isArray(next.currentIds) || typeof next.active !== 'boolean' || typeof next.revision !== 'number') throw new Error('Invalid progress response');
    if (sequence < appliedSequence) return;
    if (next.instanceId === state.instanceId && next.revision < state.revision) return;
    appliedSequence = sequence;
    publish({ ...next, available: true });
    // Refresh completed results in every open view, including clients joining mid-job.
    if (next.id && (!previous || previous.id !== next.id || previous.completed !== next.completed || previous.active !== next.active)) {
      window.dispatchEvent(new CustomEvent('reanalysis-update', { detail: next }));
    }
    previous = next;
  } catch {
    if (sequence < appliedSequence) return;
    appliedSequence = sequence;
    // Retain the last job while disconnected; only re-analysis controls depend on availability.
    publish({ ...state, available: false });
  }
}

/** Reserve locally immediately; the server makes the authoritative atomic decision. */
export async function reanalysisFetch(url, options) {
  if (pending || state.active) throw new Error('Re-analysis is already in progress.');
  pending = true;
  publish(state);
  try { return await fetch(url, options); }
  finally {
    await refreshReanalysis();
    pending = false;
    publish(state);
  }
}
