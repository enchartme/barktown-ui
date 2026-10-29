<script>
  import { onMount } from 'svelte';
  import GoblinPiStatus from '$lib/components/GoblinPiStatus.svelte';
  import { probeEditingAccess } from '$lib/editing-access.js';
  import {
    dailyDataQuality,
    dataQualityReasons,
    fetchDataQuality,
    summarizeDataQuality,
  } from '$lib/data-quality.js';

  const RANGE_OPTIONS = [
    { label: '7 days', days: 7 },
    { label: '30 days', days: 30 },
    { label: '90 days', days: 90 },
    { label: 'All', days: null },
  ];
  const TABLE_LIMIT = 250;

  let rows = $state([]);
  let loading = $state(true);
  let loadError = $state('');
  let rangeDays = $state(30);
  let rowMode = $state('affected');
  let operatorAccess = $state(false);

  const summary = $derived(summarizeDataQuality(rows));
  const daily = $derived(dailyDataQuality(rows));
  const reasons = $derived(dataQualityReasons(rows));
  const maxDailyRecordings = $derived(Math.max(1, ...daily.map((day) => day.recordings)));
  const maxReasonCount = $derived(Math.max(1, ...reasons.map((reason) => reason.count)));
  const filteredRows = $derived(
    (rowMode === 'affected' ? rows.filter((row) => row.xrunCount > 0) : rows).slice(0, TABLE_LIMIT),
  );
  const filteredTotal = $derived(rowMode === 'affected' ? summary.affected : summary.recordings);

  function todayInStockholm() {
    return new Intl.DateTimeFormat('sv-SE', {
      timeZone: 'Europe/Stockholm',
      year: 'numeric', month: '2-digit', day: '2-digit',
    }).format(new Date());
  }

  function subtractDays(isoDate, days) {
    const date = new Date(`${isoDate}T12:00:00Z`);
    date.setUTCDate(date.getUTCDate() - days);
    return date.toISOString().slice(0, 10);
  }

  async function loadQuality() {
    loading = true;
    loadError = '';
    const endDate = todayInStockholm();
    const startDate = rangeDays == null ? undefined : subtractDays(endDate, rangeDays - 1);
    try {
      rows = await fetchDataQuality({
        startDate,
        endDate: rangeDays == null ? undefined : endDate,
        signal: AbortSignal.timeout(15000),
      });
    } catch (error) {
      rows = [];
      loadError = error?.message ?? 'Failed to load signal quality';
    } finally {
      loading = false;
    }
  }

  function chooseRange(days) {
    if (rangeDays === days || loading) return;
    rangeDays = days;
    void loadQuality();
  }

  function cleanRateLabel() {
    return summary.cleanRate == null ? '—' : `${(summary.cleanRate * 100).toFixed(1)}%`;
  }

  function formatTimestamp(value) {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return value ?? '—';
    return new Intl.DateTimeFormat('sv-SE', {
      timeZone: 'Europe/Stockholm',
      year: 'numeric', month: 'short', day: 'numeric',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    }).format(date);
  }

  function formatDuration(seconds) {
    if (!Number.isFinite(seconds)) return '—';
    if (seconds < 60) return `${seconds.toFixed(1)} s`;
    return `${Math.floor(seconds / 60)}m ${Math.round(seconds % 60)}s`;
  }

  function reasonLabel(row) {
    const labels = [];
    if (row.inputOverflowCount) labels.push(`${row.inputOverflowCount} input overflow`);
    if (row.inputUnderflowCount) labels.push(`${row.inputUnderflowCount} input underflow`);
    if (row.outputOverflowCount) labels.push(`${row.outputOverflowCount} output overflow`);
    if (row.outputUnderflowCount) labels.push(`${row.outputUnderflowCount} output underflow`);
    if (row.otherXrunCount) labels.push(`${row.otherXrunCount} other`);
    return labels.join(' · ') || 'No XRUNs';
  }

  function shortDate(value) {
    return new Intl.DateTimeFormat('sv-SE', { month: 'short', day: 'numeric' })
      .format(new Date(`${value}T12:00:00Z`));
  }

  onMount(() => {
    void loadQuality();
    let disposed = false;
    void probeEditingAccess().then((available) => {
      if (!disposed) operatorAccess = available;
    });
    return () => { disposed = true; };
  });
</script>

<svelte:head>
  <title>Signal quality · Barktown</title>
  <meta name="description" content="Recording continuity and XRUN audit for Barktown operators." />
</svelte:head>

