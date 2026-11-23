export const BARCODE_INTERVAL_SECONDS = 1.5;
export const MAX_BARCODE_WIDTH = 380;

/**
 * One CSS pixel represents one detector interval. A one-pixel minimum keeps
 * zero-duration or incomplete records visible without changing the scale for
 * normal recordings.
 *
 * @param {number} durationSec
 */
export function barcodeWidth(durationSec) {
  const duration = Number.isFinite(durationSec) ? Math.max(0, durationSec) : 0;
  return Math.max(1, Math.min(MAX_BARCODE_WIDTH, Math.ceil(duration / BARCODE_INTERVAL_SECONDS)));
}

/**
 * Continuous orange -> dark-red scale, matching the diary hit visualization.
 *
 * @param {number} loudness
 */
export function hitLoudnessColor(loudness) {
  const low = 1;
  const high = 4;
  const value = Number.isFinite(loudness) ? loudness : low;
  const amount = Math.max(0, Math.min(1, (value - low) / (high - low)));
  const from = [255, 165, 0];
  const to = [139, 0, 0];
  const [red, green, blue] = from.map((channel, index) => (
    Math.round(channel + (to[index] - channel) * amount)
  ));
  return `rgb(${red}, ${green}, ${blue})`;
}

/**
 * Collapse hits into 1.5-second barcode columns. When more than one hit lands
 * in an interval, the loudest hit determines the line colour. Confidence is
 * deliberately not read or represented.
 *
 * @param {{timestamps?: number[], loudnesses?: number[]} | null | undefined} metadata
 * @param {number} width
 * @returns {{x: number, loudness: number}[]}
 */
export function barcodeLines(metadata, width) {
  if (!Array.isArray(metadata?.timestamps) || width <= 0) return [];

  const loudestByColumn = new Map();
  metadata.timestamps.forEach((timestamp, index) => {
    if (!Number.isFinite(timestamp) || timestamp < 0) return;
    const x = Math.floor(timestamp / BARCODE_INTERVAL_SECONDS);
    if (x >= width) return;

    const loudness = Number.isFinite(metadata.loudnesses?.[index])
      ? metadata.loudnesses[index]
      : 1;
    const current = loudestByColumn.get(x);
    if (current === undefined || loudness > current) loudestByColumn.set(x, loudness);
  });

  return [...loudestByColumn]
    .sort(([left], [right]) => left - right)
    .map(([x, loudness]) => ({ x, loudness }));
}

/** Match the orange-to-red loudness scale with light-to-dark neutral grey. */
export function filteredHitColor(loudness) {
  const amount = Math.max(0, Math.min(1, ((Number.isFinite(loudness) ? loudness : 1) - 1) / 3));
  const grey = Math.round(185 - amount * 90);
  return `rgb(${grey}, ${grey}, ${grey})`;
}

/** Draw grey columns first so retained hits win when windows share a column. */
export function barcodePresentationLines(metadata, width) {
  const group = filtered => barcodeLines({
    ...metadata,
    timestamps: metadata?.timestamps?.map((timestamp, i) => Boolean(metadata.filteredHits?.[i]) === filtered ? timestamp : NaN),
  }, width).map(line => ({ ...line, filtered }));
  return [...group(true), ...group(false)];
}
