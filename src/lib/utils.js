/**
 * utils.js – shared helpers for the barktown diary UI.
 *
 * All functions are pure; no Svelte or browser globals in here so they can be
 * used both in page load functions (SSR/prerender) and in component logic.
 */

// ─── Asset base URL ───────────────────────────────────────────────────────────

/**
 * Root URL for all remotely-hosted assets (audio, waveforms, index, sun).
 * Change this one constant to move the data layer to a different host.
 */
export const ASSET_BASE = 'https://s3.angiehjort.com/barktown';

/** Public, anonymous read-only Barktown API. */
export const PUBLIC_API_BASE = 'https://barktown-api.enchart.me';

/**
 * Base URL for barktown-server's Tailnet-only mutation/operator API.
 */
export const PRIVATE_API_BASE = 'https://barktown-private.tail523149.ts.net';

// ─── Time helpers ─────────────────────────────────────────────────────────────

/**
 * Convert "HH:MM" to minutes since midnight (0–1439).
 * @param {string} time  e.g. "17:25"
 * @returns {number}
 */
export function parseTimeToMinutes(time) {
  const [h, m] = time.split(':').map(Number);
  return h * 60 + m;
}

/**
 * Format a duration in seconds as a human-readable string.
 * e.g. 0 → "0s", 75 → "1:15", 3700 → "1:01:40"
 * @param {number} sec
 * @returns {string}
 */
export function formatDuration(sec) {
  if (!sec || sec <= 0) return '0s';
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  if (m > 0) return `${m}:${String(s).padStart(2, '0')}`;
  return `${s}s`;
}

/**
 * Format a training sample's `datetimeLocal` field for display.
 *
 * These are naive "YYYY-MM-DDTHH:MM:SS" strings already in local time
 * (written by the Pi's system clock, which is set to local time).
 * @param {string} datetimeLocal  e.g. "2026-02-07T18:25:00" (local time)
 * @param {{seconds?: boolean}} [opts]
 * @returns {string}  e.g. "2026-02-07 18:25" (or "...:25:00" with seconds)
 */
export function formatSampleDatetime(datetimeLocal, { seconds = false } = {}) {
  const [datePart, timePart] = datetimeLocal.split('T');
  return seconds ? `${datePart} ${timePart}` : `${datePart} ${timePart.slice(0, 5)}`;
}

/**
 * Format a "YYYY-MM-DD" string for display.
 * Uses noon to sidestep DST edge-cases.
 * @param {string} dateStr
 * @returns {string}  e.g. "Sat, 7 Dec 2025"
 */
export function formatDate(dateStr) {
  const d = new Date(dateStr + 'T12:00:00');
  return d.toLocaleDateString(undefined, {
    weekday: 'short',
    year:    'numeric',
    month:   'short',
    day:     'numeric',
  });
}

// ─── Grouping ─────────────────────────────────────────────────────────────────

/**
 * Group a flat array of entries by their `date` field.
 *
 * @param {import('./types').Entry[]} entries
 * @returns {{ date: string, entries: import('./types').Entry[] }[]}
 *   Sorted chronologically, entries within each day sorted by time.
 */
export function groupByDate(entries) {
  /** @type {Map<string, import('./types').Entry[]>} */
  const map = new Map();

  for (const entry of entries) {
    if (!map.has(entry.date)) map.set(entry.date, []);
    map.get(entry.date).push(entry);
  }

  const groups = [];
  for (const [date, dayEntries] of map) {
    groups.push({
      date,
      entries: [...dayEntries].sort((a, b) =>
        a.datetimeLocal.localeCompare(b.datetimeLocal)
      ),
    });
  }

  groups.sort((a, b) => b.date.localeCompare(a.date));
  return groups;
}

/**
 * Add whole calendar days to an ISO date without involving the local timezone.
 *
 * @param {string} dateStr YYYY-MM-DD
 * @param {number} amount
 * @returns {string} YYYY-MM-DD
 */
