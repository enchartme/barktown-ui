export const DEFAULT_JANKY_UNIT_SEC = 0.5;
export const JANKY_UNIT_OPTIONS_SEC = Object.freeze([0.5, 1]);
export const JANKY_STEP_SEC = 0.05;
export const MAX_JANKY_LEVEL = 9;

/** Clamp a slider-like value to one of the supported integer levels. */
export function normalizeJankyLevel(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 0;
  return Math.max(0, Math.min(MAX_JANKY_LEVEL, Math.round(number)));
}

/** Accept only the base units exposed by the player selector. */
export function normalizeJankyUnitSec(value) {
  const number = Number(value);
  return JANKY_UNIT_OPTIONS_SEC.includes(number) ? number : DEFAULT_JANKY_UNIT_SEC;
}

/** Describe how much of each selected base unit is played and skipped. */
export function jankyPlaybackProfile(value, unitSec = DEFAULT_JANKY_UNIT_SEC) {
  const level = normalizeJankyLevel(value);
  const normalizedUnitSec = normalizeJankyUnitSec(unitSec);
  const playSec = level === 0 ? normalizedUnitSec : (10 - level) * JANKY_STEP_SEC;
  const skipSec = Math.round((normalizedUnitSec - playSec) * 100) / 100;
  return {
    level,
    unitSec: normalizedUnitSec,
    playSec,
    skipSec,
  };
}

/**
 * Decide whether playback should continue or jump to the next base-unit
 * boundary. The modulation is anchored to the source timeline, so seeking to
 * any point produces the same played/skipped regions.
 *
 * @param {number} currentSec
 * @param {number} level
 * @param {number} [unitSec]
 * @returns {{type:'keep'}|{type:'seek', time:number}}
 */
export function jankyPlaybackStep(currentSec, level, unitSec = DEFAULT_JANKY_UNIT_SEC) {
  const time = Number.isFinite(currentSec) ? Math.max(0, currentSec) : 0;
  const profile = jankyPlaybackProfile(level, unitSec);
  if (profile.level === 0) return { type: 'keep' };

  const unitIndex = Math.floor(time / profile.unitSec);
  const unitStart = unitIndex * profile.unitSec;
  const phase = time - unitStart;
  // Absorb floating-point drift at boundaries such as 0.95 - 0.5.
  if (phase < profile.playSec - 1e-9) return { type: 'keep' };

  return { type: 'seek', time: (unitIndex + 1) * profile.unitSec };
}
