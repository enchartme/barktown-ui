import test from 'node:test';
import assert from 'node:assert/strict';
import {
  deriveWindowReviewCandidates,
  deriveWindowReviewSuggestionQueues,
  deriveWindowReviewSuggestions,
  formatWindowReviewLine,
  matchWindowReviewCandidates,
  matchWindowReviewQueues,
  mergeWindowReviewAnnotations,
  withLingeringWindowReviewCandidate,
  windowConfidenceBarSegments,
  windowConfidenceBars,
} from '../src/lib/training-window-review.js';

function point(overrides = {}) {
  return {
    sourceFragment: 'training_data/bark/sample-a_1000-2500.wav',
    originalRecording: 'sample-a',
    annotationId: 7,
    annotationStart: 1,
    annotationEnd: 2.5,
    fragmentPadding: 0.15,
    recordingStart: 0.85,
    recordingEnd: 1.81,
    embeddingId: 'window-0',
    windowIndex: 0,
    label: 'bark',
    classifierScore: 0.02,
    suspicionScore: 0.1,
    suspicionRank: 10,
    ...overrides,
  };
}

const annotation = {
  id: 7,
  sampleId: 'sample-a',
  startSec: 1,
  endSec: 2.5,
  label: 'bark',
  source: 'manual',
  windowReview: null,
};

test('formats the fixed-domain compact review row', () => {
  assert.equal(windowConfidenceBars([0.02, 0.99]), '▁█');
  assert.deepEqual(windowConfidenceBarSegments([0.02, 0.99], 1), [
    { index: 0, bar: '▁', target: false },
    { index: 1, bar: '█', target: true },
  ]);
  const [candidate] = deriveWindowReviewCandidates([
    point(),
    point({ recordingStart: 1.33, embeddingId: 'window-1', windowIndex: 1, classifierScore: 0.99 }),
  ], [annotation]);
  assert.equal(formatWindowReviewLine(candidate), '➡️ Δ.97 · 002: ▁█');
});

test('suggests boundary trims and calculates optimistic replacement bounds', () => {
  const start = deriveWindowReviewCandidates([
    point(),
    point({ recordingStart: 1.33, classifierScore: 0.99 }),
  ], [annotation])[0];
  assert.equal(start.action, 'trim-start');
  assert.deepEqual(start.proposal.fragments, [{ startMs: 1480, endMs: 2500 }]);

  const end = deriveWindowReviewCandidates([
    point({ classifierScore: 0.99 }),
    point({ recordingStart: 1.33, classifierScore: 0.02 }),
  ], [annotation])[0];
  assert.equal(end.action, 'trim-end');
  assert.deepEqual(end.proposal.fragments, [{ startMs: 1000, endMs: 2020 }]);
});

test('suggests split-trim only when an interior low window is bracketed by highs', () => {
  const windows = [
    point({ classifierScore: 0.95 }),
    point({ recordingStart: 1.33, classifierScore: 0.03 }),
    point({ recordingStart: 1.81, classifierScore: 0.9 }),
  ];
  const [candidate] = deriveWindowReviewCandidates(windows, [annotation]);
  assert.equal(candidate.action, 'split-trim');
  assert.deepEqual(candidate.proposal.fragments, [
    { startMs: 1000, endMs: 1809 },
    { startMs: 1960, endMs: 2500 },
  ]);

  windows[2] = point({ recordingStart: 1.81, classifierScore: 0.6 });
  assert.deepEqual(deriveWindowReviewCandidates(windows, [annotation]), []);
});

test('ignores stale and persistently kept annotations', () => {
  const points = [point(), point({ recordingStart: 1.33, classifierScore: 0.99 })];
  assert.deepEqual(
    deriveWindowReviewCandidates(points, [{ ...annotation, endSec: 2.4 }]),
    [],
  );
  assert.deepEqual(
    deriveWindowReviewCandidates(points, [{ ...annotation, windowReview: 'keep' }]),
    [],
  );
});

