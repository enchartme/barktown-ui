/**
 * Resolve one diary entry's persisted non-destructive trim. Invalid or legacy
 * values fall back to the complete recording so public rendering stays safe.
 *
 * @param {{durationSec?: number, trimStartMs?: number|null, trimStopMs?: number|null}} entry
 */
export function diaryTrimBounds(entry) {
  const sourceDurationMs = Number.isFinite(entry?.durationSec)
    ? Math.max(0, Math.round(entry.durationSec * 1000))
    : 0;
  const storedStart = entry?.trimStartMs;
  const storedStop = entry?.trimStopMs;
  const hasValidTrim = Number.isInteger(storedStart)
    && Number.isInteger(storedStop)
    && storedStart >= 0
    && storedStop > storedStart
    && storedStop <= sourceDurationMs;
  const startMs = hasValidTrim ? storedStart : 0;
  const stopMs = hasValidTrim ? storedStop : sourceDurationMs;

  return {
    sourceDurationMs,
    startMs,
    stopMs,
    startSec: startMs / 1000,
    stopSec: stopMs / 1000,
    durationMs: Math.max(0, stopMs - startMs),
    durationSec: Math.max(0, stopMs - startMs) / 1000,
    isTrimmed: hasValidTrim && (startMs > 0 || stopMs < sourceDurationMs),
  };
}

/**
 * Keep hits inside the visible range and rebase timestamps so the trim is
 * presented as a complete, standalone recording.
 *
 * @param {Record<string, any>|null|undefined} metadata
 * @param {{durationSec?: number, trimStartMs?: number|null, trimStopMs?: number|null}} entry
 */
export function trimHitMetadata(metadata, entry) {
  if (!metadata || !Array.isArray(metadata.timestamps)) return metadata ?? null;
  const bounds = diaryTrimBounds(entry);
  if (!bounds.isTrimmed) return metadata;

  const indices = [];
  metadata.timestamps.forEach((timestamp, index) => {
    if (!Number.isFinite(timestamp)) return;
    if (timestamp >= bounds.startSec && timestamp < bounds.stopSec) indices.push(index);
  });

  const project = (values) => Array.isArray(values)
    ? indices.map(index => values[index])
    : [];
  return {
    ...metadata,
    timestamps: indices.map(index => metadata.timestamps[index] - bounds.startSec),
    filteredHits: project(metadata.filteredHits),
    confidences: project(metadata.confidences),
    loudnesses: project(metadata.loudnesses),
    multilabelScores: Array.isArray(metadata.multilabelScores)
      ? project(metadata.multilabelScores)
      : null,
  };
}
