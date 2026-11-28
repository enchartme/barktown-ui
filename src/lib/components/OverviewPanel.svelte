<script>
  import { formatNumber } from '$lib/number-format.js';
  import { max } from 'd3-array';

  /** @type {{ entries: import('$lib/types').Entry[] }} */
  let { entries } = $props();

  // ── Controls ──────────────────────────────────────────────────────────────
  /** @type {'day' | 'week' | 'month'} */
  let binning   = $state('day');
  /** @type {'severe' | 'prevalent'} */
  let colorMode = $state('severe');

  // ── Colour rules (mirrors DiaryEntry.svelte labelBase) ────────────────────
  const COLOR_RULES = [
    { test: (l) => l.includes('shot') || l.includes('shooting'), color: '#51211d' },
    { test: (l) => l.includes('barkattack') || l.includes('bark bark bark'), color: '#ff4c4c' },
    { test: (l) => l.includes('yapattack')  || l.includes('yap yap yap'),   color: '#420f8d' },
    { test: (l) => l.includes('bark bark'),  color: '#d9665d' },
    { test: (l) => l.includes('yap yap'),    color: '#593391' },
    { test: (l) => l.includes('bark'),       color: '#b0766e' },
    { test: (l) => l.includes('yap'),        color: '#726389' },
  ];
  const DEFAULT_COLOR = '#888888';

  /** First rule that any entry in the bin matches (most severe). */
  function severestColor(binEntries) {
    for (const rule of COLOR_RULES) {
      if (binEntries.some(e => rule.test((e.label ?? '').toLowerCase()))) return rule.color;
    }
    return DEFAULT_COLOR;
  }

  /** Rule with the highest match count across entries in the bin (most prevalent). */
  function prevalentColor(binEntries) {
    let bestColor = DEFAULT_COLOR;
    let bestCount = 0;
    for (const rule of COLOR_RULES) {
      const n = binEntries.filter(e => rule.test((e.label ?? '').toLowerCase())).length;
      if (n > bestCount) { bestCount = n; bestColor = rule.color; }
    }
    return bestColor;
  }

  function binColor(binEntries) {
    return colorMode === 'severe' ? severestColor(binEntries) : prevalentColor(binEntries);
  }

  // ── SVG dimensions ────────────────────────────────────────────────────────
  const CHART_H = 100;

  // ── Helpers ───────────────────────────────────────────────────────────────

  /** 0-based day-of-year for a Date. */
  function doy(d) {
    const start = new Date(d.getFullYear(), 0, 0);
    return Math.floor((d - start) / 86_400_000) - 1; // 0-indexed
  }

  /** Group entries from one year into bins; returns { bars, nBins }. */
  function buildBars(year, yEntries) {
    const isLeap     = new Date(+year, 1, 29).getDate() === 29;
    const daysInYear = isLeap ? 366 : 365;

    /** @type {Map<number, import('$lib/types').Entry[]>} */
    const bins = new Map();

    function binIndex(e) {
      const d = new Date(e.date + 'T12:00:00');
      if (binning === 'month') return d.getMonth();               // 0..11
      if (binning === 'week')  return Math.floor(doy(d) / 7);    // 0..52
      return doy(d);                                              // 0..364/365
    }

    for (const e of yEntries) {
      const i = binIndex(e);
      if (!bins.has(i)) bins.set(i, []);
      bins.get(i).push(e);
    }

    const nBins =
      binning === 'month' ? 12 :
      binning === 'week'  ? Math.ceil(daysInYear / 7) :
      daysInYear;

    const bars = [];
    for (let i = 0; i < nBins; i++) {
      const binEntries = bins.get(i) ?? [];
      const count      = binEntries.length;
      const color      = count > 0 ? binColor(binEntries) : null;

      // Human-readable tooltip label
      let label;
      if (binning === 'month') {
        label = new Date(+year, i, 1).toLocaleString(undefined, { month: 'long' });
      } else if (binning === 'week') {
        const startD = new Date(+year, 0, i * 7 + 1);
        label = `Week of ${startD.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}`;
      } else {
        const d = new Date(+year, 0, i + 1);
        label = d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
      }

      bars.push({ i, count, color, label });
    }

    return { bars, nBins };
  }

  // ── Data derivation ───────────────────────────────────────────────────────
  const yearRows = $derived(() => {
    const byYear = new Map();
    for (const e of entries) {
      const y = e.date.slice(0, 4);
      if (!byYear.has(y)) byYear.set(y, []);
      byYear.get(y).push(e);
    }

    const rows = [];
    for (const [year, yEntries] of [...byYear.entries()].sort((a, b) => b[0].localeCompare(a[0]))) {
      const { bars, nBins } = buildBars(year, yEntries);
      rows.push({ year, bars, nBins });
    }

    // Shared Y domain across all years so bars are proportional.
    const globalMax = max(rows.flatMap(r => r.bars), b => b.count) ?? 1;
    for (const row of rows) row.maxCount = globalMax;

    return rows;
  });

  const BAR_GAP = 0.1; // viewBox units gap on each side of a bar

  const globalMax = $derived(() => yearRows()[0]?.maxCount ?? 1);
