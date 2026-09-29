const POSITIVE_LABELS = new Set(['bark', 'yap']);
const CONFIDENCE_BARS = '▁▂▃▄▅▆▇█';

export const WINDOW_REVIEW_ACTIONS = Object.freeze({
  'trim-start': Object.freeze({ icon: '➡️', label: 'Trim start' }),
  'trim-end': Object.freeze({ icon: '⬅️', label: 'Trim end' }),
  'split-trim': Object.freeze({ icon: '↔️', label: 'Split and trim' }),
});

function milliseconds(seconds) {
  return Math.round(Number(seconds) * 1000);
}

function compactScore(score) {
  return Number(score).toFixed(2).replace(/^0/, '');
}

function confidenceBar(score) {
  if (!Number.isFinite(score)) return '·';
  const value = Math.max(0, Math.min(1, Number(score)));
  return CONFIDENCE_BARS[
    Math.min(CONFIDENCE_BARS.length - 1, Math.floor(value * CONFIDENCE_BARS.length))
  ];
}

export function windowConfidenceBars(scores) {
  return scores.map(confidenceBar).join('');
}

export function windowConfidenceBarSegments(scores, targetIndex = null) {
  return scores.map((score, index) => ({
    index,
    bar: confidenceBar(score),
    target: index === targetIndex,
  }));
}

function reviewMetric(candidate) {
  if (candidate.reviewKind === 'low-confidence') return `C${compactScore(candidate.targetScore)}`;
  if (candidate.reviewKind === 'suspect') return `S${compactScore(candidate.suspicionScore)}`;
  if (candidate.reviewKind === 'kept') return 'Kept';
  return `Δ${compactScore(candidate.contrast)}`;
}

export function formatWindowReviewSummary(candidate) {
  return reviewMetric(candidate);
}

export function formatWindowReviewDetails(candidate) {
  return `${formatWindowReviewSummary(candidate)}   ${windowConfidenceBars(candidate.scores)}`;
}

export function formatWindowReviewLine(candidate) {
  const action = WINDOW_REVIEW_ACTIONS[candidate.action];
  return action
    ? `${action.icon} ${formatWindowReviewDetails(candidate)}`
    : formatWindowReviewDetails(candidate);
}

function annotationMatchesPoint(annotation, point) {
  return annotation
    && annotation.source !== 'note'
    && annotation.sampleId === point.originalRecording
    && annotation.label === point.label
    && milliseconds(annotation.startSec) === milliseconds(point.annotationStart)
    && milliseconds(annotation.endSec) === milliseconds(point.annotationEnd);
}

function annotationBoundsKey(sampleId, label, startSec, endSec) {
  return `${sampleId}\0${label}\0${milliseconds(startSec)}\0${milliseconds(endSec)}`;
}

function indexAnnotations(annotations) {
  const byId = new Map();
  const byBounds = new Map();
  for (const annotation of annotations) {
    if (annotation.source === 'note') continue;
    byId.set(annotation.id, annotation);
    const key = annotationBoundsKey(
      annotation.sampleId,
      annotation.label,
      annotation.startSec,
      annotation.endSec,
    );
    if (!byBounds.has(key)) byBounds.set(key, annotation);
  }
  return { byId, byBounds };
}

function sameReviewAnnotation(a, b) {
  return a.id === b.id
    && a.sampleId === b.sampleId
    && a.startSec === b.startSec
    && a.endSec === b.endSec
    && a.label === b.label
    && a.source === b.source
    && (a.windowReview ?? null) === (b.windowReview ?? null);
}

/**
 * Replace one sample's fragment snapshot only when review-relevant data has
 * actually changed. Returning the original array preserves Svelte's derived
 * cache when a sample is merely opened.
 */
export function mergeWindowReviewAnnotations(allAnnotations, sampleId, sampleAnnotations) {
  const nextForSample = sampleAnnotations.filter((annotation) => annotation.source !== 'note');
  const currentForSample = allAnnotations.filter((annotation) => annotation.sampleId === sampleId);
  const currentById = new Map(currentForSample.map((annotation) => [annotation.id, annotation]));
  const changed = currentForSample.length !== nextForSample.length
    || nextForSample.some((annotation) => {
      const current = currentById.get(annotation.id);
      return !current || !sameReviewAnnotation(current, annotation);
    });
  if (!changed) return allAnnotations;
  return [
    ...allAnnotations.filter((annotation) => annotation.sampleId !== sampleId),
    ...nextForSample,
  ];
}

