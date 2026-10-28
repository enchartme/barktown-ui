import { isIsoDate, startOfIsoWeek } from './utils.js';

/**
 * Return the adjacent entry in the report's current display order.
 *
 * @template T extends { id: string }
 * @param {T[]} orderedEntries
 * @param {string} currentId
 * @param {-1 | 1} direction
 * @returns {T | null}
 */
export function adjacentReportEntry(orderedEntries, currentId, direction) {
  const currentIndex = orderedEntries.findIndex((entry) => entry.id === currentId);
  if (currentIndex < 0) return null;
  return orderedEntries[currentIndex + direction] ?? null;
}

/** Deep-link a diary recording; the report resolves its week from the entry ID. */
export function reportEntryHref(entryId) {
  if (!entryId) return '/report';
  return `/report#${entryId}`;
}

/** Return the ISO-week Monday encoded at the start of a diary entry ID. */
export function reportWeekForEntryId(entryId) {
  const entryDate = typeof entryId === 'string' ? entryId.slice(0, 10) : '';
  return isIsoDate(entryDate) ? startOfIsoWeek(entryDate) : null;
}
