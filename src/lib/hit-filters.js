import { SAMPLE_LABELS } from './sample-labels.js';
import { trimHitMetadata } from './diary-trim.js';

export const DEFAULT_HIT_FILTERS = Object.freeze(Object.fromEntries(
  SAMPLE_LABELS.flatMap(label => [[`filter_${label}_min`, 0], [`filter_${label}_max`, 1]]),
));

/** All available scores must meet inclusive bounds. Missing diagnostics pass. */
export function hitPassesFilters(scores, settings = DEFAULT_HIT_FILTERS) {
  return SAMPLE_LABELS.every(label => {
    const score = scores?.[label];
    return !Number.isFinite(score) || (
      score >= (settings[`filter_${label}_min`] ?? 0)
      && score <= (settings[`filter_${label}_max`] ?? 1)
    );
  });
}

/** Operator view retains original windows with an aligned presentation flag. */
export function markFilteredHits(metadata, settings = DEFAULT_HIT_FILTERS) {
  if (!Array.isArray(metadata?.timestamps)) return metadata;
  return { ...metadata, filteredHits: metadata.timestamps.map((_, i) => !hitPassesFilters(metadata.multilabelScores?.[i], settings)) };
}

export function filterHitMetadata(metadata, settings = DEFAULT_HIT_FILTERS) {
  if (!Array.isArray(metadata?.timestamps) || !Array.isArray(metadata.multilabelScores)) return metadata;
  const indices = metadata.timestamps.map((_, index) => index)
    .filter(index => hitPassesFilters(metadata.multilabelScores[index], settings));
  if (indices.length === metadata.timestamps.length) return metadata;
  const project = values => Array.isArray(values) ? indices.map(index => values[index]) : values;
  return {
    ...metadata,
    timestamps: project(metadata.timestamps),
    confidences: project(metadata.confidences),
    loudnesses: project(metadata.loudnesses),
    multilabelScores: project(metadata.multilabelScores),
  };
}

/** Difference from the server's unfiltered, trimmed summary count. */
export function hiddenHitCount(entry, metadata, settings) {
  const visible = trimHitMetadata(metadata, entry);
  return (visible?.timestamps?.length ?? 0) - (filterHitMetadata(visible, settings)?.timestamps?.length ?? 0);
}
