/**
 * Return the playable, positive-duration fragment ranges for approver
 * listening. Notes are annotations too, but they are not tagged fragments.
 * Overlapping and touching fragments are merged so playback never seeks
 * backwards when two tags cover the same audio.
 *
 * @param {Record<string, unknown>[]} annotations
 * @param {{startSec?: number, endSec?: number}} [bounds]
 * @returns {{startSec: number, endSec: number}[]}
 */
export function taggedFragmentRanges(annotations, bounds = {}) {
  const startBound = Number.isFinite(bounds.startSec) ? Math.max(0, bounds.startSec) : 0;
  const endBound = Number.isFinite(bounds.endSec)
    ? Math.max(startBound, bounds.endSec)
    : Number.POSITIVE_INFINITY;

  const ranges = (Array.isArray(annotations) ? annotations : [])
    .filter(annotation => (annotation?.source ?? annotation?.type) !== 'note')
    .map(annotation => ({
      startSec: Math.max(startBound, Number(annotation?.startSec ?? annotation?.start_sec)),
      endSec: Math.min(endBound, Number(annotation?.endSec ?? annotation?.end_sec)),
    }))
    .filter(range => Number.isFinite(range.startSec) && Number.isFinite(range.endSec) && range.endSec > range.startSec)
    .sort((a, b) => a.startSec - b.startSec || a.endSec - b.endSec);

  /** @type {{startSec: number, endSec: number}[]} */
  const merged = [];
  for (const range of ranges) {
    const previous = merged.at(-1);
    if (previous && range.startSec <= previous.endSec) {
      previous.endSec = Math.max(previous.endSec, range.endSec);
    } else {
      merged.push({ ...range });
    }
  }
  return merged;
}

/**
 * Convert the detector hit windows shown in diary/report waveforms into the
 * same normalized ranges used by approver playback.
 *
 * @param {{timestamps?: number[], windowS?: number}|null|undefined} metadata
 * @param {{startSec?: number, endSec?: number}} [bounds]
 */
export function hitMetadataFragmentRanges(metadata, bounds = {}) {
  const windowSec = Number(metadata?.windowS);
  if (!Number.isFinite(windowSec) || windowSec <= 0 || !Array.isArray(metadata?.timestamps)) return [];
  return taggedFragmentRanges(
    metadata.timestamps.map(timestamp => ({
      source: 'detector',
      startSec: Number(timestamp) - windowSec,
      endSec: Number(timestamp),
    })),
    bounds,
  );
}

/** Find the fragment containing `currentSec`, or the next fragment after it. */
export function taggedRangeIndexAtOrAfter(ranges, currentSec) {
  const time = Number.isFinite(currentSec) ? currentSec : 0;
  return ranges.findIndex(range => time < range.endSec);
}

/**
 * Decide whether tagged-fragment playback should continue, seek across a gap,
 * or finish. The small end tolerance prevents a frame of untagged audio from
 * leaking through before the next animation-frame check.
 *
 * @param {{startSec: number, endSec: number}[]} ranges
 * @param {number} currentSec
 * @param {number} activeIndex
 * @param {number} [endToleranceSec]
 * @returns {{type:'keep', index:number}|{type:'seek', index:number, time:number}|{type:'finished', index:-1}}
 */
export function taggedPlaybackStep(ranges, currentSec, activeIndex, endToleranceSec = 0.01) {
  const time = Number.isFinite(currentSec) ? currentSec : 0;
  const active = ranges[activeIndex];
  if (
    active
    && time >= active.startSec - endToleranceSec
    && time < active.endSec - endToleranceSec
  ) {
    return { type: 'keep', index: activeIndex };
  }

  let nextIndex;
  if (active && time >= active.endSec - endToleranceSec) {
    nextIndex = ranges.findIndex((range, index) => index > activeIndex && time < range.endSec);
  } else {
    nextIndex = taggedRangeIndexAtOrAfter(ranges, time);
  }
  if (nextIndex < 0) return { type: 'finished', index: -1 };

  const next = ranges[nextIndex];
  if (time >= next.startSec && time < next.endSec - endToleranceSec) {
    return { type: 'keep', index: nextIndex };
  }
  return { type: 'seek', index: nextIndex, time: next.startSec };
}