/** Keep a focused row at its previous position until review focus moves. */
export function withLingeringWindowReviewCandidate(candidates, lingeringReview) {
  if (!lingeringReview) return candidates;
  const { candidate, index } = lingeringReview;
  const key = candidate.reviewKey ?? candidate.annotationId;
  if (candidates.some((item) => (item.reviewKey ?? item.annotationId) === key)) return candidates;
  const visible = candidates.slice();
  visible.splice(Math.max(0, Math.min(index, visible.length)), 0, candidate);
  return visible;
}

function findAnnotation(point, annotationsById, annotationsByBounds) {
  if (Number.isInteger(point.annotationId)) {
    const byId = annotationsById.get(point.annotationId);
    return annotationMatchesPoint(byId, point) ? byId : null;
  }
  return annotationsByBounds.get(annotationBoundsKey(
    point.originalRecording,
    point.label,
    point.annotationStart,
    point.annotationEnd,
  )) ?? null;
}

function expectedFragment(annotation) {
  return {
    sampleId: annotation.sampleId,
    label: annotation.label,
    startMs: milliseconds(annotation.startSec),
    endMs: milliseconds(annotation.endSec),
  };
}

function fragmentProposal(action, annotation, windows, targetIndex) {
  const expected = expectedFragment(annotation);
  const padding = Number.isFinite(windows[0].fragmentPadding) ? windows[0].fragmentPadding : 0.15;

  if (action === 'trim-start') {
    const startMs = milliseconds(windows[1].recordingStart + padding);
    if (startMs >= expected.endMs) return null;
    return { expected, proposal: { fragments: [{ startMs, endMs: expected.endMs }] } };
  }

  if (action === 'trim-end') {
    const last = windows.length - 1;
    const hop = windows[last].recordingStart - windows[last - 1].recordingStart;
    const endMs = milliseconds(annotation.endSec - hop);
    if (endMs <= expected.startMs) return null;
    return { expected, proposal: { fragments: [{ startMs: expected.startMs, endMs }] } };
  }

  const target = windows[targetIndex];
  const next = windows[targetIndex + 1];
  const hop = next.recordingStart - target.recordingStart;
  const leftEndMs = milliseconds(target.recordingStart + hop) - 1;
  const rightStartMs = milliseconds(next.recordingStart + padding);
  if (
    leftEndMs <= expected.startMs
    || rightStartMs >= expected.endMs
    || leftEndMs >= rightStartMs
  ) return null;
  return {
    expected,
    proposal: {
      fragments: [
        { startMs: expected.startMs, endMs: leftEndMs },
        { startMs: rightStartMs, endMs: expected.endMs },
      ],
    },
  };
}

function groupProjectionFragments(points) {
  const groups = new Map();
  for (const point of points) {
    if (
      !POSITIVE_LABELS.has(point.label)
      || !Number.isFinite(point.recordingStart)
      || !Number.isFinite(point.annotationStart)
      || !Number.isFinite(point.annotationEnd)
    ) continue;
    const list = groups.get(point.sourceFragment) ?? [];
    list.push(point);
    groups.set(point.sourceFragment, list);
  }

  return [...groups.values()].map((windows) => {
    windows.sort((a, b) => a.recordingStart - b.recordingStart);
    return {
      sourceFragment: windows[0].sourceFragment,
      windows,
      scores: windows.map((window) => window.classifierScore),
    };
  });
}

function contrastSuggestions(fragments, lowThreshold, highThreshold) {
  const suggestions = [];
  for (const fragment of fragments) {
    const { windows, scores } = fragment;
    if (windows.length < 2 || scores.some((score) => !Number.isFinite(score))) continue;
    const lowScore = Math.min(...scores);
    const highScore = Math.max(...scores);
    if (!(lowScore < lowThreshold && highScore > highThreshold)) continue;
    const targetIndex = scores.indexOf(lowScore);

    let action;
    if (targetIndex === 0) action = 'trim-start';
    else if (targetIndex === windows.length - 1) action = 'trim-end';
    else {
      const highBefore = Math.max(...scores.slice(0, targetIndex));
      const highAfter = Math.max(...scores.slice(targetIndex + 1));
      if (!(highBefore > highThreshold && highAfter > highThreshold)) continue;
      action = 'split-trim';
    }

    suggestions.push({
      ...fragment,
      reviewKind: 'contrast',
      action,
      targetIndex,
      targetWindow: windows[targetIndex],
      targetScore: lowScore,
      lowIndex: targetIndex,
      lowWindow: windows[targetIndex],
      lowScore,
      highScore,
      contrast: highScore - lowScore,
      suspicionRank: windows[targetIndex].suspicionRank,
    });
  }
  return suggestions.sort((a, b) =>
    b.contrast - a.contrast
    || (a.suspicionRank ?? Infinity) - (b.suspicionRank ?? Infinity)
  );
}

