const SAMPLE_LABEL_DEFINITIONS = Object.freeze([
  { name: 'bark',       color: '#e74c3c', shortcut: 'b', duration: '1–3 s', occupancy: '50–80 %' },
  { name: 'yap',        color: '#e67e22', shortcut: 'y', duration: '1–3 s', occupancy: '50–80 %' },
  { name: 'background', color: '#27ae60', shortcut: 'a', duration: '3–5 s', occupancy: 'n/a' },
  { name: 'wind',       color: '#2980b9', shortcut: 'd', duration: '3–5 s', occupancy: 'n/a' },
  { name: 'homestead',  color: '#8e44ad', shortcut: 'h', duration: '3–5 s', occupancy: 'n/a' },
  { name: 'traffic',    color: '#7f8c8d', shortcut: 't', duration: '3–5 s', occupancy: 'n/a' },
  { name: 'wildlife',   color: '#2ea096', shortcut: 'e', duration: '1–3 s', occupancy: '50–80 %' },
  { name: 'gunshot',    color: '#333333', shortcut: 's', duration: '1–3 s', occupancy: '50–80 %' },
  { name: 'wrongdog',   color: '#8a8c00', shortcut: 'r', duration: '1–3 s', occupancy: '50–80 %' },
].map(Object.freeze));

const REVIEW_FRAGMENT_DEFINITION = Object.freeze({
  name: 'review', color: '#f1c40f', shortcut: 'v', duration: 'n/a', occupancy: 'n/a',
});

const FRAGMENT_LABEL_DEFINITIONS = Object.freeze([
  ...SAMPLE_LABEL_DEFINITIONS,
  REVIEW_FRAGMENT_DEFINITION,
]);

export const SAMPLE_LABELS = Object.freeze(
  SAMPLE_LABEL_DEFINITIONS.map(({ name }) => name),
);

/** Fragment-only review state plus the labels used by trainable samples. */
export const FRAGMENT_LABELS = Object.freeze(
  FRAGMENT_LABEL_DEFINITIONS.map(({ name }) => name),
);

export const SAMPLE_LABEL_GUIDELINES = Object.freeze(Object.fromEntries(
  SAMPLE_LABEL_DEFINITIONS.map(({ name, duration, occupancy }) => [
    name,
    Object.freeze({ duration, occupancy }),
  ]),
));

const LABEL_COLORS = new Map(
  FRAGMENT_LABEL_DEFINITIONS.map(({ name, color }) => [name, color]),
);

/** Map from shortcut key (single letter) to label name. */
export const LABEL_BY_SHORTCUT = new Map(
  FRAGMENT_LABEL_DEFINITIONS.map(({ name, shortcut }) => [shortcut, name]),
);

/** Shortcut map limited to labels accepted for whole training samples. */
export const SAMPLE_LABEL_BY_SHORTCUT = new Map(
  SAMPLE_LABEL_DEFINITIONS.map(({ name, shortcut }) => [shortcut, name]),
);

/** Resolve a training-view label hotkey and whether it targets one fragment or the whole sample. */
export function trainingLabelActionForShortcut(key, shiftKey = false) {
  const shortcut = String(key).toLowerCase();
  const label = (shiftKey ? SAMPLE_LABEL_BY_SHORTCUT : LABEL_BY_SHORTCUT).get(shortcut);
  return label ? { label, scope: shiftKey ? 'sample' : 'fragment' } : null;
}

/** Non-note annotations that still need changing during a whole-sample relabel. */
export function fragmentRelabelTargets(annotations, label) {
  return annotations.filter(annotation => annotation.source !== 'note' && annotation.label !== label);
}

/** Filter the training sidebar by sample label or fragment-derived review state. */
export function filterTrainingSamples(samples, filterLabel, sampleFragments) {
  if (filterLabel === 'all') return samples;
  if (filterLabel === 'unmarked') {
    return samples.filter((sample) => (sampleFragments.get(sample.id) ?? []).length === 0);
  }
  if (filterLabel === 'review') {
    return samples.filter((sample) =>
      (sampleFragments.get(sample.id) ?? []).some((fragment) => fragment.label === 'review')
    );
  }
  return samples.filter((sample) => sample.label === filterLabel);
}

/** Resolve a whole-sample label hotkey and its diary-retention modifier. */
export function sampleMoveForShortcut(key, shiftKey = false) {
  const label = SAMPLE_LABEL_BY_SHORTCUT.get(String(key).toLowerCase());
  return label ? { label, keepInDiary: !shiftKey } : null;
}

/** Return the single-letter keyboard shortcut for a label, or '' if none. */
export function sampleLabelShortcut(label) {
  return FRAGMENT_LABEL_DEFINITIONS.find(d => d.name === label)?.shortcut ?? '';
}

export function sampleLabelColor(label) {
  return LABEL_COLORS.get(label) ?? '#4a7cdc';
}
