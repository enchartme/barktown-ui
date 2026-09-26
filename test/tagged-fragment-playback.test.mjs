import test from 'node:test';
import assert from 'node:assert/strict';

import {
  hitMetadataFragmentRanges,
  taggedFragmentRanges,
  taggedPlaybackStep,
  taggedRangeIndexAtOrAfter,
} from '../src/lib/tagged-fragment-playback.js';

test('tagged fragment playback excludes notes, clamps bounds, and merges overlaps', () => {
  const annotations = [
    { source: 'manual', startSec: 8, endSec: 12, label: 'bark' },
    { source: 'note', startSec: 2, endSec: 3, label: 'listen here' },
    { source: 'detector', startSec: 1, endSec: 4, label: 'bark' },
    { source: 'manual', startSec: 3.5, endSec: 6, label: 'yap' },
    { source: 'manual', startSec: 20, endSec: 21, label: 'wind' },
    { source: 'manual', startSec: 5, endSec: 5, label: 'empty' },
  ];

  assert.deepEqual(taggedFragmentRanges(annotations, { startSec: 2, endSec: 10 }), [
    { startSec: 2, endSec: 6 },
    { startSec: 8, endSec: 10 },
  ]);
});

test('tagged fragment playback accepts alternate API field names', () => {
  assert.deepEqual(taggedFragmentRanges([
    { type: 'manual', start_sec: 1.25, end_sec: 2.5 },
    { type: 'note', start_sec: 3, end_sec: 4 },
  ]), [{ startSec: 1.25, endSec: 2.5 }]);
});

test('report hit metadata becomes playable tagged windows inside the trim', () => {
  assert.deepEqual(hitMetadataFragmentRanges({
    windowS: 1.5,
    timestamps: [1.5, 10.75, 11.5, 20],
  }, { startSec: 10, endSec: 18 }), [
    { startSec: 10, endSec: 11.5 },
  ]);
  assert.deepEqual(hitMetadataFragmentRanges(null), []);
});

test('tagged range lookup finds the containing or next fragment', () => {
  const ranges = [
    { startSec: 1, endSec: 2 },
    { startSec: 5, endSec: 6 },
  ];

  assert.equal(taggedRangeIndexAtOrAfter(ranges, 0), 0);
  assert.equal(taggedRangeIndexAtOrAfter(ranges, 1.5), 0);
  assert.equal(taggedRangeIndexAtOrAfter(ranges, 2), 1);
  assert.equal(taggedRangeIndexAtOrAfter(ranges, 5.5), 1);
  assert.equal(taggedRangeIndexAtOrAfter(ranges, 6), -1);
});

test('tagged playback jumps gaps and finishes after the final fragment', () => {
  const ranges = [
    { startSec: 1, endSec: 2 },
    { startSec: 5, endSec: 6 },
  ];

  assert.deepEqual(taggedPlaybackStep(ranges, 1.5, 0), { type: 'keep', index: 0 });
  assert.deepEqual(taggedPlaybackStep(ranges, 1.995, 0), { type: 'seek', index: 1, time: 5 });
  assert.deepEqual(taggedPlaybackStep(ranges, 4, 0), { type: 'seek', index: 1, time: 5 });
  assert.deepEqual(taggedPlaybackStep(ranges, 6, 1), { type: 'finished', index: -1 });
});
