import { writable } from 'svelte/store';
import { PUBLIC_API_BASE } from './utils.js';

/**
 * @typedef {{
 *   clipId: string,
 *   date: string | null,
 *   timestamps: number[],
 *   confidences: number[],
 *   loudnesses: number[],
 *   multilabelScores?: Record<string, number>[] | null,
 *   paddingS: number,
 *   windowS: number,
 *   modelTrainedAt: string | null,
 *   analysisSettings: Record<string, unknown>,
 *   analysisTrigger: 'automatic' | 'manual',
 *   analyzedAt?: string | null,
 *   createdAt: string
 * }} HitMetadata
 */

/** Shared reactive cache populated page-by-page by the bulk endpoint. */
export const hitMetadataById = writable(/** @type {Map<string, HitMetadata>} */ (new Map()));

const AUTO_DETECTED_LABEL = /^-A-(?:\s|$)/;

/** @param {HitMetadata} metadata @param {number} durationSec */
function hitMetadataStats(metadata, durationSec) {
  const hitCount = Array.isArray(metadata.timestamps) ? metadata.timestamps.length : 0;
  const confidences = Array.isArray(metadata.confidences)
    ? metadata.confidences.filter(Number.isFinite)
    : [];
  const loudnesses = Array.isArray(metadata.loudnesses)
    ? metadata.loudnesses.filter(Number.isFinite).sort((a, b) => a - b)
    : [];

  const maximumConfidence = confidences.length ? Math.max(...confidences) : 0;
  const maximumLoudness = loudnesses.length ? loudnesses[loudnesses.length - 1] : 0;
  const meanLoudness = loudnesses.length
    ? loudnesses.reduce((sum, loudness) => sum + loudness, 0) / loudnesses.length
    : 0;
  // D is the rounded percentage of clip time represented by passed bark windows.
  // The API exposes hit_metadata.window_s as windowS. Match the server's
  // legacy default only when a valid window duration is unavailable.
  const windowS = Number.isFinite(metadata.windowS) && metadata.windowS > 0
    ? metadata.windowS
    : 1.5;
  const density = Number.isFinite(durationSec) && durationSec > 0
    ? Math.round((hitCount * windowS / durationSec) * 100)
    : 0;

  return { hitCount, maximumConfidence, maximumLoudness, meanLoudness, density };
}

/**
 * Build the compact stats string for a hit-metadata row.
 *
 * @param {HitMetadata} metadata
 * @param {number} durationSec
 */
export function formatHitMetadataStats(metadata, durationSec) {
  const { hitCount, maximumConfidence, maximumLoudness, meanLoudness, density } =
    hitMetadataStats(metadata, durationSec);
  const confidenceTag = maximumConfidence >= 0.995
    ? 'C1'
    : `C${maximumConfidence.toFixed(2)}`;

  return `${confidenceTag} D${density}% W${hitCount} La${maximumLoudness.toFixed(1)} Lm${meanLoudness.toFixed(1)}`;
}

/** @param {{id?: string, filename?: string, sampleId?: string | null, label?: string, time?: string}} entry */
function diaryEntryDescriptor(entry) {
  const label = (entry.label || entry.time || '').trim();
  const isSample = Boolean(entry.sampleId)
    || /(?:^|_)SAMPLE(?:_|$)/i.test(entry.id ?? '')
    || /(?:^|\s)SAMPLE(?:\s|$)/i.test(entry.filename ?? '');

  if (AUTO_DETECTED_LABEL.test(label)) return '-A-';
  return isSample && !/^SAMPLE(?:\s|$)/i.test(label)
    ? `SAMPLE${label ? ` ${label}` : ''}`
    : label;
}

/**
 * Build a diary-entry title while preserving meaningful entry context.
 * Sample rows keep their SAMPLE marker and comment; current hit stats follow
 * the descriptor whenever metadata is available.
 *
 * @param {{
 *   id?: string,
 *   filename?: string,
 *   sampleId?: string | null,
 *   label?: string,
 *   time?: string,
 *   durationSec?: number
 * }} entry
 * @param {HitMetadata | null | undefined} metadata
 */
export function formatDiaryEntryTitle(entry, metadata) {
  const label = (entry.label || entry.time || '').trim();
  const descriptor = diaryEntryDescriptor(entry);

  if (!metadata) return descriptor;

  const stats = formatHitMetadataStats(metadata, entry.durationSec ?? 0);
  if (AUTO_DETECTED_LABEL.test(label)) return `-A- ${stats}`;
  return `${descriptor}${descriptor ? ' ' : ''}${stats}`;
}

/**
 * Build the expanded, user-facing title shown in the audio player panel.
 * Confidence remains available in compact diagnostic titles but is omitted
 * here in favor of the bark count, density, and loudness summary.
 *
 * @param {{
 *   id?: string,
 *   filename?: string,
 *   sampleId?: string | null,
 *   label?: string,
 *   time?: string,
 *   durationSec?: number
 * }} entry
 * @param {HitMetadata | null | undefined} metadata
 */
export function formatAudioPanelTitle(entry, metadata) {
  const descriptor = diaryEntryDescriptor(entry);
  if (!metadata) return descriptor;

  const stats = formatAudioPanelStats(metadata, entry.durationSec ?? 0);
  return `${descriptor}${descriptor ? ': ' : ''}${stats}`;
}

