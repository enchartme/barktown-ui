<script>
  import { page } from '$app/state';
  import { onMount } from 'svelte';
  import AudioPlayerPanel from '$lib/components/AudioPlayerPanel.svelte';
  import GoblinPiStatus from '$lib/components/GoblinPiStatus.svelte';
  import ReportBarcode from '$lib/components/ReportBarcode.svelte';
  import { fetchDiarySummary } from '$lib/diary-summary.js';
  import { hitMetadataById, loadHitMetadata } from '$lib/hit-metadata.js';
  import { reportSentenceNeedsPeriod } from '$lib/report-annotations.js';
  import {
    hydrateRecordingCommentAnnotations,
    recordingCommentLabels,
    withRecordingCommentAnnotations,
  } from '$lib/recording-comments.js';
  import { formatPrintReportRange, reportBounds } from '$lib/report-range.js';
  import { adjacentReportEntry } from '$lib/report-navigation.js';
  import { formatDisturbedTime } from '$lib/report-summary.js';
  import { withLinkedTrainingSample } from '$lib/diary-samples.js';
  import { probeEditingAccess } from '$lib/editing-access.js';
  import { isEmbeddedLayout } from '$lib/embed.js';
  import { DIARY_NIGHT_COLOR, isNighttimeRecording } from '$lib/sun-time.js';
  import {
    addDays,
    PRIVATE_API_BASE,
    PUBLIC_API_BASE,
    formatDate,
    groupByDateRange,
    isIsoDate,
    startOfIsoWeek,
  } from '$lib/utils.js';

  let { data } = $props();

  /** @type {import('$lib/types').Entry[]} */
  let entries = $state([]);
  let periodSummary = $state({
    startDate: null,
    endDate: null,
    days: [],
    totals: { records: 0, disturbedTimeSec: 0, barks: 0 },
  });
  let loading = $state(true);
  /** @type {string | null} */
  let loadError = $state(null);
  /** Monday of the newest week in the selected report window. */
  /** @type {string | null} */
  let reportWeekStart = $state(null);
  let reportRequestId = 0;
  let operatorAccess = $state(false);

  let dayOrder = $state('asc');
  let recordingOrder = $state('asc');
  let rangeWeeks = $state(1);
  let printMode = $derived(data.initialPrintMode ?? false);
  const embedded = $derived(isEmbeddedLayout(page.url.searchParams));

  /** @type {import('$lib/types').Entry | null} */
  let panelEntry = $state(null);
  let showPanel = $state(false);

  const reportDateBounds = $derived(
    reportWeekStart ? reportBounds(reportWeekStart, rangeWeeks) : null,
  );
  const reportStartDate = $derived(reportDateBounds?.startDate ?? null);
  const reportEndDate = $derived(reportDateBounds?.endDate ?? null);
  const sunByDate = $derived(data.sunByDate ?? {});
  const summaryByDate = $derived(new Map(periodSummary.days.map((day) => [day.date, day])));

  const days = $derived.by(() => {
    if (!reportStartDate || !reportEndDate) return [];

    let grouped = groupByDateRange(
      entries.filter((entry) => entry.kind === 'audio'),
      reportStartDate,
      reportEndDate,
    );
    if (dayOrder === 'asc') grouped = [...grouped].reverse();

    return grouped.map((day) => {
      const orderedEntries = recordingOrder === 'asc'
        ? day.entries
        : [...day.entries].reverse();
      const serverSummary = summaryByDate.get(day.date);
      return {
        ...day,
        entries: orderedEntries,
        summary: {
          disturbances: serverSummary?.records ?? 0,
          totalDurationSec: serverSummary?.disturbedTimeSec ?? 0,
          barks: serverSummary?.barks ?? 0,
        },
      };
    });
  });
  const reportTotals = $derived({
    disturbances: periodSummary.totals.records,
    totalDurationSec: periodSummary.totals.disturbedTimeSec,
    barks: periodSummary.totals.barks,
  });
  const orderedReportEntries = $derived(days.flatMap((day) => day.entries));

  function todayInStockholm() {
    return new Intl.DateTimeFormat('sv-SE', {
      timeZone: 'Europe/Stockholm',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(new Date());
  }

  function formatRangeDate(dateStr, includeYear = false) {
    return new Date(`${dateStr}T12:00:00`).toLocaleDateString(undefined, {
      month: 'short',
      day: 'numeric',
      ...(includeYear ? { year: 'numeric' } : {}),
    });
  }

  const reportRangeLabel = $derived(
    reportStartDate && reportEndDate
      ? `${formatRangeDate(reportStartDate)} – ${formatRangeDate(reportEndDate, true)}`
      : '',
  );
  const printRangeLabel = $derived(
    reportStartDate && reportEndDate
      ? formatPrintReportRange(reportStartDate, reportEndDate)
      : '',
  );
  const interactiveHref = $derived(
    reportWeekStart
      ? `/report?week=${reportWeekStart}&weeks=${rangeWeeks}&days=${dayOrder}&recordings=${recordingOrder}`
      : '/report',
  );

  function updateReportUrl() {
    if (!reportWeekStart) return;
    const url = new URL(window.location.href);
    url.searchParams.set('week', reportWeekStart);
    url.searchParams.set('weeks', String(rangeWeeks));
    url.searchParams.set('days', dayOrder);
    url.searchParams.set('recordings', recordingOrder);
    history.replaceState(null, '', `${url.pathname}${url.search}${url.hash}`);
  }

  async function fetchDiary(bounds) {
    const url = new URL('/api/diary', PUBLIC_API_BASE);
    url.searchParams.set('startDate', bounds.startDate);
    url.searchParams.set('endDate', bounds.endDate);
    const response = await fetch(url);
    if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
    const nextEntries = await response.json();
    return hydrateRecordingCommentAnnotations(nextEntries, PUBLIC_API_BASE);
  }

  async function fetchLatestDiaryDate() {
    const response = await fetch(`${PUBLIC_API_BASE}/api/diary/latest-date`);
    if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
    const body = await response.json();
    return isIsoDate(body?.date) ? body.date : null;
  }

  async function refreshPeriodSummary(bounds = reportDateBounds) {
    if (!bounds) return;
    const requestedPeriod = `${bounds.startDate}:${bounds.endDate}`;
    try {
      const nextSummary = await fetchDiarySummary(bounds);
      const currentPeriod = reportDateBounds
        ? `${reportDateBounds.startDate}:${reportDateBounds.endDate}`
        : '';
      if (requestedPeriod === currentPeriod) periodSummary = nextSummary;
    } catch (error) {
      console.error('Failed to refresh diary summary:', error);
    }
  }

  async function loadReport(weekStart) {
    const bounds = reportBounds(weekStart, rangeWeeks);
    const requestId = ++reportRequestId;
    loading = true;
    loadError = null;

    try {
      const [nextEntries, nextSummary] = await Promise.all([
        fetchDiary(bounds),
        fetchDiarySummary(bounds),
      ]);
      if (requestId !== reportRequestId) return;
      entries = nextEntries;
      periodSummary = nextSummary;
      void loadHitMetadata(bounds).catch((error) => {
        console.error('Failed to load hit metadata:', error);
      });
    } catch (error) {
      if (requestId === reportRequestId) {
        loadError = error?.message ?? 'Failed to load report';
      }
    } finally {
      if (requestId === reportRequestId) loading = false;
    }
  }

  async function changeReportWeek(deltaWeeks) {
    if (!reportWeekStart || loading) return;
    closePanel();
    reportWeekStart = addDays(reportWeekStart, deltaWeeks * 7);
    updateReportUrl();
    await loadReport(reportWeekStart);
  }

  async function showLatestWeek() {
    if (loading) return;
    closePanel();
    loading = true;
    loadError = null;

    try {
      const latestDate = await fetchLatestDiaryDate();
      reportWeekStart = startOfIsoWeek(latestDate || todayInStockholm());
      updateReportUrl();
      await loadReport(reportWeekStart);
    } catch (error) {
      loadError = error?.message ?? 'Failed to find the latest diary date';
      loading = false;
    }
  }

  async function changeRangeWeeks(weeks) {
    if (!reportWeekStart || loading || rangeWeeks === weeks) return;
    closePanel();
    rangeWeeks = weeks;
    updateReportUrl();
    await loadReport(reportWeekStart);
  }

  function showPrintLayout() {
    closePanel();
    printMode = true;
    const url = new URL(window.location.href);
    url.searchParams.set('print', '1');
    history.pushState(null, '', `${url.pathname}${url.search}`);
  }

  function changeDayOrder(event) {
    dayOrder = event.currentTarget.value;
    updateReportUrl();
  }

  function changeRecordingOrder(event) {
    recordingOrder = event.currentTarget.value;
    updateReportUrl();
  }

  function selectEntry(entry) {
    panelEntry = entry;
    showPanel = true;
    const url = new URL(window.location.href);
    url.hash = entry.id;
    history.replaceState(null, '', `${url.pathname}${url.search}${url.hash}`);
  }

  /**
   * Open the previous or next recording in the order currently shown.
   * @param {-1 | 1} direction
   */
  function selectAdjacentEntry(direction) {
    if (!panelEntry) return;
    const adjacent = adjacentReportEntry(orderedReportEntries, panelEntry.id, direction);
    if (adjacent) selectEntry(adjacent);
  }

  function closePanel() {
    showPanel = false;
    if (typeof window !== 'undefined') {
      const url = new URL(window.location.href);
      url.hash = '';
      history.replaceState(null, '', `${url.pathname}${url.search}`);
    }
  }

  function handlePanelClosed() {
    panelEntry = null;
  }

  function handleCommentChange(entry, annotations) {
    const updated = withRecordingCommentAnnotations(entry, annotations);
    entries = entries.map(item => item.id === entry.id ? updated : item);
    if (panelEntry?.id === entry.id) panelEntry = updated;
  }

  function handleTrimChange(entry, trim) {
    const updated = { ...entry, ...trim };
    entries = entries.map(item => item.id === entry.id ? { ...item, ...trim } : item);
    if (panelEntry?.id === entry.id) panelEntry = updated;
    void refreshPeriodSummary();
  }

  function handleApprovalChange(entry, approved) {
    const updated = { ...entry, approved };
    entries = entries.map(item => item.id === entry.id ? { ...item, approved } : item);
    if (panelEntry?.id === entry.id) panelEntry = updated;
  }

  async function deleteEntry(entry) {
    try {
      const response = await fetch(
        `${PRIVATE_API_BASE}/api/diary/${encodeURIComponent(entry.id)}`,
        { method: 'DELETE' },
      );
      if (!response.ok && response.status !== 204) {
        throw new Error(`${response.status} ${response.statusText}`);
      }
    } catch (error) {
      console.error('Failed to delete entry:', error);
    }
    entries = entries.filter((item) => item.id !== entry.id);
    void refreshPeriodSummary();
    closePanel();
  }

  async function moveEntryToSamples(entry, label, keepInDiary = false) {
    const response = await fetch(
      `${PRIVATE_API_BASE}/api/diary/${encodeURIComponent(entry.id)}/move-to-samples`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ label, keepInDiary }),
      },
    );
    if (!response.ok) {
      let message = `${response.status} ${response.statusText}`;
      try {
        const body = await response.json();
        if (body?.error) message = body.error;
      } catch {
        // Keep the HTTP status text when the response is not JSON.
      }
      throw new Error(message);
    }

    const moveResult = await response.json();

    if (!keepInDiary) {
      entries = entries.filter((item) => item.id !== entry.id);
      void refreshPeriodSummary();
      closePanel();
    } else {
      const updated = withLinkedTrainingSample(entry, moveResult);
      entries = entries.map((item) => item.id === entry.id ? updated : item);
      if (panelEntry?.id === entry.id) panelEntry = updated;
    }
  }

  function countLabel(count, singular, plural = `${singular}s`) {
    return `${count.toLocaleString()} ${count === 1 ? singular : plural}`;
  }

  onMount(async () => {
    const url = new URL(window.location.href);
    printMode = url.searchParams.get('print') === '1';
    dayOrder = url.searchParams.get('days') === 'desc' ? 'desc' : 'asc';
    recordingOrder = url.searchParams.get('recordings') === 'desc' ? 'desc' : 'asc';
    rangeWeeks = url.searchParams.get('weeks') === '2' ? 2 : 1;

    const requestedWeek = url.searchParams.get('week');
    if (requestedWeek && isIsoDate(requestedWeek)) {
      reportWeekStart = startOfIsoWeek(requestedWeek);
    } else {
      try {
        const latestDate = await fetchLatestDiaryDate();
        reportWeekStart = startOfIsoWeek(latestDate || todayInStockholm());
      } catch (error) {
        loadError = error?.message ?? 'Failed to find the latest diary date';
        loading = false;
        return;
      }
    }

    updateReportUrl();
    await loadReport(reportWeekStart);

    const selectedId = window.location.hash.slice(1);
    const selected = entries.find((entry) => entry.id === selectedId && entry.kind === 'audio');
    if (selected) {
      panelEntry = selected;
      showPanel = true;
    }
  });

  onMount(() => {
    let disposed = false;
    void probeEditingAccess().then((available) => {
      if (!disposed) operatorAccess = available;
    });
    return () => { disposed = true; };
  });
