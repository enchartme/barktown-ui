import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_HIT_FILTERS, filterHitMetadata, hiddenHitCount } from '../src/lib/hit-filters.js';

const metadata = {
  timestamps: [1, 3, 5, 7], confidences: [.9, .95, .99, .91], loudnesses: [1, 2, 3, 4],
  multilabelScores: [{ bark: .8, homestead: .2 }, { bark: .9, homestead: .7 }, { bark: .6, homestead: .1 }, null],
};
const filters = { ...DEFAULT_HIT_FILTERS, filter_bark_min: .8, filter_homestead_max: .2 };

test('default filters preserve every hit including zero and one scores', () => {
  assert.equal(filterHitMetadata(metadata), metadata);
  const edge = { timestamps: [1], multilabelScores: [{ bark: 0, homestead: 1 }] };
  assert.equal(filterHitMetadata(edge), edge);
});

test('bounds are inclusive, combine labels, and preserve alignment without mutation', () => {
  const filtered = filterHitMetadata(metadata, filters);
  assert.deepEqual(filtered.timestamps, [1, 7]);
  assert.deepEqual(filtered.confidences, [.9, .91]);
  assert.deepEqual(filtered.loudnesses, [1, 4]);
  assert.deepEqual(filtered.multilabelScores, [metadata.multilabelScores[0], null]);
  assert.deepEqual(metadata.timestamps, [1, 3, 5, 7]);
  assert.equal(filterHitMetadata(metadata), metadata);
});

test('legacy and partial diagnostics pass when the score is unavailable', () => {
  for (const multilabelScores of [null, undefined, [{ yap: .9 }]]) {
    const legacy = { timestamps: [1], multilabelScores };
    assert.equal(filterHitMetadata(legacy, filters), legacy);
  }
  assert.equal(filterHitMetadata(null, filters), null);
});

test('hidden counts only subtract windows inside the persisted trim', () => {
  assert.equal(hiddenHitCount({ durationSec: 10, trimStartMs: 2500, trimStopMs: 5000 }, metadata, filters), 1);
  assert.equal(hiddenHitCount({ durationSec: 10 }, metadata, filters), 2);
  assert.equal(hiddenHitCount({ durationSec: 10 }, null, filters), 0);
});

test('saved filter state reacts across display metadata while retaining raw detections', async () => {
  const { get } = await import('svelte/store');
  const { hitMetadataById } = await import('../src/lib/hit-metadata.js');
  const { hitFilters, filteredHitMetadataById } = await import('../src/lib/settings.js');
  hitMetadataById.set(new Map([['clip', metadata]]));
  hitFilters.set(filters);
  assert.deepEqual(get(filteredHitMetadataById).get('clip').timestamps, [1, 7]);
  assert.equal(get(hitMetadataById).get('clip'), metadata);
  hitFilters.set({ ...DEFAULT_HIT_FILTERS });
  assert.equal(get(filteredHitMetadataById).get('clip'), metadata);
});

test('operator metadata retains windows and filtering flags stay aligned after trimming', async () => {
  const { markFilteredHits } = await import('../src/lib/hit-filters.js');
  const { trimHitMetadata } = await import('../src/lib/diary-trim.js');
  const marked = markFilteredHits(metadata, filters);
  assert.deepEqual(marked.filteredHits, [false, true, true, false]);
  assert.equal(marked.timestamps, metadata.timestamps);
  assert.equal(metadata.filteredHits, undefined);
  const trimmed = trimHitMetadata(marked, { durationSec: 10, trimStartMs: 2500, trimStopMs: 7000 });
  assert.deepEqual(trimmed.timestamps, [.5, 2.5]);
  assert.deepEqual(trimmed.filteredHits, [true, true]);
});

test('waveform stats annotate filtered counts without counting them as barks', async () => {
  const { formatAudioPanelStats } = await import('../src/lib/hit-metadata.js');
  const retained = filterHitMetadata(metadata, filters);
  assert.match(formatAudioPanelStats(retained, 10, 2), /^Barks: 2 \(2 filtered\), Density: 12 bpm/);
  assert.match(formatAudioPanelStats(retained, 10), /^Barks: 2, Density:/);
});

test('barcode paints rejected windows grey first, preserving accepted overlapping columns', async () => {
  const { barcodePresentationLines, filteredHitColor } = await import('../src/lib/report-barcode.js');
  const lines = barcodePresentationLines({
    timestamps: [1, 1.2, 3], loudnesses: [4, 1, 2], filteredHits: [true, false, true],
  }, 10);
  assert.deepEqual(lines, [
    { x: 0, loudness: 4, filtered: true },
    { x: 2, loudness: 2, filtered: true },
    { x: 0, loudness: 1, filtered: false },
  ]);
  assert.equal(filteredHitColor(1), 'rgb(185, 185, 185)');
  assert.equal(filteredHitColor(4), 'rgb(95, 95, 95)');
});
