import { formatNumber } from './number-format.js';
import { aggregateHitScores } from './hit-filters.js';

const BIN_COUNT = 11;
const BIN_WIDTH = 0.1;

/** All visible hit metadata; missing positive/negative groups are unavailable. */
export function windowDeltaDistribution(metadata) {
  const bins = Array(BIN_COUNT).fill(0);
  let count = 0;
  let mean = 0;
  let squaredDifferences = 0;

  for (let i = 0; i < (metadata?.timestamps?.length ?? 0); i++) {
    const { delta } = aggregateHitScores(metadata.multilabelScores?.[i]);
    if (!Number.isFinite(delta)) continue;
    // One bin for all negatives, followed by 0..1 in fixed 0.1 steps.
    // Include +1 in the final bin; tolerate rounding at positive bin edges.
    const bin = delta < 0 ? 0 : Math.min(BIN_COUNT - 1, 1 + Math.floor(delta / BIN_WIDTH + 1e-12));
    bins[bin]++;
    count++;
    // Welford's algorithm: population variance across this record's windows.
    const difference = delta - mean;
    mean += difference / count;
    squaredDifferences += difference * (delta - mean);
  }

  const standardDeviation = count ? Math.sqrt(Math.max(0, squaredDifferences / count)) : null;
  const maximum = Math.max(...bins);
  const heights = bins.map(value => maximum ? Math.round(value / maximum * 100) : 0);
  const title = [
    'Window delta = max(bark, yap) − max(other labels).',
    `${formatNumber(count)} windows with scores in the visible recording range, including filtered windows.`,
    'Histogram: all negative deltas in the first bar, then 0 to 1 in 0.1-wide bins; bar height shows relative frequency.',
    count ? `Mean μ = ${formatNumber(mean, 2)}; population standard deviation σ = ${formatNumber(standardDeviation, 2)}.` : 'μ and σ unavailable: no windows with both score groups.',
    ...bins.map((value, i) => `${i === 0 ? '< 0' : `${((i - 1) * BIN_WIDTH).toFixed(1)} to ${(i * BIN_WIDTH).toFixed(1)}`}: ${formatNumber(value)}`),
  ].join('\n');

  return { bins, count, mean: count ? mean : null, standardDeviation, chart: `{b:${heights.join(',')}}`, title };
}