function lowConfidenceSuggestions(fragments, threshold) {
  const suggestions = [];
  for (const fragment of fragments) {
    fragment.windows.forEach((window, targetIndex) => {
      if (!Number.isFinite(window.classifierScore) || window.classifierScore >= threshold) return;
      suggestions.push({
        ...fragment,
        reviewKind: 'low-confidence',
        action: null,
        targetIndex,
        targetWindow: window,
        targetScore: window.classifierScore,
        suspicionRank: window.suspicionRank,
      });
    });
  }
  return suggestions.sort((a, b) =>
    a.targetScore - b.targetScore
    || (a.suspicionRank ?? Infinity) - (b.suspicionRank ?? Infinity)
  );
}

function suspectSuggestions(fragments, threshold) {
  const suggestions = [];
  for (const fragment of fragments) {
    fragment.windows.forEach((window, targetIndex) => {
      if (!Number.isFinite(window.suspicionScore) || window.suspicionScore < threshold) return;
      suggestions.push({
        ...fragment,
        reviewKind: 'suspect',
        action: null,
        targetIndex,
        targetWindow: window,
        targetScore: window.classifierScore,
        suspicionScore: window.suspicionScore,
        suspicionRank: window.suspicionRank,
      });
    });
  }
  return suggestions.sort((a, b) =>
    (a.suspicionRank ?? Infinity) - (b.suspicionRank ?? Infinity)
    || b.suspicionScore - a.suspicionScore
  );
}

function keptSuggestions(fragments) {
  return fragments.map((fragment) => ({
    ...fragment,
    reviewKind: 'kept',
    action: null,
    targetIndex: null,
    targetWindow: null,
  }));
}

/**
 * Score the immutable projection once, producing the four independent review
 * queues. Current database matching is intentionally a separate, cheap pass.
 */
export function deriveWindowReviewSuggestionQueues(
  points,
  {
    contrastLow = 0.2,
    contrastHigh = 0.8,
    lowConfidence = 0.5,
    suspect = 0.8,
  } = {},
) {
  const fragments = groupProjectionFragments(points);
  return {
    contrast: contrastSuggestions(fragments, contrastLow, contrastHigh),
    lowConfidence: lowConfidenceSuggestions(fragments, lowConfidence),
    suspect: suspectSuggestions(fragments, suspect),
    kept: keptSuggestions(fragments),
  };
}

function reviewWindowIdentity(suggestion) {
  const window = suggestion.targetWindow;
  if (!window) return '';
  return window.embeddingId ?? window.windowIndex ?? suggestion.targetIndex;
}

function matchSuggestions(suggestions, indexes, kept) {
  const candidates = [];
  for (const suggestion of suggestions) {
    const annotation = findAnnotation(suggestion.windows[0], indexes.byId, indexes.byBounds);
    if (!annotation || (annotation.windowReview === 'keep') !== kept) continue;

    const bounds = suggestion.action
      ? fragmentProposal(
        suggestion.action,
        annotation,
        suggestion.windows,
        suggestion.targetIndex,
      )
      : { expected: expectedFragment(annotation), proposal: null };
    if (!bounds) continue;

    const windowIdentity = reviewWindowIdentity(suggestion);
    candidates.push({
      ...suggestion,
      annotationId: annotation.id,
      sampleId: annotation.sampleId,
      label: annotation.label,
      reviewKey: windowIdentity === ''
        ? `${suggestion.reviewKind}:${annotation.id}`
        : `${suggestion.reviewKind}:${annotation.id}:${windowIdentity}`,
      ...bounds,
    });
  }
  return candidates;
}

/** Match all four pre-scored queues against the current DB snapshot in O(n). */
export function matchWindowReviewQueues(queues, annotations) {
  const indexes = indexAnnotations(annotations);
  return {
    contrast: matchSuggestions(queues.contrast, indexes, false),
    lowConfidence: matchSuggestions(queues.lowConfidence, indexes, false),
    suspect: matchSuggestions(queues.suspect, indexes, false),
    kept: matchSuggestions(queues.kept, indexes, true),
  };
}

/** Backwards-compatible contrast-only helpers used by focused unit tests. */
export function deriveWindowReviewSuggestions(
  points,
  { lowThreshold = 0.2, highThreshold = 0.8 } = {},
) {
  return deriveWindowReviewSuggestionQueues(points, {
    contrastLow: lowThreshold,
    contrastHigh: highThreshold,
  }).contrast;
}

export function matchWindowReviewCandidates(suggestions, annotations) {
  return matchWindowReviewQueues({
    contrast: suggestions,
    lowConfidence: [],
    suspect: [],
    kept: [],
  }, annotations).contrast;
}

export function deriveWindowReviewCandidates(points, annotations, options) {
  return matchWindowReviewCandidates(
    deriveWindowReviewSuggestions(points, options),
    annotations,
  );
}