<div class="app">
  <header class="site-header">
    <a class="brand" href="/"><img class="brand-logo" src="/logo.png" alt="" width="144" height="144" /> Barktown</a>
    <nav aria-label="Barktown views">
      <a href="/diary">Diary</a>
      <a href="/report">Report</a>
      {#if operatorAccess}<a href="/training">Training</a>{/if}
      {#if operatorAccess}<a class="current" aria-current="page" href="/quality">Quality</a>{/if}
      <a href="/method">Method</a>
    </nav>
    <GoblinPiStatus />
  </header>

  <main>
    <header class="page-heading">
      <div>
        <p class="eyebrow">Capture continuity</p>
        <h1>Signal quality</h1>
        <p class="lede">XRUN incidents recorded inside each uploaded clip. One incident marks continuity as degraded; it does not reveal how many samples were lost.</p>
      </div>
      <div class="range-tabs" role="group" aria-label="Quality period">
        {#each RANGE_OPTIONS as option}
          <button
            class:active={rangeDays === option.days}
            aria-pressed={rangeDays === option.days}
            disabled={loading}
            onclick={() => chooseRange(option.days)}
          >{option.label}</button>
        {/each}
      </div>
    </header>

    {#if loadError}
      <div class="notice error" role="alert">Could not load signal quality: {loadError}</div>
    {:else if loading}
      <div class="notice">Loading recording quality…</div>
    {:else if rows.length === 0}
      <div class="notice empty">
        <strong>No quality records in this period.</strong>
        <span>New automatic recordings will appear after Goblin and barktown-server are deployed with data-quality reporting.</span>
      </div>
    {:else}
      <section class="summary-grid" aria-label="Quality summary">
        <article>
          <span>Clean recordings</span>
          <strong>{cleanRateLabel()}</strong>
          <small>{summary.clean.toLocaleString()} of {summary.recordings.toLocaleString()}</small>
        </article>
        <article class:warn={summary.affected > 0}>
          <span>Affected recordings</span>
          <strong>{summary.affected.toLocaleString()}</strong>
          <small>{summary.recordings ? ((summary.affected / summary.recordings) * 100).toFixed(1) : 0}% of recordings</small>
        </article>
        <article class:warn={summary.totalXruns > 0}>
          <span>XRUN incidents</span>
          <strong>{summary.totalXruns.toLocaleString()}</strong>
          <small>inside recording windows</small>
        </article>
        <article>
          <span>Recordings measured</span>
          <strong>{summary.recordings.toLocaleString()}</strong>
          <small>{rangeDays == null ? 'all available records' : `last ${rangeDays} days`}</small>
        </article>
      </section>

      <section class="visual-grid">
        <article class="panel timeline-panel">
          <header>
            <div><p class="panel-kicker">Daily outcome</p><h2>Recording continuity</h2></div>
            <div class="legend"><span><i class="clean-dot"></i>Clean</span><span><i class="affected-dot"></i>XRUN</span></div>
          </header>
          <div class="chart-wrap">
            <svg class="daily-chart" viewBox="0 0 1000 260" role="img" aria-label="Clean and XRUN-affected recordings by day">
              <line x1="38" y1="218" x2="980" y2="218" class="axis" />
              {#each daily as day, index}
                {@const slot = 942 / Math.max(1, daily.length)}
                {@const width = Math.max(3, Math.min(28, slot - 3))}
                {@const x = 38 + index * slot + (slot - width) / 2}
                {@const scale = 172 / maxDailyRecordings}
                {@const cleanHeight = day.clean * scale}
                {@const affectedHeight = day.affected * scale}
                <g>
                  <title>{day.date}: {day.clean} clean, {day.affected} affected, {day.xruns} XRUNs</title>
                  <rect x={x} y={218 - cleanHeight} width={width} height={cleanHeight} class="bar-clean" />
                  <rect x={x} y={218 - cleanHeight - affectedHeight} width={width} height={affectedHeight} class="bar-affected" />
                </g>
              {/each}
              {#if daily.length > 0}
                <text x="38" y="247" text-anchor="start">{shortDate(daily[0].date)}</text>
                {#if daily.length > 2}
                  <text x="509" y="247" text-anchor="middle">{shortDate(daily[Math.floor(daily.length / 2)].date)}</text>
                {/if}
                <text x="980" y="247" text-anchor="end">{shortDate(daily.at(-1).date)}</text>
              {/if}
            </svg>
          </div>
        </article>

        <article class="panel reasons-panel">
          <header><div><p class="panel-kicker">Incident type</p><h2>XRUN reasons</h2></div></header>
          <div class="reason-list">
            {#each reasons as reason}
              <div class="reason-row">
                <div><span>{reason.label}</span><strong>{reason.count.toLocaleString()}</strong></div>
                <div class="reason-track"><span style={`width: ${(reason.count / maxReasonCount) * 100}%`}></span></div>
              </div>
            {/each}
          </div>
          <p class="footnote">Reason counts can exceed incident totals when PortAudio reports more than one flag on the same callback.</p>
        </article>
      </section>

      <section class="panel records-panel">
        <header class="records-header">
          <div>
            <p class="panel-kicker">Recording audit</p>
            <h2>{rowMode === 'affected' ? 'Affected recordings' : 'All recordings'}</h2>
          </div>
          <div class="row-tabs" role="group" aria-label="Recording filter">
            <button class:active={rowMode === 'affected'} onclick={() => (rowMode = 'affected')}>Affected</button>
            <button class:active={rowMode === 'all'} onclick={() => (rowMode = 'all')}>All</button>
          </div>
        </header>

        {#if filteredRows.length === 0}
          <div class="clean-message">No recordings with XRUNs in this period.</div>
        {:else}
          <div class="table-wrap">
            <table>
              <thead><tr><th>Recorded</th><th>Record</th><th>Duration</th><th>XRUNs</th><th>Reason</th><th>Result</th></tr></thead>
              <tbody>
                {#each filteredRows as row}
                  <tr class:affected={row.xrunCount > 0}>
                    <td>{formatTimestamp(row.recordingStartedAt)}</td>
                    <td class="record-cell">
                      <code>{row.recordId}</code>
                      {#if row.errors?.length}
                        <details>
                          <summary>Event details</summary>
                          <ol>
                            {#each row.errors as error}
                              <li><strong>+{(error.offset_ms / 1000).toFixed(3)}s</strong> {error.reasons.join(', ')}{error.detail ? ` — ${error.detail}` : ''}</li>
                            {/each}
                          </ol>
                          {#if row.errorsTruncated}<p>{row.errorsTruncated} additional events omitted.</p>{/if}
                        </details>
                      {/if}
                    </td>
                    <td>{formatDuration(row.durationS)}</td>
                    <td class="xrun-count">{row.xrunCount.toLocaleString()}</td>
                    <td>{reasonLabel(row)}</td>
                    <td><span class:bad={row.xrunCount > 0} class="status-pill">{row.xrunCount > 0 ? 'Degraded' : 'Clean'}</span></td>
                  </tr>
                {/each}
              </tbody>
            </table>
          </div>
          {#if filteredTotal > TABLE_LIMIT}<p class="table-note">Showing the newest {TABLE_LIMIT} of {filteredTotal.toLocaleString()} matching recordings.</p>{/if}
        {/if}
      </section>
    {/if}
  </main>
</div>

<style>
  :global(*, *::before, *::after) { box-sizing: border-box; }
  :global(body) { margin: 0; background: #f7f7f5; color: #1a1a1a; }
  .app { min-height: 100dvh; }
  .site-header {
    position: sticky; top: 0; z-index: 1000; min-height: 48px;
    padding: 0.6rem 1rem; display: flex; align-items: center;
    gap: 1rem; border-bottom: 1px solid #e0e0dc; background: #fff;
  }
  .brand { color: inherit; font-size: var(--font-size-medium); font-weight: 700; text-decoration: none; white-space: nowrap; }
  .site-header nav { margin-left: auto; display: flex; align-items: center; gap: 0.2rem; }
  .site-header nav a {
    padding: 0.2rem 0.4rem; border-radius: 4px; color: #555;
    font-family: var(--font-tiny); font-size: var(--font-size-tiny);
    text-decoration: none; white-space: nowrap;
  }
  .site-header nav a:hover, .site-header nav a.current { background: #f0f0ec; color: #1a1a1a; }
  .site-header nav a.current { font-weight: 650; }
  main { width: min(1440px, 100%); margin: 0 auto; padding: 2.2rem 1.4rem 4rem; }
  .page-heading { display: flex; align-items: end; justify-content: space-between; gap: 2rem; margin-bottom: 1.6rem; }
  .eyebrow, .panel-kicker { margin: 0 0 0.35rem; color: #777; font-family: var(--font-tiny); font-size: var(--font-size-tiny); font-weight: 700; letter-spacing: 0.08em; text-transform: uppercase; }
  h1 { margin: 0; font-size: var(--font-size-xlarge); }
  h2 { margin: 0; font-size: var(--font-size-large); }
  .lede { max-width: 760px; margin: 0.65rem 0 0; color: #666; line-height: 1.5; }
  button { border: 1px solid #cfcec7; background: #fff; color: #444; cursor: pointer; }
  button:hover { border-color: #8f8e87; }
  button:disabled { cursor: wait; opacity: 0.6; }
  .range-tabs, .row-tabs { display: flex; gap: 0.25rem; padding: 0.2rem; border: 1px solid #d8d7d0; border-radius: 7px; background: #eeede8; }
  .range-tabs button, .row-tabs button { padding: 0.45rem 0.75rem; border: 0; border-radius: 5px; background: transparent; }
  .range-tabs button.active, .row-tabs button.active { background: #fff; color: #111; box-shadow: 0 1px 4px rgb(0 0 0 / 10%); font-weight: 700; }
  .notice { padding: 2rem; border: 1px solid #dddcd6; border-radius: 9px; background: #fff; color: #666; }
  .notice.empty { display: flex; flex-direction: column; gap: 0.45rem; }
  .notice.error { border-color: #d9aaa2; color: #8b2f20; }
  .summary-grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 0.8rem; margin-bottom: 0.8rem; }
  .summary-grid article, .panel { border: 1px solid #dddcd6; border-radius: 9px; background: #fff; }
  .summary-grid article { min-height: 132px; padding: 1rem; display: flex; flex-direction: column; }
  .summary-grid span { color: #686863; }
  .summary-grid strong { margin-top: auto; font-family: var(--font-data); font-size: 2.1rem; font-weight: 500; }
  .summary-grid small { color: #85857f; }
  .summary-grid article.warn strong { color: #b54835; }
  .visual-grid { display: grid; grid-template-columns: minmax(0, 2fr) minmax(300px, 1fr); gap: 0.8rem; margin-bottom: 0.8rem; }
  .panel { padding: 1.1rem; }
  .panel > header { display: flex; align-items: start; justify-content: space-between; gap: 1rem; margin-bottom: 1rem; }
  .legend { display: flex; gap: 0.8rem; color: #73736e; font-size: var(--font-size-tiny); }
  .legend span { display: flex; align-items: center; gap: 0.3rem; }
  .legend i { width: 9px; height: 9px; border-radius: 2px; }
  .clean-dot { background: #83a78b; } .affected-dot { background: #c75d49; }
  .chart-wrap { width: 100%; overflow: hidden; }
  .daily-chart { display: block; width: 100%; height: 260px; }
  .daily-chart text { fill: #777; font-family: var(--font-tiny); font-size: 18px; }
  .axis { stroke: #d8d7d0; stroke-width: 1; }
  .bar-clean { fill: #83a78b; } .bar-affected { fill: #c75d49; }
  .reason-list { display: flex; flex-direction: column; gap: 1rem; }
  .reason-row > div:first-child { display: flex; justify-content: space-between; gap: 1rem; margin-bottom: 0.28rem; }
  .reason-row strong { font-family: var(--font-data); font-weight: 500; }
  .reason-track { height: 8px; overflow: hidden; border-radius: 99px; background: #ecebe6; }
  .reason-track span { display: block; height: 100%; min-width: 0; border-radius: inherit; background: #c75d49; }
  .footnote, .table-note { margin: 1rem 0 0; color: #7d7d77; font-size: var(--font-size-tiny); line-height: 1.45; }
  .records-panel { padding: 0; overflow: hidden; }
  .records-header { margin: 0 !important; padding: 1.1rem; border-bottom: 1px solid #e3e2dc; }
  .table-wrap { overflow-x: auto; }
  table { width: 100%; border-collapse: collapse; font-size: 0.94rem; }
  th { padding: 0.65rem 0.8rem; background: #f5f4f0; color: #74746f; font-family: var(--font-tiny); font-size: var(--font-size-tiny); letter-spacing: 0.03em; text-align: left; text-transform: uppercase; }
  td { padding: 0.8rem; border-top: 1px solid #ecebe6; vertical-align: top; }
  tr.affected { background: #fffaf8; }
  code { font-family: var(--font-monospace); font-size: 0.78rem; }
  .record-cell { min-width: 270px; }
  details { margin-top: 0.35rem; color: #6f6f69; font-size: var(--font-size-tiny); }
  details summary { cursor: pointer; }
  details ol { margin: 0.45rem 0 0; padding-left: 1.2rem; }
  details li + li { margin-top: 0.3rem; }
  .xrun-count { font-family: var(--font-data); font-size: 1.1rem; }
  .status-pill { display: inline-block; padding: 0.18rem 0.48rem; border-radius: 99px; background: #e1eee4; color: #346541; font-family: var(--font-tiny); font-size: var(--font-size-tiny); font-weight: 700; }
  .status-pill.bad { background: #f5dcd7; color: #963e2e; }
  .clean-message { padding: 2rem 1.1rem; color: #496a51; }
  .table-note { padding: 0 1.1rem 1.1rem; }

  @media (max-width: 900px) {
    .page-heading { align-items: start; flex-direction: column; }
    .summary-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
    .visual-grid { grid-template-columns: 1fr; }
  }
  @media (max-width: 760px) {
    .site-header { align-items: flex-start; flex-wrap: wrap; gap: 0.45rem 0.8rem; }
    .site-header nav { width: 100%; order: 3; overflow-x: auto; margin-left: 0; }
  }
  @media (max-width: 560px) {
    main { padding-inline: 0.8rem; }
    .summary-grid { grid-template-columns: 1fr; }
    .summary-grid article { min-height: 112px; }
    .range-tabs { width: 100%; overflow-x: auto; }
    .range-tabs button { flex: 1; white-space: nowrap; }
  }
</style>
