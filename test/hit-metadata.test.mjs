import { test } from 'node:test';
import assert from 'node:assert/strict';
import { get } from 'svelte/store';

import {
  formatAudioPanelAnalysisParameters,
  formatAudioPanelTitle,
  formatAudioPanelStats,
  formatAutoDetectionLabel,
  formatDiaryEntryTitle,
  formatHitMetadataStats,
  hitMetadataById,
  loadHitMetadata,
} from '../src/lib/hit-metadata.js';

function response(body) {
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    json: async () => body,
  };
}

test('bulk loader follows advertised pagination and merges every page', async () => {
  const requestedUrls = [];
  const pages = [
    {
      items: [
        { clipId: 'clip-a', timestamps: [1] },
        { clipId: 'clip-b', timestamps: [2] },
      ],
      pagination: { hasNextPage: true, isLastPage: false },
      links: { next: '/api/hit-metadata?page=2&pageSize=1000' },
    },
    {
      items: [{ clipId: 'clip-c', timestamps: [3] }],
      pagination: { hasNextPage: false, isLastPage: true },
      links: { next: null },
    },
  ];

  const result = await loadHitMetadata({
    fetchImpl: async (url) => {
      requestedUrls.push(url);
      return response(pages.shift());
    },
  });

  assert.deepEqual(result, { pagesLoaded: 2, recordsLoaded: 3 });
  assert.equal(new URL(requestedUrls[0]).origin, 'https://barktown-api.enchart.me');
  assert.match(requestedUrls[0], /\/api\/hit-metadata\?page=1&pageSize=1000$/);
  assert.match(requestedUrls[1], /\/api\/hit-metadata\?page=2&pageSize=1000$/);
  assert.deepEqual([...get(hitMetadataById).keys()], ['clip-a', 'clip-b', 'clip-c']);
});

test('auto-detection label is rebuilt from current hit metadata', () => {
  const metadata = {
    timestamps: [1, 3, 5],
    confidences: [0.91, 0.98, 0.94],
    loudnesses: [4.2, 1.4, 2.2],
    windowS: 9,
  };

  assert.equal(
    formatAutoDetectionLabel('-A- C1 D6 W94 La11.0 Lm1.9', metadata, 10),
    '-A- C0.98 D18 W3 La4.2 Lm2.6',
  );
});

test('hit metadata stats can be formatted independently of the stored label', () => {
  assert.equal(
    formatHitMetadataStats({
      timestamps: [1, 3, 5],
      confidences: [0.91, 0.98, 0.94],
      loudnesses: [4.2, 1.4, 2.2],
    }, 10),
    'C0.98 D18 W3 La4.2 Lm2.6',
  );
});

test('sample diary titles preserve SAMPLE and the comment before current stats', () => {
  assert.equal(
    formatDiaryEntryTitle({
      id: '2026-07-23_18-43-58_SAMPLE_bark',
      label: 'bark',
      durationSec: 10,
    }, {
      timestamps: [1, 3, 5],
      confidences: [0.91, 0.98, 0.94],
      loudnesses: [4.2, 1.4, 2.2],
    }),
    'SAMPLE bark C0.98 D18 W3 La4.2 Lm2.6',
  );
});

test('audio panel title expands sample hit stats for display', () => {
  assert.equal(
    formatAudioPanelTitle({
      id: '2026-07-23_18-43-58_SAMPLE_bark',
      label: 'bark',
      durationSec: 30,
    }, {
      timestamps: Array.from({ length: 9 }, (_, i) => i),
      confidences: Array(9).fill(1),
      loudnesses: [2.1, 2.4, 2.8, 2.9, 3.0, 3.1, 3.2, 3.4, 3.6],
    }),
    'SAMPLE bark: Barks: 9, Density: 18 bpm, Loudness Peak: 3.6x, Mean: 2.9x',
  );
});