</script>

<svelte:head>
  <title>{printMode ? 'Barktown disturbance report' : 'Report · Barktown'}</title>
  <meta name="description" content="Read Barktown recordings as flowing text." />
</svelte:head>

<div class="app" class:print-layout={printMode} style={`--diary-night: ${DIARY_NIGHT_COLOR}`}>
  {#if !embedded}<header class="site-header screen-only">
    <a class="brand" href="/"><img class="brand-logo" src="/logo.png" alt="" width="144" height="144" /> Barktown</a>
    <nav aria-label="Barktown views">
      <a href="/diary">Diary</a>
      <a class="current" aria-current="page" href="/report">Report</a>
      <a href="/training">Training</a>
      {#if operatorAccess}<a href="/quality">Quality</a>{/if}
      <a href="/method">Method</a>
    </nav>
    <GoblinPiStatus />
  </header>{/if}

  <main>
    <header class="report-heading screen-only" class:embedded-heading={embedded}>
      {#if !embedded}
        <div>
          <p class="eyebrow">Sounds as text</p>
          <h1>Report</h1>
        </div>
      {/if}

      {#if reportWeekStart}
        <div class="range-controls" aria-label="Report dates">
          <button disabled={loading} onclick={() => changeReportWeek(-1)}>← Earlier</button>
          <strong>{reportRangeLabel}</strong>
          <button disabled={loading} onclick={() => changeReportWeek(1)}>Later →</button>
          {#if !embedded}
            <button disabled={loading} onclick={showLatestWeek}>Latest</button>
            <button disabled={loading} onclick={showPrintLayout}>🖨️</button>
          {/if}
        </div>
      {/if}
    </header>

    {#if !embedded}<div class="ordering-controls screen-only" aria-label="Report ordering controls">
      <div class="week-count-controls" role="group" aria-label="Report length">
        <button
          class:active={rangeWeeks === 1}
          aria-pressed={rangeWeeks === 1}
          disabled={loading}
          onclick={() => changeRangeWeeks(1)}
        >1 week</button>
        <span aria-hidden="true">|</span>
        <button
          class:active={rangeWeeks === 2}
          aria-pressed={rangeWeeks === 2}
          disabled={loading}
          onclick={() => changeRangeWeeks(2)}
        >2 weeks</button>
      </div>
      <label>
        Days
        <select value={dayOrder} onchange={changeDayOrder}>
          <option value="asc">Earliest on top</option>
          <option value="desc">Latest on top</option>
        </select>
      </label>
      <label>
        Recordings
        <select value={recordingOrder} onchange={changeRecordingOrder}>
          <option value="asc">Earliest on top</option>
          <option value="desc">Latest on top</option>
        </select>
      </label>
    </div>{/if}

    {#if loading}
      <p class="status">Loading recordings…</p>
    {:else if loadError}
      <p class="status error">Could not load diary data: {loadError}</p>
    {:else}
      <header class="print-intro">
        <h1>Barktown disturbance report</h1>
        <p class="print-range">{printRangeLabel}</p>
        <p>
          This report shows {countLabel(reportTotals.disturbances, 'disturbance')} recorded at
          {data.recordingContext.album} {data.recordingContext.location} with microphone direction
          {data.recordingContext.direction}.
        </p>
        <p>
          Darker lines represent louder barks and yaps. Blue background means dogs were barking
          before sunrise/after sunset. No human voices were recorded without permission.
          See interactive version <a href={interactiveHref}>here</a>. See methodology
          <a href="/method">here</a>.
        </p>
      </header>
      <section class="report-totals" aria-label={`${rangeWeeks}-week report totals`}>
        <div class="total-metric">
          <span>Disturbances</span>
          <strong>{reportTotals.disturbances.toLocaleString()}</strong>
        </div>
        <div class="total-metric">
          <span>Time disturbed</span>
          <strong>{formatDisturbedTime(reportTotals.totalDurationSec)}</strong>
        </div>
        <div class="total-metric">
          <span>Barks</span>
          <strong>{reportTotals.barks.toLocaleString()}</strong>
        </div>
      </section>
      <div class="report-days">
        {#each days as day (day.date)}
          <section class="day-section">
            <h2>
              <span>{formatDate(day.date)}</span>
              <small>
                {countLabel(day.summary.disturbances, 'disturbance')}
                <span aria-hidden="true">·</span>
                {formatDisturbedTime(day.summary.totalDurationSec)} disturbed
                <span aria-hidden="true">·</span>
                {countLabel(day.summary.barks, 'bark')}
              </small>
            </h2>

            {#if day.entries.length}
              <p class="recordings">
                {#each day.entries as entry (entry.id)}
                  {@const noteLabels = recordingCommentLabels(entry)}
                  {@const needsPeriod = reportSentenceNeedsPeriod(noteLabels)}
                  <span
                    class="recording-sentence"
                    class:nighttime={isNighttimeRecording(entry.time, sunByDate[day.date])}
                    class:pending-approval={operatorAccess && !entry.approved}
                  >
                    <span class="recording-lead">
                      <button
                        class="play-button"
                        onclick={() => selectEntry(entry)}
                        aria-label={`Play recording from ${formatDate(entry.date)} at ${entry.time}`}
                        title="Open recording"
                      >
                        <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
                          <circle cx="8" cy="8" r="7.5" />
                          <polygon points="6,4.5 12,8 6,11.5" />
                        </svg>
                      </button>
                      <time datetime={entry.datetimeLocal}>{entry.time}</time>
                      <ReportBarcode
                        durationSec={entry.durationSec}
                        trimStartMs={entry.trimStartMs}
                        trimStopMs={entry.trimStopMs}
                        metadata={$hitMetadataById.get(entry.id) ?? null}
                      />
                      {#if noteLabels.length === 0 && needsPeriod}
                        <span class="period" aria-hidden="true">.</span>
                      {/if}
                    </span>
                    {#each noteLabels as label, index}
                      <span class="annotation-label">{label}{index === noteLabels.length - 1 && needsPeriod ? '.' : ''}</span>
                    {/each}
                  </span>{' '}
                {/each}
              </p>
            {:else}
              <p class="no-recordings">No recordings.</p>
            {/if}
          </section>
        {/each}
      </div>
      {#if data.recordingContext.copyright}
        <footer class="print-footer">{data.recordingContext.copyright}</footer>
      {/if}
    {/if}
  </main>
</div>

{#if showPanel && panelEntry}
  <div class="audio-panel screen-only">
    <AudioPlayerPanel
      entry={panelEntry}
      onclose={closePanel}
      onclosed={handlePanelClosed}
      ondelete={deleteEntry}
      onmovesample={moveEntryToSamples}
      oncommentchange={handleCommentChange}
      ontrimchange={handleTrimChange}
      onapprovalchange={handleApprovalChange}
      onprevious={() => selectAdjacentEntry(-1)}
      onnext={() => selectAdjacentEntry(1)}
    />
  </div>
{/if}

<style>
  :global(*, *::before, *::after) { box-sizing: border-box; }
  :global(body) {
    margin: 0;
    font-family: var(--font-body);
    background: #f7f7f5;
    color: #1a1a1a;
  }

  .app { min-height: 100dvh; }

  .print-intro,
  .print-footer { display: none; }

  .site-header {
    position: sticky;
    top: 0;
    z-index: 1000;
    min-height: 48px;
    padding: 0.6rem 1rem;
    display: flex;
    align-items: center;
    gap: 1rem;
    border-bottom: 1px solid #e0e0dc;
    background: #fff;
  }

  .brand {
    color: inherit;
    font-size: var(--font-size-medium);
    font-weight: 700;
    text-decoration: none;
    white-space: nowrap;
  }

  nav {
    margin-left: auto;
    display: flex;
    align-items: center;
    gap: 0.2rem;
  }

  nav a {
    padding: 0.2rem 0.4rem;
    border-radius: 4px;
    color: #555;
    font-family: var(--font-tiny); font-size: var(--font-size-tiny);
    text-decoration: none;
    white-space: nowrap;
  }

  nav a:hover,
  nav a.current { background: #f0f0ec; color: #1a1a1a; }
  nav a.current { font-weight: 650; }

  main {
    width: min(1180px, calc(100% - 2rem));
    margin: 0 auto;
    padding: 2.1rem 0 5rem;
  }

  .report-heading {
    display: flex;
    align-items: flex-end;
    justify-content: space-between;
    gap: 1.5rem;
  }

  .report-heading.embedded-heading {
    align-items: center;
    justify-content: center;
    margin-bottom: 1.1rem;
  }

  .eyebrow {
    margin: 0 0 0.25rem;
    color: #8a3d20;
    font-family: var(--font-tiny); font-size: var(--font-size-tiny);
    font-weight: 750;
    text-transform: uppercase;
  }

  h1 {
    margin: 0;
    font-family: var(--font-heading);
    font-size: var(--font-size-xlarge);
    font-weight: var(--font-heading-weight);
    line-height: 0.95;
  }

  .range-controls {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    color: #555;
    font-size: var(--font-size-small);
  }

  .range-controls strong {
    min-width: 154px;
    color: #333;
    text-align: center;
  }

  .range-controls button,
  select {
    border: 1px solid #d0d0cc;
    border-radius: 4px;
    background: #fff;
    color: #555;
    font: inherit;
  }

  .range-controls button {
    padding: 0.35rem 0.7rem;
    cursor: pointer;
  }

  .range-controls button:hover:not(:disabled) { background: #f0f0ec; color: #1a1a1a; }
  .range-controls button:disabled { cursor: wait; opacity: 0.5; }

  .ordering-controls {
    margin: 2rem 0 1.1rem;
    padding-block: 0.75rem;
    display: flex;
    justify-content: flex-end;
    gap: 1rem;
    border-block: 1px solid #dededa;
  }

  .ordering-controls label {
    display: flex;
    align-items: center;
    gap: 0.45rem;
    color: #777;
    font-family: var(--font-tiny); font-size: var(--font-size-tiny);
    font-weight: 650;
  }

  .week-count-controls {
    margin-right: auto;
    display: flex;
    align-items: center;
    gap: 0.35rem;
    color: #aaa;
  }

  .week-count-controls button {
    padding: 0.2rem 0.35rem;
    border: 0;
    border-radius: 4px;
    background: transparent;
    color: #777;
    cursor: pointer;
    font: inherit;
    font-family: var(--font-tiny); font-size: var(--font-size-tiny);
  }

  .week-count-controls button:hover:not(:disabled) { background: #f0f0ec; color: #1a1a1a; }
  .week-count-controls button.active { color: #1a1a1a; font-weight: 750; }
  .week-count-controls button:disabled { cursor: wait; opacity: 0.5; }

  select {
    padding: 0.25rem 1.8rem 0.25rem 0.45rem;
    cursor: pointer;
    font-family: var(--font-tiny); font-size: var(--font-size-tiny);
  }

  .report-days {
    display: flex;
    flex-direction: column;
    gap: 1.1rem;
  }

  .report-totals {
    margin-bottom: 1.1rem;
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 1px;
    overflow: hidden;
    border: 1px solid #dededa;
    border-radius: 8px;
    background: #dededa;
  }

  .total-metric {
    min-width: 0;
    padding: 0.8rem 1rem;
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 0.75rem;
    background: #fff;
  }

  .total-metric span {
    color: #777;
    font-family: var(--font-tiny); font-size: var(--font-size-tiny);
    font-weight: 650;
  }

  .total-metric strong {
    font-family: var(--font-body);
    font-size: var(--font-size-medium);
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
  }

  .app.print-layout {
    background: #fff;
  }

  .app.print-layout .screen-only,
  .app.print-layout .play-button {
    display: none;
  }

  .app.print-layout main {
    width: min(900px, calc(100% - 2rem));
    padding-top: 2rem;
  }

  .app.print-layout .print-intro {
    display: block;
    margin-bottom: 1.5rem;
  }

  .app.print-layout .print-footer {
    display: block;
    margin-top: 1.5rem;
    color: #777;
    font-family: var(--font-body);
    font-family: var(--font-tiny); font-size: var(--font-size-tiny);
  }

  .app.print-layout .recording-sentence { margin-right: 0; }

  .print-intro h1 {
    margin: 0;
    font-size: var(--font-size-xlarge);
    line-height: 1;
  }

  .print-intro p {
    max-width: 780px;
    margin: 0.75rem 0 0;
    color: #333;
    font-family: var(--font-body);
    font-size: var(--font-size-small);
    line-height: 1.55;
  }

  .print-intro .print-range {
    margin-top: 0.35rem;
    color: #777;
    font-size: var(--font-size-medium);
  }

  .print-intro a { color: #2255bb; }

  .app.print-layout .day-section,
  .app.print-layout .report-totals {
    break-inside: avoid;
  }

  .day-section {
    padding: 1.2rem 1.35rem 1.3rem;
    border: 1px solid #dededa;
    border-radius: 8px;
    background: #fff;
  }

  h2 {
    margin: 0 0 0.75rem;
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 0.8rem 1.5rem;
    border-bottom: 1px solid #ecece8;
    padding-bottom: 0.55rem;
    font-family: var(--font-heading);
    font-size: var(--font-size-medium);
    font-weight: var(--font-heading-weight);
  }

  h2 small {
    display: flex;
    flex-wrap: wrap;
    justify-content: flex-end;
    gap: 0.35rem;
    color: #777;
    font-family: var(--font-body);
    font-family: var(--font-tiny); font-size: var(--font-size-tiny);
    font-weight: 500;
  }

  .recordings,
  .no-recordings {
    margin: 0;
    color: #2d2d2a;
    font-family: var(--font-body);
    font-size: var(--font-size-small);
    line-height: 2;
  }

  .recording-sentence {
    display: inline;
    margin-right: 0.55rem;
  }

  .recording-sentence.pending-approval { opacity: 0.4; }

  .recording-sentence.nighttime {
    padding: 0.08em 0.3em;
    border-radius: 4px;
    background: var(--diary-night);
    box-decoration-break: clone;
    -webkit-box-decoration-break: clone;
  }

  .recording-lead {
    display: inline-flex;
    align-items: center;
    white-space: nowrap;
    vertical-align: middle;
  }

  .play-button {
    width: 16px;
    height: 16px;
    padding: 0;
    flex: 0 0 auto;
    border: 0;
    border-radius: 50%;
    background: transparent;
    cursor: pointer;
    line-height: 0;
    vertical-align: -0.18em;
  }

  .play-button circle { fill: #6f5145; stroke: #6f5145; }
  .play-button polygon { fill: #fff; }
  .play-button:hover circle { fill: #8a3d20; stroke: #8a3d20; }
  .play-button:focus-visible { outline: 2px solid #4a7cdc; outline-offset: 2px; }

  time {
    margin-inline: 0.2rem;
    color: #5d514c;
    font-family: var(--font-monospace);
    font-size: var(--font-size-tiny);
    font-variant-numeric: tabular-nums;
  }

  .annotation-label { margin-left: 0.25rem; }
  .period { margin-left: 0.18rem; }
  .no-recordings { color: #aaa; font-style: italic; }

  .status {
    padding: 5rem 1rem;
    color: #999;
    text-align: center;
  }
  .status.error { color: #c0392b; }

  @media (max-width: 760px) {
    .site-header { align-items: flex-start; flex-wrap: wrap; gap: 0.45rem 0.8rem; }
    nav { width: 100%; order: 3; overflow-x: auto; margin-left: 0; }
    .report-heading { align-items: flex-start; flex-direction: column; }
    .range-controls { width: 100%; justify-content: space-between; }
    .ordering-controls { justify-content: flex-start; flex-wrap: wrap; }
    h2 { align-items: flex-start; flex-direction: column; }
    h2 small { justify-content: flex-start; }
  }

  @media (max-width: 440px) {
    main { width: min(100% - 1rem, 1180px); padding-top: 1.4rem; }
    .day-section { padding-inline: 0.75rem; }
    .range-controls { flex-wrap: wrap; }
    .range-controls strong { order: -1; width: 100%; }
    .report-totals { grid-template-columns: 1fr; }
  }

  @page { margin: 14mm; }

  @media print {
    :global(body) { background: #fff; }

    .screen-only,
    .play-button { display: none !important; }

    .print-intro {
      display: block !important;
      margin-bottom: 1.2rem;
    }

    .print-footer {
      display: block !important;
      margin-top: 1.2rem;
    }

    main {
      width: auto;
      padding: 0;
    }

    .report-days { gap: 0.6rem; }
    .recording-sentence { margin-right: 0; }
    .report-totals,
    .day-section { break-inside: avoid; }
    .day-section { border-color: #aaa; }
  }
</style>
