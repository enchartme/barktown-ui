export const FIT_WAVEFORM_SECONDS_PER_PIXEL = 0;
export const MIN_WAVEFORM_SECONDS_PER_PIXEL = 0.01;

export function waveformFitSecondsPerPixel(durationSec, viewportWidth) {
  if (!(durationSec > 0) || !(viewportWidth > 0)) return 0;
  return durationSec / viewportWidth;
}

function nextLowerPowerOfTwo(value) {
  if (!(value > 0)) return 0;
  return 2 ** (Math.ceil(Math.log2(value)) - 1);
}

function nextHigherPowerOfTwo(value) {
  if (!(value > 0)) return 0;
  return 2 ** (Math.floor(Math.log2(value)) + 1);
}

/**
 * Step an absolute seconds-per-pixel setting. FIT is represented by zero.
 * Zooming in snaps below the current fitted scale, then halves seconds per
 * pixel on every press (doubling magnification). Zooming out doubles it until
 * the complete waveform fits, at which point the state returns to FIT.
 */
export function stepWaveformSecondsPerPixel(
  currentSecondsPerPixel,
  direction,
  fitSecondsPerPixel,
) {
  if (direction === 0 || !(fitSecondsPerPixel > 0)) return currentSecondsPerPixel;
  const currentlyFits = !(currentSecondsPerPixel > 0)
    || currentSecondsPerPixel >= fitSecondsPerPixel;

  if (direction > 0) {
    const reference = currentlyFits ? fitSecondsPerPixel : currentSecondsPerPixel;
    return Math.max(
      MIN_WAVEFORM_SECONDS_PER_PIXEL,
      nextLowerPowerOfTwo(reference),
    );
  }

  if (currentlyFits) return FIT_WAVEFORM_SECONDS_PER_PIXEL;
  const next = nextHigherPowerOfTwo(currentSecondsPerPixel);
  return next >= fitSecondsPerPixel
    ? FIT_WAVEFORM_SECONDS_PER_PIXEL
    : next;
}

export function waveformContentWidth(durationSec, viewportWidth, secondsPerPixel) {
  if (!(viewportWidth > 0)) return 0;
  if (!(durationSec > 0) || !(secondsPerPixel > 0)) return viewportWidth;
  return Math.max(viewportWidth, durationSec / secondsPerPixel);
}

export function waveformZoomScale(durationSec, viewportWidth, secondsPerPixel) {
  if (!(viewportWidth > 0)) return 1;
  return waveformContentWidth(durationSec, viewportWidth, secondsPerPixel) / viewportWidth;
}

export function formatWaveformSecondsPerPixel(secondsPerPixel) {
  if (!(secondsPerPixel > 0)) return 'FIT';
  return `${secondsPerPixel.toFixed(2)} s/px`;
}

/**
 * Keep the same point in the timeline at the centre of the viewport after
 * its scrollable content changes width.
 */
export function centeredWaveformScrollLeft(scrollLeft, viewportWidth, oldContentWidth, newContentWidth) {
  if (viewportWidth <= 0 || oldContentWidth <= 0 || newContentWidth <= viewportWidth) return 0;

  const centreFraction = (scrollLeft + viewportWidth / 2) / oldContentWidth;
  const nextScrollLeft = centreFraction * newContentWidth - viewportWidth / 2;
  return Math.max(0, Math.min(newContentWidth - viewportWidth, nextScrollLeft));
}

/**
 * Return the smallest horizontal scroll adjustment that brings a timeline
 * range into view. If the range is wider than the usable viewport, centre the
 * supplied focus point instead.
 */
export function waveformRangeScrollLeft(
  scrollLeft,
  viewportWidth,
  contentWidth,
  rangeStart,
  rangeEnd,
  focusPoint = (rangeStart + rangeEnd) / 2,
  margin = 24,
) {
  if (viewportWidth <= 0 || contentWidth <= viewportWidth) return 0;
  const maxScrollLeft = contentWidth - viewportWidth;
  const safeMargin = Math.max(0, Math.min(margin, viewportWidth / 4));
  const start = Math.max(0, Math.min(contentWidth, Math.min(rangeStart, rangeEnd)));
  const end = Math.max(start, Math.min(contentWidth, Math.max(rangeStart, rangeEnd)));
  const visibleStart = scrollLeft + safeMargin;
  const visibleEnd = scrollLeft + viewportWidth - safeMargin;
  if (start >= visibleStart && end <= visibleEnd) {
    return Math.max(0, Math.min(maxScrollLeft, scrollLeft));
  }

  let nextScrollLeft;
  if (end - start > viewportWidth - safeMargin * 2) {
    nextScrollLeft = focusPoint - viewportWidth / 2;
  } else if (start < visibleStart) {
    nextScrollLeft = start - safeMargin;
  } else {
    nextScrollLeft = end - viewportWidth + safeMargin;
  }
  return Math.max(0, Math.min(maxScrollLeft, nextScrollLeft));
}

/** Keep a horizontal SVG measurement visually unchanged as its timeline zooms. */
export function zoomInvariantSvgWidth(baseWidth, zoom) {
  return baseWidth / Math.max(1, zoom);
}

/**
 * Convert one displayed CSS pixel to the canvas backing-store width. When a
 * capped canvas has less than one backing pixel per CSS pixel, use the
 * thinnest drawable width instead of stretching bars with the timeline.
 */
export function waveformBarBackingWidth(canvasWidth, displayWidth) {
  if (canvasWidth <= 0 || displayWidth <= 0) return 1;
  return Math.max(1, canvasWidth / displayWidth);
}