test('audio panel stats can be shown without treating a filename descriptor as a comment', () => {
  assert.equal(
    formatAudioPanelStats({
      timestamps: [1, 3],
      confidences: [0.91, 0.99],
      loudnesses: [1.5, 2.5],
    }, 10),
    'Barks: 2, Density: 12 bpm, Loudness Peak: 2.5x, Mean: 2.0x',
  );
});

test('audio panel shows readable analysis parameters in display order', () => {
  const trainedAt = '2026-08-17T08:54:17Z';
  const localTrainedAt = new Date(trainedAt).toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
  assert.equal(
    formatAudioPanelAnalysisParameters({
      analysisTrigger: 'manual',
      analysisSettings: {
        classifier: {
          trained_at: trainedAt,
          model_filename: 'not-shown.tflite',
        },
        monitor: {
          candidate_threshold: 0.92,
          hit_refractory_s: 1.5,
          inference_window_s: 1.5,
          score_interval_s: 0.25,
          confirmation_hits: 3,
        },
      },
    }),
    `Trigger: manual · Trained: ${localTrainedAt} · Threshold: 0.92 · Refractory: 1.5s · Window: 1.5s · Step: 0.25s`,
  );
});

test('audio panel analysis parameters omit missing values and retain zero', () => {
  assert.equal(
    formatAudioPanelAnalysisParameters({
      analysisSettings: {
        classifier: { trained_at: null },
        monitor: { candidate_threshold: 0, hit_refractory_s: undefined },
      },
    }),
    'Threshold: 0',
  );
  assert.equal(formatAudioPanelAnalysisParameters(null), '');
  assert.equal(formatAudioPanelAnalysisParameters({ analysisSettings: {} }), '');
});

test('audio panel title expands auto-detected hit stats for display', () => {
  assert.equal(
    formatAudioPanelTitle({
      id: 'auto',
      label: '-A- stale compact stats',
      durationSec: 574,
    }, {
      timestamps: Array.from({ length: 67 }, (_, i) => i),
      confidences: Array(67).fill(1),
      loudnesses: [...Array(66).fill(2.3), 5.3],
    }),
    '-A-: Barks: 67, Density: 7 bpm, Loudness Peak: 5.3x, Mean: 2.3x',
  );
});

test('diary titles retain their descriptor without metadata and refresh auto stats', () => {
  assert.equal(
    formatDiaryEntryTitle({
      id: '2026-07-23_18-43-58_SAMPLE_bark',
      label: 'bark',
    }, null),
    'SAMPLE bark',
  );
  assert.equal(
    formatDiaryEntryTitle({
      id: 'auto',
      label: '-A- stale stats',
      durationSec: 10,
    }, {
      timestamps: [1],
      confidences: [1],
      loudnesses: [2],
    }),
    '-A- C1 D6 W1 La2.0 Lm2.0',
  );
});

test('auto-detection label handles maximum confidence, mean loudness, and no hits', () => {
  assert.equal(
    formatAutoDetectionLabel('-A- old values', {
      timestamps: [1, 2, 3, 4],
      confidences: [0.91, 1, 0.95, 0.93],
      loudnesses: [4, 1, 3, 2],
    }, 12),
    '-A- C1 D20 W4 La4.0 Lm2.5',
  );
  assert.equal(
    formatAutoDetectionLabel('-A- old values', {
      timestamps: [],
      confidences: [],
      loudnesses: [],
    }, 12),
    '-A- C0.00 D0 W0 La0.0 Lm0.0',
  );
});

test('stored label remains the fallback for non-auto or unloaded metadata', () => {
  assert.equal(formatAutoDetectionLabel('barking', null, 10), 'barking');
  assert.equal(formatAutoDetectionLabel('-A- stored values', null, 10), '-A- stored values');
  assert.equal(formatAutoDetectionLabel('manual C1', {
    timestamps: [1],
    confidences: [1],
    loudnesses: [2],
  }, 10), 'manual C1');
});
