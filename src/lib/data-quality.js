import { addDays, PUBLIC_API_BASE } from './utils.js';

const REASONS = [
  ['inputOverflowCount', 'Input overflow'],
  ['inputUnderflowCount', 'Input underflow'],
  ['outputOverflowCount', 'Output overflow'],
  ['outputUnderflowCount', 'Output underflow'],
  ['otherXrunCount', 'Other'],
];

export async function fetchDataQuality({
  startDate,
  endDate,
  apiBase = PUBLIC_API_BASE,
  fetchImpl = globalThis.fetch,
  pageSize = 1000,
  signal,
} = {}) {
  const items = [];
  let page = 1;
  while (true) {
    const url = new URL('/api/data-quality', apiBase);
    if (startDate) url.searchParams.set('startDate', startDate);
    if (endDate) url.searchParams.set('endDate', endDate);
    url.searchParams.set('page', String(page));
    url.searchParams.set('pageSize', String(pageSize));
    const response = await fetchImpl(url, { signal });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const body = await response.json();
    if (!Array.isArray(body?.items) || typeof body?.pagination !== 'object') {
      throw new Error('Malformed data-quality response');
    }
    items.push(...body.items);
    if (!body.pagination.hasNextPage) return items;
    if (!Number.isSafeInteger(body.pagination.nextPage) || body.pagination.nextPage <= page) {
      throw new Error('Malformed data-quality pagination');
    }
    page = body.pagination.nextPage;
  }
}

function recordedMinutes(row) {
  return Number.isFinite(row.durationS) && row.durationS > 0 ? row.durationS / 60 : 0;
}

export function summarizeDataQuality(rows) {
  const affected = rows.filter((row) => row.xrunCount > 0).length;
  const totalXruns = rows.reduce((sum, row) => sum + row.xrunCount, 0);
  const totalMinutes = rows.reduce((sum, row) => sum + recordedMinutes(row), 0);
  return {
    totalMinutes,
    xrunsPerHour: totalMinutes > 0 ? totalXruns / (totalMinutes / 60) : null,
    recordings: rows.length,
    clean: rows.length - affected,
    affected,
    totalXruns,
    cleanRate: rows.length ? (rows.length - affected) / rows.length : null,
  };
}

export function dailyDataQuality(rows, { startDate, endDate } = {}) {
  const byDate = new Map();
  for (const row of rows) {
    const date = row.recordingStartedAt?.slice(0, 10);
    if (!date) continue;
    const day = byDate.get(date) ?? { date, recordings: 0, clean: 0, affected: 0, xruns: 0, totalMinutes: 0, cleanMinutes: 0, affectedMinutes: 0 };
    const minutes = recordedMinutes(row);
    day.totalMinutes += minutes;
    if (row.xrunCount > 0) day.affectedMinutes += minutes;
    else day.cleanMinutes += minutes;
    day.recordings += 1;
    day.xruns += row.xrunCount;
    if (row.xrunCount > 0) day.affected += 1;
    else day.clean += 1;
    byDate.set(date, day);
  }
  const dates = [...byDate.keys()].sort();
  const firstDate = startDate ?? dates[0];
  const lastDate = endDate ?? dates.at(-1);
  const days = [];
  // Keep a calendar slot for every day, including dates with no quality rows.
  for (let date = firstDate; date && date <= lastDate; date = addDays(date, 1)) {
    days.push(byDate.get(date) ?? {
      date, recordings: 0, clean: 0, affected: 0, xruns: 0,
      totalMinutes: 0, cleanMinutes: 0, affectedMinutes: 0,
    });
  }
  return days;
}

export function dataQualityReasons(rows) {
  return REASONS.map(([field, label]) => ({
    field,
    label,
    count: rows.reduce((sum, row) => sum + (Number(row[field]) || 0), 0),
  }));
}
