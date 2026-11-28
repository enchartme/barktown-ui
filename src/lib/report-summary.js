import { formatNumber } from './number-format.js';
/** Format a duration without seconds, truncating incomplete minutes. */
export function formatDisturbedTime(totalDurationSec) {
  const totalMinutes = Math.floor(Math.max(0, totalDurationSec) / 60);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;

  return hours > 0 ? `${formatNumber(hours)} h ${formatNumber(minutes)} min` : `${formatNumber(minutes)} min`;
}
