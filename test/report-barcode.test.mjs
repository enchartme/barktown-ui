import test from 'node:test';
import assert from 'node:assert/strict';

import {
  barcodeLines,
  barcodeWidth,
  hitLoudnessColor,
  hitLoudnessFraction,
  MAX_BARCODE_WIDTH,
} from '../src/lib/report-barcode.js';

test('barcode width uses one pixel per 1.5 seconds and caps at 380 pixels', () => {
  assert.equal(barcodeWidth(1.5), 1);
  assert.equal(barcodeWidth(18.42), 13);
  assert.equal(barcodeWidth(570), MAX_BARCODE_WIDTH);
  assert.equal(barcodeWidth(900), MAX_BARCODE_WIDTH);
  assert.equal(barcodeWidth(0), 1);
});

test('barcode lines use 1.5-second intervals and the loudest hit in a shared interval', () => {
  const metadata = {
    timestamps: [0.2, 1.4, 1.5, 5.9, -1, Number.NaN],
    loudnesses: [1.2, 3.1, 2, 4, 4, 4],
    confidences: [0.1, 0.2, 0.3, 0.4, 1, 1],
  };

  assert.deepEqual(barcodeLines(metadata, 3), [
    { x: 0, loudness: 3.1 },
    { x: 1, loudness: 2 },
  ]);
});

test('barcode loudness palette runs from orange to dark red', () => {
  assert.equal(hitLoudnessColor(1), 'rgb(255, 165, 0)');
  assert.equal(hitLoudnessColor(10), 'rgb(139, 0, 0)');
  assert.equal(hitLoudnessColor(100), 'rgb(139, 0, 0)');
});

test('loudness bar shares the logarithmic 1–10x color domain and clamps its width', () => {
  assert.equal(hitLoudnessFraction(0), 0);
  assert.equal(hitLoudnessFraction(1), 0);
  assert.ok(Math.abs(hitLoudnessFraction(Math.sqrt(10)) - 0.5) < 1e-12);
  assert.ok(Math.abs(hitLoudnessFraction(2) - Math.log10(2)) < 1e-12);
  assert.equal(hitLoudnessFraction(10), 1);
  assert.equal(hitLoudnessFraction(100), 1);
  assert.equal(hitLoudnessFraction(NaN), 0);
});
