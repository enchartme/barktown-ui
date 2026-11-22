import test from 'node:test';
import assert from 'node:assert/strict';

import { diaryTrimBounds, trimHitMetadata } from '../src/lib/diary-trim.js';

test('diary trim bounds use milliseconds and fall back safely for legacy values', () => {
  assert.deepEqual(diaryTrimBounds({ durationSec: 10, trimStartMs: 1250, trimStopMs: 8750 }), {
    sourceDurationMs: 10000,
    startMs: 1250,
    stopMs: 8750,
    startSec: 1.25,
    stopSec: 8.75,
    durationMs: 7500,
    durationSec: 7.5,
    isTrimmed: true,
  });
  assert.equal(diaryTrimBounds({ durationSec: 10, trimStartMs: 9000, trimStopMs: 8000 }).durationSec, 10);
  assert.equal(diaryTrimBounds({ durationSec: 10 }).isTrimmed, false);
});

test('trimmed hit metadata is filtered and rebased without modifying the source arrays', () => {
  const metadata = {
    timestamps: [1, 3, 5, 8],
    confidences: [0.9, 0.91, 0.92, 0.93],
    loudnesses: [1, 2, 3, 4],
    multilabelScores: [{ bark: 0.1 }, { yap: 0.8 }, { wrongdog: 0.9 }, { wildlife: 0.7 }],
    windowS: 1.5,
  };
  const trimmed = trimHitMetadata(metadata, {
    durationSec: 10,
    trimStartMs: 2500,
    trimStopMs: 8000,
  });

  assert.deepEqual(trimmed.timestamps, [0.5, 2.5]);
  assert.deepEqual(trimmed.confidences, [0.91, 0.92]);
  assert.deepEqual(trimmed.loudnesses, [2, 3]);
  assert.deepEqual(trimmed.multilabelScores, [{ yap: 0.8 }, { wrongdog: 0.9 }]);
  assert.equal(metadata.multilabelScores.length, 4);
  assert.deepEqual(metadata.timestamps, [1, 3, 5, 8]);
});
