import { SAMPLE_LABELS } from './sample-labels.js';
import { trimHitMetadata } from './diary-trim.js';

export const POSITIVE_LABELS = Object.freeze(['bark', 'yap']);
export const NEGATIVE_LABELS = Object.freeze(SAMPLE_LABELS.filter(label => !POSITIVE_LABELS.includes(label)));
export const FILTER_DEFINITIONS = Object.freeze([
  { name: 'positive', displayName: 'Top positive', description: 'Highest confidence among bark and yap' },
  ...POSITIVE_LABELS.map(name => ({ name, description: `${name} confidence` })),
  { name: 'negative', displayName: 'Top negative', description: 'Highest confidence among all labels except bark and yap' },
  ...NEGATIVE_LABELS.map(name => ({ name, description: `${name} confidence` })),
  { name: 'delta', displayName: 'Delta (top positive – top negative)', description: 'Highest positive confidence minus highest negative confidence' },
].map(filter => Object.freeze({
  ...filter,
  ranges: filter.name === 'delta' ? { min: [-1, 1], max: [-1, 1] } : { min: [0, 1], max: [0, 1] },
})));

export const DEFAULT_HIT_FILTERS = Object.freeze(Object.fromEntries(
  FILTER_DEFINITIONS.flatMap(({ name, ranges }) => [
    [`filter_${name}_min`, ranges.min[0]], [`filter_${name}_max`, ranges.max[1]],
  ]),
));

/** Missing scores do not contribute to a group maximum; no scores means unavailable. */
export function aggregateHitScores(scores) {
  const maximum = labels => {
    const values = labels.map(label => scores?.[label]).filter(Number.isFinite);
    return values.length ? Math.max(...values) : null;
  };
  const positive = maximum(POSITIVE_LABELS);
  const negative = maximum(NEGATIVE_LABELS);
  return { positive, negative, delta: positive === null || negative === null ? null : positive - negative };
}

/** Every available individual and aggregate score must meet inclusive bounds. */
export function hitPassesFilters(scores, settings = DEFAULT_HIT_FILTERS) {
  const values = { ...scores, ...aggregateHitScores(scores) };
  return FILTER_DEFINITIONS.every(({ name }) => {
    const score = values[name];
    return !Number.isFinite(score) || (
      score >= (settings[`filter_${name}_min`] ?? DEFAULT_HIT_FILTERS[`filter_${name}_min`]) - Number.EPSILON
      && score <= (settings[`filter_${name}_max`] ?? DEFAULT_HIT_FILTERS[`filter_${name}_max`]) + Number.EPSILON
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
