import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  FRAGMENT_LABELS,
  SAMPLE_LABELS,
  filterTrainingSamples,
  fragmentRelabelTargets,
  sampleLabelColor,
  sampleMoveForShortcut,
  trainingLabelActionForShortcut,
} from '../src/lib/sample-labels.js';

test('review is a yellow fragment-only label', () => {
  assert.ok(FRAGMENT_LABELS.includes('review'));
  assert.ok(!SAMPLE_LABELS.includes('review'));
  assert.equal(sampleLabelColor('review'), '#f1c40f');
});

test('sample label shortcuts preserve or remove the diary entry with Shift', () => {
  assert.deepEqual(sampleMoveForShortcut('b'), { label: 'bark', keepInDiary: true });
  assert.deepEqual(sampleMoveForShortcut('B', true), { label: 'bark', keepInDiary: false });
  assert.deepEqual(sampleMoveForShortcut('r'), { label: 'wrongdog', keepInDiary: true });
  assert.equal(sampleMoveForShortcut('v'), null, 'review is not a whole-sample label');
  assert.equal(sampleMoveForShortcut('q'), null);
});

test('training label shortcuts use Shift for a sample-wide relabel', () => {
  assert.deepEqual(trainingLabelActionForShortcut('b'), { label: 'bark', scope: 'fragment' });
  assert.deepEqual(trainingLabelActionForShortcut('B', true), { label: 'bark', scope: 'sample' });
  assert.deepEqual(trainingLabelActionForShortcut('v'), { label: 'review', scope: 'fragment' });
  assert.equal(
    trainingLabelActionForShortcut('V', true),
    null,
    'review remains fragment-only and cannot become the sample label',
  );
  assert.equal(trainingLabelActionForShortcut('q', true), null);
});

test('whole-sample relabel targets every fragment that needs changing but never notes', () => {
  const annotations = [
    { id: 1, source: 'manual', label: 'bark' },
    { id: 2, source: 'detector', label: 'wind' },
    { id: 3, source: 'note', label: 'keep this note' },
  ];

  assert.deepEqual(fragmentRelabelTargets(annotations, 'wind'), [annotations[0]]);
});

test('training review filter selects samples containing review fragments', () => {
  const samples = [
    { id: 'a', label: 'bark' },
    { id: 'b', label: 'background' },
    { id: 'c', label: 'bark' },
  ];
  const fragments = new Map([
    ['a', [{ label: 'bark' }, { label: 'review' }]],
    ['b', [{ label: 'bark' }]],
    ['c', []],
  ]);

  assert.deepEqual(filterTrainingSamples(samples, 'review', fragments), [samples[0]]);
  assert.deepEqual(filterTrainingSamples(samples, 'unmarked', fragments), [samples[2]]);
  assert.deepEqual(filterTrainingSamples(samples, 'bark', fragments), [samples[0], samples[2]]);
});
