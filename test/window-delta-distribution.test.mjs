import { test } from 'node:test';
import assert from 'node:assert/strict';
import { windowDeltaDistribution } from '../src/lib/window-delta-distribution.js';
import { markFilteredHits } from '../src/lib/hit-filters.js';
import { trimHitMetadata } from '../src/lib/diary-trim.js';

const metadata = scores => ({ timestamps: scores.map((_, i) => i + 1), multilabelScores: scores });

test('histogram bundles negatives before ten fixed 0..1 bins and includes both endpoints', () => {
  const result = windowDeltaDistribution(metadata([
    { bark: 0, wind: 1 }, { bark: .5, wind: .5 }, { yap: 1, traffic: 0 },
  ]));
  assert.equal(result.bins.length, 11);
  assert.equal(result.bins[0], 1);
  assert.equal(result.bins[1], 1);
  assert.equal(result.bins[10], 1);
  assert.equal(result.count, 3);
  assert.equal(result.mean, 0);
  assert.ok(Math.abs(result.standardDeviation - Math.sqrt(2 / 3)) < 1e-12);
});

test('population sigma is zero for single or identical deltas', () => {
  for (const scores of [[{ bark: .75, wind: .25 }], [{ bark: .75, wind: .25 }, { yap: .75, homestead: .25 }]]) {
    const result = windowDeltaDistribution(metadata(scores));
    assert.equal(result.standardDeviation, 0);
    assert.equal(result.mean, 0.5);
    assert.equal(result.bins[6], scores.length);
  }
});

test('missing diagnostics are excluded rather than counted as zero delta', () => {
  for (const input of [null, { timestamps: [] }, { timestamps: [1, 2] }, metadata([null, { bark: .5 }, { wind: .5 }])]) {
    const result = windowDeltaDistribution(input);
    assert.equal(result.count, 0);
    assert.equal(result.standardDeviation, null);
    assert.equal(result.mean, null);
    assert.ok(result.bins.every(value => value === 0));
  }
  const result = windowDeltaDistribution(metadata([{ bark: .75, yap: .25, wind: .5, traffic: .25 }, { bark: .25 }]));
  assert.equal(result.count, 1);
  assert.equal(result.bins[3], 1);
});

test('bin heights show relative frequencies and zero has a real bin', () => {
  const result = windowDeltaDistribution(metadata([
    { bark: .5, wind: .5 }, { bark: .5, wind: .5 }, { bark: 1, wind: 0 },
  ]));
  const heights = result.chart.slice(3, -1).split(',').map(Number);
  assert.equal(heights[1], 100);
  assert.equal(heights[10], 50);
  assert.equal(result.bins.reduce((sum, n) => sum + n, 0), 3);
});

test('record metrics include filtered windows within the trim without changing original metadata', () => {
  const raw = metadata([
    { bark: .9, wind: .1 }, { bark: .75, wind: .25 }, { bark: .25, wind: .75 }, { bark: .5, wind: .5 },
  ]);
  const marked = markFilteredHits(raw, { filter_bark_min: .5 });
  const visible = trimHitMetadata(marked, { durationSec: 5, trimStartMs: 2000, trimStopMs: 5000 });
  const result = windowDeltaDistribution(visible);
  assert.equal(result.count, 3);
  assert.ok(Math.abs(result.standardDeviation - Math.sqrt(1 / 6)) < 1e-12);
  assert.deepEqual(result.bins, windowDeltaDistribution(trimHitMetadata(raw, { durationSec: 5, trimStartMs: 2000, trimStopMs: 5000 })).bins);
  assert.equal(raw.timestamps.length, 4);
  assert.equal(raw.multilabelScores.length, 4);
});

test('all negative deltas share a bar; nonnegative bins retain their fixed 0.1 boundaries', () => {
  const result = windowDeltaDistribution(metadata([
    { bark: 0, wind: 1 }, { bark: 0, wind: .5 }, { bark: 0, wind: .001 },
    ...Array.from({ length: 11 }, (_, i) => ({ bark: i / 10, wind: 0 })),
  ]));
  assert.deepEqual(result.bins, [3, 1, 1, 1, 1, 1, 1, 1, 1, 1, 2]);
  assert.equal(result.count, 14);
  assert.match(result.title, /< 0: 3/);
  assert.match(result.title, /0.9 to 1.0: 2/);
});
