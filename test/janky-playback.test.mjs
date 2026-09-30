import test from 'node:test';
import assert from 'node:assert/strict';

import {
  jankyPlaybackProfile,
  jankyPlaybackStep,
  normalizeJankyLevel,
  normalizeJankyUnitSec,
} from '../src/lib/janky-playback.js';

test('janky playback profiles remove 0.05 seconds per slider step', () => {
  assert.deepEqual(jankyPlaybackProfile(0), { level: 0, unitSec: 0.5, playSec: 0.5, skipSec: 0 });
  assert.deepEqual(jankyPlaybackProfile(1), { level: 1, unitSec: 0.5, playSec: 0.45, skipSec: 0.05 });
  assert.deepEqual(jankyPlaybackProfile(2), { level: 2, unitSec: 0.5, playSec: 0.4, skipSec: 0.1 });
  assert.deepEqual(jankyPlaybackProfile(9), { level: 9, unitSec: 0.5, playSec: 0.05, skipSec: 0.45 });
});

test('one-second units keep the same audible slice and extend the skipped tail', () => {
  assert.deepEqual(jankyPlaybackProfile(0, 1), { level: 0, unitSec: 1, playSec: 1, skipSec: 0 });
  assert.deepEqual(jankyPlaybackProfile(1, 1), { level: 1, unitSec: 1, playSec: 0.45, skipSec: 0.55 });
  assert.deepEqual(jankyPlaybackProfile(9, 1), { level: 9, unitSec: 1, playSec: 0.05, skipSec: 0.95 });
});

test('janky levels are rounded and clamped to the slider range', () => {
  assert.equal(normalizeJankyLevel(-3), 0);
  assert.equal(normalizeJankyLevel(2.6), 3);
  assert.equal(normalizeJankyLevel(12), 9);
  assert.equal(normalizeJankyLevel('not a number'), 0);
  assert.equal(normalizeJankyUnitSec(0.5), 0.5);
  assert.equal(normalizeJankyUnitSec('1'), 1);
  assert.equal(normalizeJankyUnitSec(2), 0.5);
});

test('smooth playback never seeks', () => {
  assert.deepEqual(jankyPlaybackStep(0.499, 0), { type: 'keep' });
  assert.deepEqual(jankyPlaybackStep(12.345, 0), { type: 'keep' });
});

test('janky playback seeks over the tail of every half-second unit', () => {
  assert.deepEqual(jankyPlaybackStep(0.449, 1), { type: 'keep' });
  assert.deepEqual(jankyPlaybackStep(0.45, 1), { type: 'seek', time: 0.5 });
  assert.deepEqual(jankyPlaybackStep(0.949, 1), { type: 'keep' });
  assert.deepEqual(jankyPlaybackStep(0.95, 1), { type: 'seek', time: 1 });

  assert.deepEqual(jankyPlaybackStep(3.049, 9), { type: 'keep' });
  assert.deepEqual(jankyPlaybackStep(3.05, 9), { type: 'seek', time: 3.5 });
});

test('janky playback can use one-second units', () => {
  assert.deepEqual(jankyPlaybackStep(0.449, 1, 1), { type: 'keep' });
  assert.deepEqual(jankyPlaybackStep(0.45, 1, 1), { type: 'seek', time: 1 });
  assert.deepEqual(jankyPlaybackStep(1.049, 9, 1), { type: 'keep' });
  assert.deepEqual(jankyPlaybackStep(1.05, 9, 1), { type: 'seek', time: 2 });
});