/** Expanded playback statistics without a filename/sample descriptor. */
export function formatAudioPanelStats(metadata, durationSec, filteredCount = null) {
  if (!metadata) return '';
  const { hitCount, maximumLoudness, meanLoudness, density } =
    hitMetadataStats(metadata, durationSec);
  return `Barks: ${hitCount}${filteredCount === null ? '' : ` (${filteredCount} filtered)`}, Density: ${density}%, Loudness Peak: ${maximumLoudness.toFixed(1)}x, Mean: ${meanLoudness.toFixed(1)}x`;
}

/**
 * Format the small, stable subset of analysis provenance shown in the audio
 * panel. Values are kept verbatim so the line can be used for diagnostics.
 *
 * @param {HitMetadata | null | undefined} metadata
 */
export function formatAudioPanelAnalysisParameters(metadata) {
  const settings = metadata?.analysisSettings;
  if (!settings || typeof settings !== 'object') return '';

  const classifier = settings.classifier;
  const monitor = settings.monitor;
  const parameters = [
    ['Trigger', metadata.analysisTrigger],
    ['Analyzed', formatLocalAnalysisTimestamp(metadata.analyzedAt)],
    ['Trained', formatLocalAnalysisTimestamp(classifier?.trained_at)],
    ['Threshold', monitor?.candidate_threshold],
    ['Refractory', formatSeconds(monitor?.hit_refractory_s)],
    ['Window', formatSeconds(monitor?.inference_window_s)],
    ['Step', formatSeconds(monitor?.score_interval_s)],
  ];

  const details = parameters
    .filter(([, value]) => value !== null && value !== undefined && value !== '')
    .map(([name, value]) => `${name}: ${String(value)}`)
    .join(' · ');
  return details ? `${details}` : '';
}

function formatSeconds(value) {
  return value === null || value === undefined || value === '' ? value : `${value}s`;
}

function formatLocalAnalysisTimestamp(value) {
  if (value === null || value === undefined || value === '') return value;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/**
 * Build the compact auto-detection label from the current hit-metadata row.
 * Non-auto labels and auto labels whose metadata has not loaded are returned
 * unchanged.
 *
 * @param {string} label
 * @param {HitMetadata | null | undefined} metadata
 * @param {number} durationSec
 */
export function formatAutoDetectionLabel(label, metadata, durationSec) {
  if (!AUTO_DETECTED_LABEL.test((label ?? '').trim()) || !metadata) return label;
  return `-A- ${formatHitMetadataStats(metadata, durationSec)}`;
}

/** Merge records into the cache while preserving already loaded pages. */
function mergeHitMetadata(items) {
  hitMetadataById.update((current) => {
    const next = new Map(current);
    for (const item of items) {
      if (item?.clipId) next.set(item.clipId, item);
    }
    return next;
  });
}

/** Update one cached record after re-analysis. */
export function setHitMetadata(id, metadata) {
  if (!id || !metadata) return;
  mergeHitMetadata([{ ...metadata, clipId: metadata.clipId ?? id }]);
}

/**
 * Load all pages of bulk hit metadata, following the API's advertised next
 * link rather than constructing subsequent page numbers in the client.
 * Each page is merged immediately so the UI can progressively enhance while
 * later pages are still loading.
 *
 * @param {{
 *   startDate?: string,
 *   endDate?: string,
 *   pageSize?: number,
 *   fetchImpl?: typeof fetch
 * }} [options]
 */
export async function loadHitMetadata({
  startDate,
  endDate,
  pageSize = 1000,
  fetchImpl = fetch,
} = {}) {
  const firstUrl = new URL('/api/hit-metadata', PUBLIC_API_BASE);
  firstUrl.searchParams.set('page', '1');
  firstUrl.searchParams.set('pageSize', String(pageSize));
  if (startDate) firstUrl.searchParams.set('startDate', startDate);
  if (endDate) firstUrl.searchParams.set('endDate', endDate);

  let nextUrl = firstUrl.toString();
  let pagesLoaded = 0;
  let recordsLoaded = 0;
  const visited = new Set();

  while (nextUrl) {
    if (visited.has(nextUrl)) throw new Error(`Hit metadata pagination cycle at ${nextUrl}`);
    visited.add(nextUrl);

    const res = await fetchImpl(nextUrl);
    if (!res.ok) throw new Error(`Hit metadata request failed: ${res.status} ${res.statusText}`);

    const body = await res.json();
    if (!Array.isArray(body?.items) || typeof body?.pagination !== 'object') {
      throw new Error('Hit metadata response has an invalid shape');
    }

    mergeHitMetadata(body.items);
    pagesLoaded += 1;
    recordsLoaded += body.items.length;

    const advertisedNext = body.links?.next;
    if (body.pagination.hasNextPage && !advertisedNext) {
      throw new Error('Hit metadata response indicates another page but provides no next link');
    }
    nextUrl = advertisedNext ? new URL(advertisedNext, PUBLIC_API_BASE).toString() : '';
  }

  return { pagesLoaded, recordsLoaded };
}
