import test from 'node:test';
import assert from 'node:assert/strict';

import {
  adjacentReportEntry,
  reportEntryHref,
  reportWeekForEntryId,
} from '../src/lib/report-navigation.js';

const entries = [
  { id: 'monday-1' },
  { id: 'monday-2' },
  { id: 'tuesday-1' },
];

test('report navigation follows the current display order', () => {
  assert.equal(adjacentReportEntry(entries, 'monday-2', -1)?.id, 'monday-1');
  assert.equal(adjacentReportEntry(entries, 'monday-2', 1)?.id, 'tuesday-1');
});

test('report navigation stops at the ends and for an unknown entry', () => {
  assert.equal(adjacentReportEntry(entries, 'monday-1', -1), null);
  assert.equal(adjacentReportEntry(entries, 'tuesday-1', 1), null);
  assert.equal(adjacentReportEntry(entries, 'missing', 1), null);
});

test('report entry links only need the entry ID', () => {
  assert.equal(
    reportEntryHref('2026-01-01_12-00-00_auto'),
    '/report#2026-01-01_12-00-00_auto',
  );
  assert.equal(reportEntryHref(''), '/report');
});

test('report resolves an entry week from the date encoded in its ID', () => {
  assert.equal(reportWeekForEntryId('2026-01-01_12-00-00_auto'), '2025-12-29');
  assert.equal(reportWeekForEntryId('2026-10-28_12-00-00_auto'), '2026-10-26');
  assert.equal(reportWeekForEntryId('not-a-diary-entry'), null);
});
