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

test('aggregate scores use the strongest positive and strongest of every negative class', async () => {
  const { aggregateHitScores, NEGATIVE_LABELS } = await import('../src/lib/hit-filters.js');
  assert.deepEqual(aggregateHitScores({ bark: .25, yap: .75, homestead: .5, traffic: .25 }), {
    positive: .75, negative: .5, delta: .25,
  });
  for (const label of NEGATIVE_LABELS) {
    assert.equal(aggregateHitScores({ bark: .25, yap: .5, [label]: .75 }).negative, .75);
  }
  assert.deepEqual(aggregateHitScores(null), { positive: null, negative: null, delta: null });
  assert.deepEqual(aggregateHitScores({ yap: 0 }), { positive: 0, negative: null, delta: null });
});

test('positive and negative min/max ranges combine with individual label ranges', async () => {
  const { hitPassesFilters } = await import('../src/lib/hit-filters.js');
  const scores = { bark: .25, yap: .75, wildlife: .5, homestead: .25 };
  assert.equal(hitPassesFilters(scores, { filter_positive_min: .75, filter_positive_max: .75, filter_negative_min: .5, filter_negative_max: .5 }), true);
  for (const settings of [{ filter_positive_min: .8 }, { filter_positive_max: .7 }, { filter_negative_min: .6 }, { filter_negative_max: .4 }, { filter_yap_max: .7 }]) {
    assert.equal(hitPassesFilters(scores, settings), false);
  }
});

test('delta supports negative differences, inclusive boundaries and unavailable groups', async () => {
  const { hitPassesFilters } = await import('../src/lib/hit-filters.js');
  assert.equal(DEFAULT_HIT_FILTERS.filter_delta_min, -1);
  assert.equal(DEFAULT_HIT_FILTERS.filter_delta_max, 1);
  assert.equal(hitPassesFilters({ bark: 0, wind: 1 }), true);
  assert.equal(hitPassesFilters({ bark: 1, wind: 0 }), true);
  assert.equal(hitPassesFilters({ bark: .8, wind: .2 }, { filter_delta_max: .6 }), true);
  assert.equal(hitPassesFilters({ bark: .25, wind: .75 }, { filter_delta_min: -.5 }), true);
  assert.equal(hitPassesFilters({ bark: .25, wind: .75 }, { filter_delta_min: -.4 }), false);
  assert.equal(hitPassesFilters({ yap: .75, traffic: .25 }, { filter_delta_max: .5 }), true);
  assert.equal(hitPassesFilters({ yap: .75, traffic: .25 }, { filter_delta_max: .4 }), false);
  assert.equal(hitPassesFilters({ bark: .9 }, { filter_negative_min: 1, filter_delta_min: 0, filter_delta_max: 0 }), true);
});

test('aggregate filtering drives public visibility, operator flags and bark counts together', async () => {
  const { markFilteredHits } = await import('../src/lib/hit-filters.js');
  const aggregateFilters = { ...DEFAULT_HIT_FILTERS, filter_negative_max: .5, filter_delta_max: .55 };
  assert.deepEqual(filterHitMetadata(metadata, aggregateFilters).timestamps, [5, 7]);
  assert.deepEqual(markFilteredHits(metadata, aggregateFilters).filteredHits, [true, true, false, false]);
  assert.equal(hiddenHitCount({ durationSec: 10 }, metadata, aggregateFilters), 2);
});

test('both delta controls span -1 to 1 and support wholly positive or negative intervals', async () => {
  const { FILTER_DEFINITIONS, hitPassesFilters } = await import('../src/lib/hit-filters.js');
  assert.deepEqual(FILTER_DEFINITIONS.find(filter => filter.name === 'delta').ranges, { min: [-1, 1], max: [-1, 1] });
  assert.equal(hitPassesFilters({ bark: .75, wind: .25 }, { filter_delta_min: .25, filter_delta_max: .75 }), true);
  assert.equal(hitPassesFilters({ bark: .25, wind: .75 }, { filter_delta_min: .25, filter_delta_max: .75 }), false);
  assert.equal(hitPassesFilters({ bark: .25, wind: .75 }, { filter_delta_min: -.75, filter_delta_max: -.25 }), true);
  assert.equal(hitPassesFilters({ bark: .75, wind: .25 }, { filter_delta_min: -.75, filter_delta_max: -.25 }), false);
});
