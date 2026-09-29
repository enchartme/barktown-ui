import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  FIT_WAVEFORM_SECONDS_PER_PIXEL,
  centeredWaveformScrollLeft,
  formatWaveformSecondsPerPixel,
  stepWaveformSecondsPerPixel,
  waveformBarBackingWidth,
  waveformContentWidth,
  waveformFitSecondsPerPixel,
  waveformRangeScrollLeft,
  waveformZoomScale,
  zoomInvariantSvgWidth,
} from '../src/lib/training-waveform-zoom.js';

test('waveform zoom starts at FIT and snaps to absolute seconds per pixel', () => {
  const fit = waveformFitSecondsPerPixel(30, 1000);
  assert.equal(fit, 0.03);
  assert.equal(stepWaveformSecondsPerPixel(FIT_WAVEFORM_SECONDS_PER_PIXEL, 1, fit), 1 / 64);
  assert.equal(stepWaveformSecondsPerPixel(1 / 64, 1, fit), 0.01);
  assert.equal(stepWaveformSecondsPerPixel(0.01, 1, fit), 0.01);
  assert.equal(stepWaveformSecondsPerPixel(0.02, 1, fit), 1 / 64);
});

test('waveform zoom out doubles seconds per pixel and returns to FIT', () => {
  const fit = 0.03;
  assert.equal(stepWaveformSecondsPerPixel(0.01, -1, fit), 1 / 64);
  assert.equal(stepWaveformSecondsPerPixel(1 / 64, -1, fit), FIT_WAVEFORM_SECONDS_PER_PIXEL);
  assert.equal(stepWaveformSecondsPerPixel(FIT_WAVEFORM_SECONDS_PER_PIXEL, -1, fit), FIT_WAVEFORM_SECONDS_PER_PIXEL);
});

test('absolute waveform scale is retained across recordings of different durations', () => {
  const secondsPerPixel = 1 / 64;
  assert.equal(waveformContentWidth(30, 1000, secondsPerPixel), 1920);
  assert.equal(waveformContentWidth(60, 1000, secondsPerPixel), 3840);
  assert.equal(waveformContentWidth(10, 1000, secondsPerPixel), 1000);
  assert.equal(waveformZoomScale(30, 1000, secondsPerPixel), 1.92);
  assert.equal(waveformContentWidth(30, 1000, FIT_WAVEFORM_SECONDS_PER_PIXEL), 1000);
  assert.equal(formatWaveformSecondsPerPixel(FIT_WAVEFORM_SECONDS_PER_PIXEL), 'FIT');
  assert.equal(formatWaveformSecondsPerPixel(secondsPerPixel), '0.02 s/px');
  assert.equal(formatWaveformSecondsPerPixel(0.01), '0.01 s/px');
});

test('waveform zoom keeps the same timeline point centred', () => {
  assert.equal(centeredWaveformScrollLeft(250, 500, 1000, 2000), 750);
  assert.equal(centeredWaveformScrollLeft(0, 500, 500, 1000), 250);
});

test('waveform zoom scroll position is clamped at the timeline edges', () => {
  assert.equal(centeredWaveformScrollLeft(0, 500, 1000, 2000), 250);
  assert.equal(centeredWaveformScrollLeft(500, 500, 1000, 2000), 1250);
  assert.equal(centeredWaveformScrollLeft(500, 500, 1000, 500), 0);
});

test('waveform review focus minimally scrolls a fragment into view', () => {
  assert.equal(waveformRangeScrollLeft(0, 500, 2000, 50, 100, 75), 0);
  assert.equal(waveformRangeScrollLeft(0, 500, 2000, 800, 900, 850), 424);
  assert.equal(waveformRangeScrollLeft(1000, 500, 2000, 900, 950, 925), 876);
});

test('waveform review focus centres an oversized fragment on its suspect window', () => {
  assert.equal(waveformRangeScrollLeft(0, 500, 2000, 400, 1100, 800), 550);
  assert.equal(waveformRangeScrollLeft(0, 500, 500, 400, 500, 450), 0);
});

test('waveform primitives retain their visual width while the timeline zooms', () => {
  assert.equal(zoomInvariantSvgWidth(6, 1), 6);
  assert.equal(zoomInvariantSvgWidth(6, 2), 3);
  assert.equal(zoomInvariantSvgWidth(6, 32), 0.1875);
});

test('canvas waveform bars use one CSS pixel or the thinnest backing pixel', () => {
  assert.equal(waveformBarBackingWidth(2000, 1000), 2);
  assert.equal(waveformBarBackingWidth(16000, 32000), 1);
  assert.equal(waveformBarBackingWidth(0, 0), 1);
});