test('pre-scores projection rows once and indexes legacy bounds matching', () => {
  const points = [
    point({ annotationId: null }),
    point({ annotationId: null, recordingStart: 1.33, classifierScore: 0.99 }),
  ];
  const suggestions = deriveWindowReviewSuggestions(points);
  assert.equal(suggestions.length, 1);

  // Legacy projections have no annotation_id. Matching still uses the exact
  // sample/label/millisecond bounds without scanning the array per fragment.
  const legacyAnnotations = [annotation];
  legacyAnnotations.find = () => {
    throw new Error('legacy matching must use the bounds index');
  };
  const [candidate] = matchWindowReviewCandidates(suggestions, legacyAnnotations);
  assert.equal(candidate.annotationId, annotation.id);
  assert.equal(candidate.action, 'trim-start');
});

test('opening an unchanged sample preserves the review snapshot identity', () => {
  const bulkSnapshot = [{ ...annotation, sampleDurationSec: 30 }];
  const sampleSnapshot = [{ ...annotation }];
  assert.strictEqual(
    mergeWindowReviewAnnotations(bulkSnapshot, annotation.sampleId, sampleSnapshot),
    bulkSnapshot,
  );

  const moved = [{ ...annotation, startSec: 1.1 }];
  const merged = mergeWindowReviewAnnotations(bulkSnapshot, annotation.sampleId, moved);
  assert.notStrictEqual(merged, bulkSnapshot);
  assert.equal(merged[0].startSec, 1.1);
});

test('an applied candidate lingers at its old position without duplication', () => {
  const before = [{ annotationId: 1, reviewKey: 'low:1:0' }, { annotationId: 3, reviewKey: 'low:3:0' }];
  const applied = { annotationId: 2, reviewKey: 'low:2:0' };
  assert.deepEqual(
    withLingeringWindowReviewCandidate(before, { candidate: applied, index: 1 }),
    [before[0], applied, before[1]],
  );

  const stillPresent = [before[0], applied, before[1]];
  assert.strictEqual(
    withLingeringWindowReviewCandidate(stillPresent, { candidate: applied, index: 1 }),
    stillPresent,
  );

  const otherWindow = { annotationId: 2, reviewKey: 'low:2:1' };
  assert.deepEqual(
    withLingeringWindowReviewCandidate([otherWindow], { candidate: applied, index: 0 }),
    [applied, otherWindow],
  );
});

test('builds independent window queues and highlights each target window', () => {
  const points = [
    point({ embeddingId: 'window-0', windowIndex: 0, classifierScore: 0.1, suspicionScore: 0.2, suspicionRank: 30 }),
    point({ embeddingId: 'window-1', windowIndex: 1, recordingStart: 1.33, classifierScore: 0.7, suspicionScore: 0.95, suspicionRank: 1 }),
    point({ embeddingId: 'window-2', windowIndex: 2, recordingStart: 1.81, classifierScore: 0.9, suspicionScore: 0.85, suspicionRank: 2 }),
  ];
  const suggestions = deriveWindowReviewSuggestionQueues(points);
  assert.equal(suggestions.contrast.length, 1);
  assert.deepEqual(suggestions.lowConfidence.map(item => item.targetIndex), [0]);
  assert.deepEqual(suggestions.suspect.map(item => item.targetIndex), [1, 2]);

  const queues = matchWindowReviewQueues(suggestions, [annotation]);
  assert.equal(queues.contrast.length, 1);
  assert.equal(queues.lowConfidence[0].reviewKey, 'low-confidence:7:window-0');
  assert.deepEqual(
    queues.suspect.map(item => item.reviewKey),
    ['suspect:7:window-1', 'suspect:7:window-2'],
  );
  assert.deepEqual(queues.kept, []);
});

test('kept fragments are hidden from review queues and shown once in Kept', () => {
  const points = [
    point({ embeddingId: 'window-0', windowIndex: 0, classifierScore: 0.05, suspicionScore: 0.95 }),
    point({ embeddingId: 'window-1', windowIndex: 1, recordingStart: 1.33, classifierScore: 0.95, suspicionScore: 0.9 }),
  ];
  const queues = matchWindowReviewQueues(
    deriveWindowReviewSuggestionQueues(points),
    [{ ...annotation, windowReview: 'keep' }],
  );
  assert.deepEqual(queues.contrast, []);
  assert.deepEqual(queues.lowConfidence, []);
  assert.deepEqual(queues.suspect, []);
  assert.equal(queues.kept.length, 1);
  assert.equal(queues.kept[0].reviewKey, 'kept:7');
  assert.equal(formatWindowReviewLine(queues.kept[0]), 'Kept · 002: ▁█');
});
