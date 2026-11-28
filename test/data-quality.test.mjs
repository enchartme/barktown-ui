import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  dailyDataQuality,
  dataQualityReasons,
  fetchDataQuality,
  summarizeDataQuality,
} from '../src/lib/data-quality.js';

const rows = [
  {
    durationS: 90, recordId: 'b', recordingStartedAt: '2026-08-28T11:00:00Z', xrunCount: 2,
    inputOverflowCount: 2, inputUnderflowCount: 0,
    outputOverflowCount: 0, outputUnderflowCount: 0, otherXrunCount: 0,
  },
  {
    durationS: 600, recordId: 'a', recordingStartedAt: '2026-08-28T10:00:00Z', xrunCount: 0,
    inputOverflowCount: 0, inputUnderflowCount: 0,
    outputOverflowCount: 0, outputUnderflowCount: 0, otherXrunCount: 0,
  },
  {
    durationS: 30, recordId: 'c', recordingStartedAt: '2026-08-29T10:00:00Z', xrunCount: 1,
    inputOverflowCount: 0, inputUnderflowCount: 1,
    outputOverflowCount: 0, outputUnderflowCount: 0, otherXrunCount: 0,
  },
];

test('data-quality summaries distinguish clean recordings and XRUN incidents', () => {
  assert.deepEqual(summarizeDataQuality(rows), {
    totalMinutes: 12,
    xrunsPerHour: 15,
    recordings: 3,
    clean: 1,
    affected: 2,
    totalXruns: 3,
    cleanRate: 1 / 3,
  });
  assert.deepEqual(dailyDataQuality(rows), [
    { date: '2026-08-28', recordings: 2, clean: 1, affected: 1, xruns: 2, totalMinutes: 11.5, cleanMinutes: 10, affectedMinutes: 1.5 },
    { date: '2026-08-29', recordings: 1, clean: 0, affected: 1, xruns: 1, totalMinutes: 0.5, cleanMinutes: 0, affectedMinutes: 0.5 },
  ]);
  assert.deepEqual(dataQualityReasons(rows).map(({ label, count }) => [label, count]), [
    ['Input overflow', 2],
    ['Input underflow', 1],
    ['Output overflow', 0],
    ['Output underflow', 0],
    ['Other', 0],
  ]);
});

test('data-quality loader follows public pagination', async () => {
  const urls = [];
  const fetchImpl = async (url) => {
    urls.push(url.toString());
    const page = Number(url.searchParams.get('page'));
    return {
      ok: true,
      async json() {
        return page === 1
          ? { items: [rows[0]], pagination: { hasNextPage: true, nextPage: 2 } }
          : { items: [rows[1]], pagination: { hasNextPage: false, nextPage: null } };
      },
    };
  };
  const result = await fetchDataQuality({
    apiBase: 'https://public.example.test',
    startDate: '2026-08-01',
    endDate: '2026-08-29',
    fetchImpl,
  });

  assert.deepEqual(result.map((row) => row.recordId), ['b', 'a']);
  assert.match(urls[0], /startDate=2026-08-01/);
  assert.match(urls[1], /page=2/);
});

test('Hourly XRUN rate uses total recording time rather than averaging per-clip rates', () => {
  const summary = summarizeDataQuality([
    { durationS: 60, xrunCount: 2 },
    { durationS: 540, xrunCount: 0 },
  ]);
  assert.equal(summary.totalMinutes, 10);
  assert.equal(summary.xrunsPerHour, 12);
});

test('missing, zero, and invalid durations do not produce invalid rates', () => {
  for (const rows of [[], [{ xrunCount: 1 }], [{ durationS: 0, xrunCount: 1 }], [{ durationS: -60, xrunCount: 1 }], [{ durationS: NaN, xrunCount: 1 }]]) {
    assert.equal(summarizeDataQuality(rows).totalMinutes, 0);
    assert.equal(summarizeDataQuality(rows).xrunsPerHour, null);
  }
  const [day] = dailyDataQuality([{ recordingStartedAt: '2026-08-28T10:00:00Z', xrunCount: 1 }]);
  assert.equal(day.totalMinutes, 0);
  assert.equal(day.xruns, 1);
});


test('90-day quality range retains exactly one slot per date across empty days', () => {
  const days = dailyDataQuality([
    { recordingStartedAt: '2026-08-31T12:00:00Z', durationS: 120, xrunCount: 2 },
    { recordingStartedAt: '2026-11-28T12:00:00Z', durationS: 60, xrunCount: 0 },
  ], { startDate: '2026-08-31', endDate: '2026-11-28' });
  assert.equal(days.length, 90);
  assert.equal(days[0].date, '2026-08-31');
  assert.equal(days.at(-1).date, '2026-11-28');
  assert.equal(days[1].date, '2026-09-01');
  assert.equal(days[1].totalMinutes, 0);
  assert.equal(days[0].totalMinutes, 2);
  assert.equal(days.at(-1).totalMinutes, 1);
  assert.equal(days.reduce((sum, day) => sum + day.xruns, 0), 2);
});

test('all-time quality chart fills dates between the oldest and newest rows', () => {
  const days = dailyDataQuality([
    { recordingStartedAt: '2026-11-28T12:00:00Z', durationS: 60, xrunCount: 0 },
    { recordingStartedAt: '2026-11-26T12:00:00Z', durationS: 60, xrunCount: 0 },
  ]);
  assert.deepEqual(days.map(day => day.date), ['2026-11-26', '2026-11-27', '2026-11-28']);
  assert.deepEqual(dailyDataQuality([]), []);
});