</script>

<div class="overview">
  {#each yearRows() as row, i (row.year)}
    <div class="year-row">
      <div class="year-label">{row.year}</div>
      <div class="year-chart-wrap">
        {#if i === 0}<span class="y-max-label">{globalMax()} events max</span>{/if}
        <svg
          class="year-chart"
          viewBox="0 0 {row.nBins} {CHART_H}"
          preserveAspectRatio="none"
          role="img"
          aria-label="Event counts for {row.year}"
        >
          {#each row.bars as bar (bar.i)}
            {#if bar.count > 0}
              <rect
                x={bar.i + BAR_GAP}
                y={CHART_H - (bar.count / row.maxCount) * CHART_H}
                width={1 - BAR_GAP * 2}
                height={(bar.count / row.maxCount) * CHART_H}
                fill={bar.color}
              >
                <title>{bar.label}: {formatNumber(bar.count)} event{bar.count !== 1 ? 's' : ''}</title>
              </rect>
            {/if}
          {/each}
        </svg>
      </div>
    </div>
  {/each}
  <p class="overview-caption">
    Number of events per
    <span class="btn-group">
      {#each ['day', 'week', 'month'] as b (b)}
        <button class="ctrl-btn" class:active={binning === b} onclick={() => binning = b}>{b}</button>
      {/each}
    </span>,
    colored by
    <span class="btn-group">
      {#each [['severe', 'most severe'], ['prevalent', 'most prevalent']] as [val, lbl] (val)}
        <button class="ctrl-btn" class:active={colorMode === val} onclick={() => colorMode = val}>{lbl}</button>
      {/each}
    </span>
  </p>
</div>

<style>
  .overview {
    border-bottom: 2px solid #d0d0cc;
    background: #fafaf8;
    padding: 0.5rem 0;
  }

  /* ── Controls ── */
  .overview-controls {
    display: flex;
    gap: 0.75rem;
    padding: 4px 14px 6px;
    flex-wrap: wrap;
  }

  .ctrl-group {
    display: flex;
    gap: 0.2rem;
  }

  /* ── Year row ── */
  .year-row {
    display: flex;
    align-items: stretch;
    border-bottom: 1px solid #e8e8e4;
  }
  .year-row:last-child { border-bottom: none; }

  .year-label {
    flex-shrink: 0;
    width: 108px;
    padding: 6px 10px 6px 14px;
    border-right: 1px solid #ccc;
    font-size: var(--font-size-small);
    font-weight: 700;
    color: #1a1a1a;
    display: flex;
    align-items: center;
  }

  .year-chart-wrap {
    flex: 1;
    min-width: 0;
    padding: 6px 0 0;
    position: relative;
  }

  .y-max-label {
    position: absolute;
    top: 6px;
    left: 6px;
    font-family: var(--font-tiny); font-size: var(--font-size-tiny);
    color: #1a1a1a;
    pointer-events: none;
    line-height: 1;
  }

  .year-chart {
    display: block;
    width: 100%;
    height: 72px;
  }

  /* ── Caption ── */
  .overview-caption {
    margin: 0;
    padding: 4px 14px 6px;
    font-family: var(--font-tiny); font-size: var(--font-size-tiny);
    color: #1a1a1a;
    line-height: 2;
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.3rem;
  }

  .btn-group {
    display: inline-flex;
    gap: 0.25rem;
    align-items: center;
  }

  .ctrl-btn {
    background: none;
    border: 1px solid #d0d0cc;
    border-radius: 4px;
    padding: 0.1rem 0.4rem;
    font-family: var(--font-tiny); font-size: var(--font-size-tiny);
    cursor: pointer;
    color: #666;
    vertical-align: baseline;
    transition: background 0.1s, color 0.1s;
  }
  .ctrl-btn:hover  { background: #f0f0ec; }
  .ctrl-btn.active { background: #1a1a1a; color: #fff; border-color: #1a1a1a; }

  /* ── Mobile ── */
  @media (max-width: 520px) {
    .year-label { width: 56px; padding: 6px 4px 6px 8px; font-family: var(--font-tiny); font-size: var(--font-size-tiny); }
  }
</style>
