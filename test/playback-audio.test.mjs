import { test } from 'node:test';
import assert from 'node:assert/strict';
import { playbackGainCurve, createPlaybackAudio } from '../src/lib/playback-audio.js';

const wave = peaks => ({ maxs: peaks, mins: peaks.map(peak => -peak), norm: 1 });

test('amplification is uniform throughout the clip, bounded, and off means unity', () => {
  const peaks = [0, .01, .05, .1, .2];
  assert.deepEqual([...playbackGainCurve(wave(peaks))], peaks.map(() => 4.5));
  assert.deepEqual([...playbackGainCurve(wave([.01, .05]))], [8, 8]);
  assert.deepEqual([...playbackGainCurve(wave([.01, 1]))], [1, 1]);
  assert.deepEqual([...playbackGainCurve(wave(peaks), { amplify: false })], peaks.map(() => 1));
});

test('uniform gain uses only the visible clip when the recording has been trimmed', () => {
  const data = wave([1, .1, .2, 1]);
  assert.deepEqual([...playbackGainCurve(data)], [1, 1, 1, 1]);
  assert.deepEqual([...playbackGainCurve(data, { startFraction: .25, endFraction: .75 })], [4.5, 4.5, 4.5, 4.5]);
});

test('silent clips and the noise floor are not amplified; both waveform polarities count', () => {
  assert.deepEqual([...playbackGainCurve(wave([0, .001]))], [1, 1]);
  const gains = playbackGainCurve({ maxs: [.01, .1], mins: [-.5, -.1], norm: 1 });
  assert.ok(Math.abs(gains[0] - 1.8) < 1e-6);
  assert.equal(gains[0], gains[1]);
  assert.equal(playbackGainCurve(null), null);
  assert.equal(playbackGainCurve({ maxs: [1], norm: 0 }), null);
});

test('suppression stays independent of uniform amplification and respects the raw cutoff', () => {
  const data = wave([.1, .2, .25]);
  const options = { suppressAmount: .5, suppressCutoff: .15 };
  const plain = playbackGainCurve(data, { ...options, amplify: false });
  const amplified = playbackGainCurve(data, { ...options, amplify: true });
  assert.equal(plain[0], 1);
  assert.ok(plain[1] < 1);
  for (let i = 0; i < plain.length; i++) assert.ok(Math.abs(amplified[i] / plain[i] - 3.6) < 1e-6);
});

test('Web Audio applies gain above unity, smooths changes, bypasses protection when amplification is off, and closes', async () => {
  const nodes = [];
  const param = () => ({ value: 0, calls: [], cancelScheduledValues(time) { this.calls.push(['cancel', time]); }, setTargetAtTime(...args) { this.calls.push(['target', ...args]); } });
  const node = kind => {
    const result = { kind, outputs: [], connect(other) { this.outputs.push(other); }, disconnect() { this.outputs = []; } };
    nodes.push(result);
    return result;
  };
  let context;
  class Context {
    constructor() { context = this; this.currentTime = 2; this.destination = { kind: 'output' }; }
    createGain() { return Object.assign(node('gain'), { gain: param() }); }
    createWaveShaper() { return node('limiter'); }
    createMediaElementSource(element) { this.element = element; return node('source'); }
    async resume() { this.resumed = true; }
    async close() { this.closed = true; }
  }
  const element = {};
  const audio = createPlaybackAudio(element, Context);
  await audio.resume();
  assert.equal(context.element, element);
  assert.equal(context.resumed, true);
  const gain = nodes.find(node => node.kind === 'gain');
  const limiter = nodes.find(node => node.kind === 'limiter');
  audio.update(5, true);
  assert.deepEqual(gain.outputs, [limiter]);
  assert.deepEqual(gain.gain.calls.at(-1), ['target', 5, 2, .025]);
  const calls = gain.gain.calls.length;
  audio.update(5, true);
  assert.equal(gain.gain.calls.length, calls);
  audio.update(1, false);
  assert.deepEqual(gain.outputs, [context.destination]);
  assert.ok(limiter.curve.every(value => Math.abs(value) <= .981));
  audio.dispose();
  assert.equal(context.closed, true);
  assert.ok(nodes.every(node => node.outputs.length === 0));
});