export function addDays(dateStr, amount) {
  const date = new Date(`${dateStr}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + amount);
  return date.toISOString().slice(0, 10);
}

/**
 * Return the Monday that starts the ISO week containing an ISO date.
 *
 * @param {string} dateStr YYYY-MM-DD
 * @returns {string} YYYY-MM-DD
 */
export function startOfIsoWeek(dateStr) {
  const date = new Date(`${dateStr}T00:00:00Z`);
  const daysSinceMonday = (date.getUTCDay() + 6) % 7;
  return addDays(dateStr, -daysSinceMonday);
}

/** Return true for a real calendar date formatted as YYYY-MM-DD. */
export function isIsoDate(dateStr) {
  if (typeof dateStr !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return false;
  const date = new Date(`${dateStr}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === dateStr;
}

/**
 * Group entries into every day in an inclusive range. Empty dates are retained
 * and the result follows the diary's newest-first ordering.
 *
 * @param {import('./types').Entry[]} entries
 * @param {string} startDate YYYY-MM-DD
 * @param {string} endDate YYYY-MM-DD
 * @returns {{ date: string, entries: import('./types').Entry[] }[]}
 */
export function groupByDateRange(entries, startDate, endDate) {
  const entriesByDate = new Map(groupByDate(entries).map(day => [day.date, day.entries]));
  const groups = [];

  for (let date = endDate; date >= startDate; date = addDays(date, -1)) {
    groups.push({ date, entries: entriesByDate.get(date) ?? [] });
  }

  return groups;
}

// ─── Lane assignment ──────────────────────────────────────────────────────────

/**
 * Assign vertical lanes to a set of entries within one day so that
 * overlapping entries don't visually cover each other.
 *
 * Algorithm (greedy interval scheduling):
 *   1. Sort entries by start time.
 *   2. For each entry, find the lowest-indexed lane whose existing intervals
 *      do not overlap the new entry's interval.
 *   3. If no free lane exists, open a new one.
 *
 * @param {import('./types').Entry[]} entries
 * @param {number} [minWidthMinutes]  minimum occupied span in minutes (default 15)
 * @returns {{ entriesWithLanes: Array<import('./types').Entry & { lane: number }>, laneCount: number }}
 */
export function assignLanes(entries, minWidthMinutes = 15) {
  // Sort chronologically; equal times keep their original order (stable).
  const sorted = [...entries].sort(
    (a, b) => parseTimeToMinutes(a.time) - parseTimeToMinutes(b.time)
  );

  /**
   * lanes[i] = array of { start, end } intervals already placed in lane i.
   * We use full interval lists (not just the last end) so that a lane that has
   * a gap in the middle can still accept a new entry inside that gap.
   * @type {Array<Array<{start: number, end: number}>>}
   */
  const lanes  = [];
  const result = [];

  for (const entry of sorted) {
    const start      = parseTimeToMinutes(entry.time);
    const durationMin = (entry.durationSec ?? 0) / 60;
    // Effective end: at least minWidthMinutes so even 0-sec pins block space.
    const end        = start + Math.max(durationMin, minWidthMinutes);

    /**
     * An entry fits in a lane when it does not overlap any interval already
     * there.  Two intervals [a,b) and [c,d) overlap iff a < d && c < b.
     */
    const fits = (lane) =>
      lane.every((iv) => start >= iv.end || end <= iv.start);

    // Find the first existing lane that can accommodate this entry.
    let laneIndex = lanes.findIndex(fits);

    if (laneIndex === -1) {
      // No existing lane has room – open a new one.
      laneIndex = lanes.length;
      lanes.push([]);
    }

    lanes[laneIndex].push({ start, end });
    result.push({ ...entry, lane: laneIndex });
  }

  return {
    entriesWithLanes: result,
    laneCount: Math.max(1, lanes.length),
  };
}

// ─── Waveform helpers ─────────────────────────────────────────────────────────

/**
 * Normalisation factor for audiowaveform peak values.
 * bits=8 → 128, bits=16 → 32768
 * @param {number} bits
 * @returns {number}
 */
export function waveformNorm(bits) {
  return Math.pow(2, bits - 1);
}

/**
 * Downsample a waveform `data` array to at most `targetBars` bar columns.
 *
 * The data array is interleaved [min0, max0, min1, max1, …].
 * Downsampling takes the absolute-max pair across each window.
 *
 * @param {number[]} data
 * @param {number}   targetBars
 * @returns {{ mins: number[], maxs: number[] }}
 */
export function downsampleWaveform(data, targetBars) {
  const totalBars = data.length / 2;
  const step      = Math.max(1, Math.floor(totalBars / targetBars));
  const mins = [];
  const maxs = [];

  for (let i = 0; i < totalBars; i += step) {
    let winMin = 0;
    let winMax = 0;
    const end = Math.min(i + step, totalBars);
    for (let j = i; j < end; j++) {
      const lo = data[j * 2];
      const hi = data[j * 2 + 1];
      if (lo < winMin) winMin = lo;
      if (hi > winMax) winMax = hi;
    }
    mins.push(winMin);
    maxs.push(winMax);
  }

  return { mins, maxs };
}
