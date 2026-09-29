import test from 'node:test';
import assert from 'node:assert/strict';

import {
  hydrateRecordingCommentAnnotations,
  inheritSampleWideAnnotations,
  manualFilenameComment,
  recordingComment,
  recordingCommentLabels,
  recordingType,
  withRecordingCommentAnnotations,
} from '../src/lib/recording-comments.js';

test('recording types follow the durable filename markers', () => {
  assert.equal(recordingType({ filename: '2026-08-01 05-49-56 -A-.wav' }), 'automatic');
  assert.equal(recordingType({ filename: '2026-06-07 09-31-27 SAMPLE bark.wav' }), 'sample');
  assert.equal(recordingType({ filename: '2022-02-04 13-08-00 possible comment.aac' }), 'manual');
});

test('only manual recordings fall back to filename comments', () => {
  assert.equal(manualFilenameComment({ filename: '2022-02-04 13-08-00 possible comment.aac' }), 'possible comment');
  assert.equal(manualFilenameComment({ filename: '2022-02-04 13-08-00.aac', label: 'stale' }), '');
  assert.equal(manualFilenameComment({ filename: '2026-08-01 05-49-56 -A-.wav', label: '-A-' }), '');
  assert.equal(manualFilenameComment({ filename: '2026-06-07 09-31-27 SAMPLE bark.wav', label: 'bark' }), '');
});

test('sample-wide DB notes override a manual filename comment', () => {
  const entry = {
    filename: '2022-02-04 13-08-00 filename comment.aac',
    annotations: [
      { source: 'note', startSec: 0, endSec: 0, label: 'Database comment' },
      { source: 'note', startSec: 2, endSec: 2, label: 'Timed note' },
      { source: 'manual', startSec: 0, endSec: 0, label: 'Fragment' },
    ],
  };

  assert.deepEqual(recordingCommentLabels(entry), ['Database comment']);
  assert.equal(recordingComment(entry), 'Database comment');
});

test('an explicitly cleared DB note suppresses a manual filename comment', () => {
  const entry = {
    filename: '2022-02-04 13-08-00 filename comment.aac',
    annotations: [{ source: 'note', startSec: 0, endSec: 0, label: '' }],
  };

  assert.deepEqual(recordingCommentLabels(entry), []);
  assert.equal(recordingComment(entry), '');
});

test('automatic and sample comments only use sample-wide notes', () => {
  const automatic = {
    filename: '2026-08-01 05-49-56 -A-.wav',
    annotations: [{ type: 'note', start_sec: 0, end_sec: 0, label: 'Clear barks' }],
  };
  const sample = { filename: '2026-06-07 09-31-27 SAMPLE bark.wav', annotations: [] };

  assert.deepEqual(recordingCommentLabels(automatic), ['Clear barks']);
  assert.deepEqual(recordingCommentLabels(sample), []);
});

test('annotation snapshots can be replaced after editing', () => {
  const entry = { id: 'clip-a', filename: '2022-02-04 13-08-00 old.aac', annotations: [] };
  const annotations = [{ source: 'note', startSec: 0, endSec: 0, label: 'New' }];
  const updated = withRecordingCommentAnnotations(entry, annotations);

  assert.notEqual(updated, entry);
  assert.equal(updated.id, entry.id);
  assert.deepEqual(updated.annotations, annotations);
});

test('sample-wide annotations are inherited by copied diary entries', () => {
  const entries = [
    {
      id: 'diary-sample',
      sampleId: 'sample-a',
      annotations: [{ id: 7, source: 'note', startSec: 0, endSec: 0, label: 'Existing diary note' }],
    },
    { id: 'unlinked-diary' },
  ];
  const annotations = [
    { id: 8, sampleId: 'sample-a', source: 'note', startSec: 0, endSec: 0, label: 'Inherited note' },
    { id: 9, sampleId: 'sample-a', source: 'note', startSec: 2, endSec: 2, label: 'Timed note' },
    { id: 10, sampleId: 'sample-b', source: 'note', startSec: 0, endSec: 0, label: 'Other sample' },
  ];

  const hydrated = inheritSampleWideAnnotations(entries, annotations);

  assert.deepEqual(recordingCommentLabels(hydrated[0]), ['Existing diary note', 'Inherited note']);
  assert.equal(hydrated[1], entries[1]);
});

test('legacy diary responses fetch inherited notes while current responses do not', async () => {
  const annotation = {
    id: 11,
    sampleId: 'sample-a',
    source: 'note',
    startSec: 0,
    endSec: 0,
    label: 'Training note',
  };
  let fetchCalls = 0;
  const fetchImpl = async (url) => {
    fetchCalls += 1;
    assert.equal(url, 'https://api.example/api/annotations');
    return { ok: true, json: async () => [annotation] };
  };

  const legacy = await hydrateRecordingCommentAnnotations(
    [{ id: 'diary-sample', sampleId: 'sample-a' }],
    'https://api.example',
    fetchImpl,
  );
  assert.equal(fetchCalls, 1);
  assert.deepEqual(legacy[0].annotations, [annotation]);

  const current = [{ id: 'diary-sample', sampleId: 'sample-a', annotations: [] }];
  assert.equal(
    await hydrateRecordingCommentAnnotations(current, 'https://api.example', fetchImpl),
    current,
  );
  assert.equal(fetchCalls, 1);
});
