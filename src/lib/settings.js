import { derived, writable } from 'svelte/store';
import { hitMetadataById } from './hit-metadata.js';
import { DEFAULT_HIT_FILTERS, filterHitMetadata, markFilteredHits } from './hit-filters.js';
import { DEFAULT_AUTO_APPROVAL } from './auto-approval.js';
import { PUBLIC_API_BASE, PRIVATE_API_BASE } from './utils.js';

export const hitFilters = writable({ ...DEFAULT_HIT_FILTERS });
export const autoApprovalThresholds = writable({ ...DEFAULT_AUTO_APPROVAL });
export const settingsError = writable('');
let revision = 0;
export const filteredHitMetadataById = derived([hitMetadataById, hitFilters], ([metadata, filters]) =>
  new Map([...metadata].map(([id, row]) => [id, filterHitMetadata(row, filters)])),
);

export const markedHitMetadataById = derived([hitMetadataById, hitFilters], ([metadata, filters]) =>
  new Map([...metadata].map(([id, row]) => [id, markFilteredHits(row, filters)])),
);

function applySettings(rows) {
  if (!Array.isArray(rows)) throw new Error('Invalid settings response');
  const filters = { ...DEFAULT_HIT_FILTERS };
  const thresholds = { ...DEFAULT_AUTO_APPROVAL };
  for (const { key, value } of rows) {
    if (Object.hasOwn(filters, key) && Number.isFinite(value)) filters[key] = value;
    if (Object.hasOwn(thresholds, key) && Number.isFinite(value)) thresholds[key] = value;
  }
  hitFilters.set(filters);
  autoApprovalThresholds.set(thresholds);
  settingsError.set('');
  return filters;
}

export async function loadSettings() {
  const requestRevision = ++revision;
  try {
    const response = await fetch(`${PUBLIC_API_BASE}/api/settings`, { cache: 'no-store' });
    if (!response.ok) throw new Error(`Settings request failed (${response.status})`);
    const rows = await response.json();
    if (requestRevision === revision) return applySettings(rows);
  } catch (error) {
    if (requestRevision === revision) settingsError.set(error.message);
    throw error;
  }
}

export async function saveSettings(filters) {
  ++revision;
  const response = await fetch(`${PRIVATE_API_BASE}/api/settings`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(filters),
  });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error ?? `Settings save failed (${response.status})`);
  ++revision;
  return applySettings(body);
}
