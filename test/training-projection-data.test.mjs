import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { deriveWindowReviewCandidates } from '../src/lib/training-window-review.js';

// Load the module without SvelteKit's build-time $lib alias.
const source = (await readFile(new URL('../src/lib/training-projection-data.js', import.meta.url), 'utf8'))
  .replace("import { ASSET_BASE } from '$lib/utils.js';", "const ASSET_BASE = 'https://assets.example';");
let moduleId = 0;
async function load(csv) {
  const module = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}#${moduleId++}`);
  const previous = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, text: async () => csv });
  try {
    return await module.loadTrainingProjectionPoints();
  } finally {
    globalThis.fetch = previous;
  }
}

test('compact UMAP CSV preserves exact annotation matching and trim alignment', async () => {
  const points = await load([
    'embedding_id,original_recording_audio,window_duration_s,annotation_id,fragment_padding_s,label,classifier_score,umap_x,umap_y',
    'bark/sample_15488-18261:0000,"samples/original, audio.wav",0.96,123456,0.15,bark,0.1,-3.06,7.25',
    'bark/sample_15488-18261:0001,"samples/original, audio.wav",0.96,123456,0.15,bark,0.99,-2.06,8.25',
  ].join('\n'));
  assert.equal(points[0].originalRecording, 'sample');
  assert.equal(points[0].sourceFragment, 'bark/sample_15488-18261.wav');
  assert.equal(points[0].originalAudio, 'samples/original, audio.wav');
  assert.equal(points[0].annotationStart, 15.488);
  assert.equal(points[0].annotationEnd, 18.261);
  assert.equal(points[0].annotationId, 123456);
  assert.equal(points[1].windowIndex, 1);
  assert.equal(points[1].windowDuration, 0.96);
  assert.equal(points[1].recordingStart, 15.818);
  assert.equal('pcaX' in points[0], false);
  const candidates = deriveWindowReviewCandidates(points, [{
    id: 123456, sampleId: 'sample', label: 'bark', startSec: 15.488, endSec: 18.261,
  }]);
  assert.equal(candidates.length, 1);
  assert.deepEqual(candidates[0].proposal.fragments, [{ startMs: 15968, endMs: 18261 }]);
});

test('previous CSV loads without requiring PCA coordinates', async () => {
  const points = await load([
    'embedding_id,original_recording_audio,source_fragment,original_30s_recording,window_start_s,window_end_s,label,umap_x,umap_y',
    'bark/sample_1000-2500:0002,samples/original.wav,old/path.wav,sample,0.96,1.0736875,bark,1,2',
  ].join('\n'));
  assert.equal(points[0].windowIndex, 2);
  assert.equal(points[0].annotationStart, 1);
  assert.ok(Math.abs(points[0].windowDuration - 0.1136875) < 1e-10);
});

test('blank UMAP coordinates do not create points at zero', async () => {
  await assert.rejects(load([
    'embedding_id,original_recording_audio,window_duration_s,label,umap_x,umap_y',
    'bark/sample_1000-2500:0000,samples/original.wav,0.96,bark,,2',
  ].join('\n')), /no plottable UMAP/);
});
