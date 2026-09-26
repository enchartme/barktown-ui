import { test } from 'node:test';
import assert from 'node:assert/strict';

import { fragmentSelectionAfterDelete } from '../src/lib/training-fragment-selection.js';

const annotations = [
  { id: 3, source: 'manual', startSec: 30 },
  { id: 99, source: 'note', startSec: 15 },
  { id: 1, source: 'manual', startSec: 10 },
  { id: 2, source: 'detector', startSec: 20 },
];

test('deleting a fragment selects the next fragment in timeline order', () => {
  assert.equal(fragmentSelectionAfterDelete(annotations, 1), 2);
  assert.equal(fragmentSelectionAfterDelete(annotations, 2), 3);
});

test('deleting the last fragment falls back to the previous fragment', () => {
  assert.equal(fragmentSelectionAfterDelete(annotations, 3), 2);
});

test('deleting the only fragment clears selection', () => {
  assert.equal(
    fragmentSelectionAfterDelete([{ id: 1, source: 'manual', startSec: 10 }], 1),
    null,
  );
});

test('notes and unknown ids are not fragment-selection candidates', () => {
  assert.equal(fragmentSelectionAfterDelete(annotations, 99), null);
  assert.equal(fragmentSelectionAfterDelete(annotations, 404), null);
});
