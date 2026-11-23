<script>
  import ReanalyzeDayButton from './ReanalyzeDayButton.svelte';
  import { assignLanes, parseTimeToMinutes, formatDate } from '$lib/utils.js';
  import { DIARY_DAY_COLOR, DIARY_NIGHT_COLOR, sunTimeToLocalMinutes } from '$lib/sun-time.js';
  import { diaryTrimBounds } from '$lib/diary-trim.js';
  import DiaryEntry from './DiaryEntry.svelte';

  /**
   * @type {{
   *   date: string;
   *   entries: import('$lib/types').Entry[];
   *   operatorAccess?: boolean;
   *   selectedId: string | null;
   *   onselect: (entry: import('$lib/types').Entry) => void;
   * }}
   */
  let { date, entries, selectedId, onselect, sunEntry = null, operatorAccess = false } = $props();

  // ── Layout constants ───────────────────────────────────────────────────────
  const RULER_HEIGHT     = 22;  // px – the hour-tick ruler row
  // All entries are now flag/pins – vertical collision step is just the tag
  // height (~18 px) so colliding pins stack tightly without wasting space.
  const FLAG_LANE_HEIGHT = 18;  // px – vertical step between colliding pin lanes
  // Slot display minimum (keeps pins clickable), separate from collision span.
  const MIN_SLOT_MINS    = 5;   // minutes
  // Estimated visual width of a pin tag in pixels (time chip + typical label).
  const TAG_PX           = 80;
  // Breathing room above the first lane and below the last.
  const LANE_MARGIN      = 4;   // px

  // ── Domain ────────────────────────────────────────────────────────────────
  // Every row always contains the complete day. The parent changes the pixel
  // width and scroll position to make the selected time range fill its view.
  const domainStartMin = 0;
  const domainEndMin = 24 * 60;
  const domainWidthMin = domainEndMin - domainStartMin;

  // ── Track width measurement (for responsive collision span) ───────────────
  let trackWidth = $state(0);  // bound below with bind:clientWidth

  // How many minutes does one TAG_PX span across the visible domain?
  const labelSpanMins = $derived(
    trackWidth > 0 ? Math.ceil((TAG_PX / trackWidth) * domainWidthMin) : 60
  );

  // ── Lane assignment ────────────────────────────────────────────────────────
  const laned            = $derived(assignLanes(entries, labelSpanMins));
  const entriesWithLanes = $derived(laned.entriesWithLanes);
  const laneCount        = $derived(laned.laneCount);

  // Track height grows with lane count.
  const trackHeight = $derived(LANE_MARGIN + Math.max(2, laneCount) * FLAG_LANE_HEIGHT + LANE_MARGIN + 2);

  // ── Ruler ticks ────────────────────────────────────────────────────────────
  // Every 2 hours across the complete day, including the 24:00 boundary.
  const ticks = Array.from({ length: 13 }, (_, i) => i * 2);

  // ── Position helpers (all in %) ──────────────────────────────────────────

  /**
   * Left offset as a % of the visible domain.
   */
  function entryLeftPct(entry) {
    return ((parseTimeToMinutes(entry.time) - domainStartMin) / domainWidthMin) * 100;
  }

  /**
   * Width as a % of the visible domain, min-clamped to MIN_SLOT_MINS.
   */
  function entryWidthPct(entry) {
    const minPct = (MIN_SLOT_MINS / domainWidthMin) * 100;
    return Math.max(minPct, (diaryTrimBounds(entry).durationSec / 60 / domainWidthMin) * 100);
  }

  /**
   * Top offset (px) for an entry based on its assigned lane.
   * All entries are now pins so we use the compact FLAG_LANE_HEIGHT step.
   */
  function entryTop(laneIndex) {
    const extra = laneCount === 1 ? FLAG_LANE_HEIGHT / 2 : 0;
    return LANE_MARGIN + extra + laneIndex * FLAG_LANE_HEIGHT;
  }

  // ── Current-time indicator (Stockholm) ──────────────────────────────────
  const STOCKHOLM_TZ = 'Europe/Stockholm';

  function getStockholmNow() {
    const now = new Date();
    const parts = new Intl.DateTimeFormat('sv-SE', {
      timeZone: STOCKHOLM_TZ,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit',
    }).formatToParts(now);
    const get = (type) => parts.find(p => p.type === type)?.value ?? '';
    return {
      date: `${get('year')}-${get('month')}-${get('day')}`,
      minutes: parseInt(get('hour')) * 60 + parseInt(get('minute')),
    };
  }

  /** Minutes-since-midnight in Stockholm, or null when this row is not today. */
  let nowMinutes = $state(null);

  $effect(() => {
    const update = () => {
      const { date: todayDate, minutes } = getStockholmNow();
      nowMinutes = date === todayDate ? minutes : null;
    };
    update();
    const id = setInterval(update, 60_000);
    return () => clearInterval(id);
  });

  /** Left offset (%) for the now-line, or null if out of domain / not today. */
  const nowLeftPct = $derived(
    nowMinutes !== null && nowMinutes >= domainStartMin && nowMinutes <= domainEndMin
      ? ((nowMinutes - domainStartMin) / domainWidthMin) * 100
      : null
  );

  // Formatted date label (used in title attribute)
  const dateLabel    = $derived(formatDate(date));
  // Month + day only, e.g. "Jan 7" (for mobile middle row)
  const dateDayM     = $derived(dateLabel.split(',')[1]?.trim() ?? '');
  // Four-digit year (for mobile third row)
  const dateYear = $derived(date.slice(0, 4));

  // ── Sunrise / sunset background gradient ────────────────────────────────

  /**
   * CSS linear-gradient string for the track background, or plain white if
   * no sun data is available for this date. Sun times are clamped to the
   * visible domain so the gradient always covers the full track width.
   */
  const trackBackground = $derived(() => {
    const sr = sunTimeToLocalMinutes(sunEntry?.sunrise);
    const ss = sunTimeToLocalMinutes(sunEntry?.sunset);
    if (sr === null || ss === null) return '#fff';
    const clamp = (v) => Math.max(0, Math.min(100, v));
    const srPct = clamp(((sr - domainStartMin) / domainWidthMin) * 100).toFixed(3);
    const ssPct = clamp(((ss - domainStartMin) / domainWidthMin) * 100).toFixed(3);
    return [
      `linear-gradient(to right,`,
      `  ${DIARY_NIGHT_COLOR} 0%,`,
      `  ${DIARY_NIGHT_COLOR} ${srPct}%,`,
      `  ${DIARY_DAY_COLOR}   ${srPct}%,`,
      `  ${DIARY_DAY_COLOR}   ${ssPct}%,`,
      `  ${DIARY_NIGHT_COLOR} ${ssPct}%,`,
      `  ${DIARY_NIGHT_COLOR} 100%)`,
    ].join(' ');
  });
</script>

<div class="day-row">
  <!-- Date label column (fixed width, sticky on mobile) -->
  <div class="date-label" title={date}>
    <span class="date-weekday">{dateLabel.split(',')[0]}</span>
    <span class="date-rest">{dateLabel.split(',').slice(1).join(',').trim()}</span>
    <span class="date-daym">{dateDayM}</span>
    <span class="date-year-mobile">{dateYear}</span>
    {#if operatorAccess}<ReanalyzeDayButton {date} disabled={!entries.some(e => e.reanalyzable)} />{/if}
  </div>

  <!-- Track: fills remaining row width, no horizontal scroll -->
  <div
    class="track"
    bind:clientWidth={trackWidth}
  >
    <!-- Day/night gradient background, fills actual rendered height -->
    <div class="track-bg" style="background: {trackBackground()};"></div>

    <!-- Content wrapper: establishes min-height for entry slots -->
    <div class="track-inner" style="min-height: {trackHeight}px;">

    <!-- Hour tick lines (% positioned relative to domain) -->
    {#each ticks as hour (hour)}
      <div
        class="tick"
        class:tick-midnight={hour === 0}
        class:tick-day-end={hour === 24}
        style="left: {((hour * 60 - domainStartMin) / domainWidthMin) * 100}%; height: 100%;"
      >
        {#if hour < 24}
          <span class="tick-label"><span class="tick-hh">{String(hour).padStart(2, '0')}</span><span class="tick-mm">:00</span></span>
        {/if}
      </div>
    {/each}

    <!-- Entries, absolutely positioned as % -->
    {#each entriesWithLanes as entry (entry.id)}
      <div
        class="entry-slot"
        style="
          left:   {entryLeftPct(entry)}%;
          top:    {entryTop(entry.lane)}px;
          width:  {entryWidthPct(entry)}%;
          height: {FLAG_LANE_HEIGHT + 4}px;
        "
      >
        <DiaryEntry
          {operatorAccess}
          {entry}
          height={FLAG_LANE_HEIGHT + 4}
          isSelected={selectedId === entry.id}
          {onselect}
        />
      </div>
    {/each}

    {#if nowLeftPct !== null}
      <div class="now-line" style="left: {nowLeftPct}%;"></div>
    {/if}

    </div>
  </div>

</div>

<style>
  .day-row {
    display: flex;
    align-items: flex-start;
    border-bottom: 1px solid #ccc;
    background: #fff;
  }
  .day-row:hover { background: #fafaf8; }

  /* ── Date label ── */
  .date-label {
    flex-shrink: 0;
    width: 108px;
    padding: 6px 10px 6px 14px;
    border-right: 1px solid #ccc;
    display: flex;
    flex-direction: column;
    gap: 1px;
    align-self: stretch;
    justify-content: flex-start;
    position: sticky;
    left: 0;
    z-index: 600;
    background: #fff;
  }

  .day-row:hover .date-label { background: #fafaf8; }

  .date-weekday {
    font-family: var(--font-tiny); font-size: var(--font-size-tiny);
    font-weight: 700;
    color: #1a1a1a;
  }
  .date-rest {
    font-family: var(--font-tiny); font-size: var(--font-size-tiny);
    color: #777;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .date-year-mobile { display: none; }
  .date-daym        { display: none; }

  /* ── Track ── */
  .track {
    /* Fill all remaining row width and full row height */
    flex: 1;
    align-self: stretch;
    min-width: 0;
    position: relative;
    /* visible so radial hit-maps can overlap neighbouring day rows */
    overflow: visible;
  }

  /* Inner wrapper: sets min-height from JS; abs-positioned children anchor to this */
  .track-inner {
    position: relative;
    width: 100%;
    height: 100%;
  }

  /* ── Day/night gradient background ── */
  .track-bg {
    position: absolute;
    inset: 0;
    pointer-events: none;
  }

  /* ── Hour tick lines ── */
  .tick {
    position: absolute;
    top: 0;
    width: 1px;
    background: #ccc;
    pointer-events: none;
    user-select: none;
  }
  .tick-midnight { background: #ccc; }
  .tick-day-end { transform: translateX(-1px); }

  .tick-label {
    position: absolute;
    top: 3px;
    left: 3px;
    font-family: var(--font-tiny); font-size: var(--font-size-tiny);
    color: #aaa;
    white-space: nowrap;
  }

  /* ── Current-time line ── */
  .now-line {
    position: absolute;
    top: 0;
    width: 2px;
    height: 100%;
    background: #000;
    pointer-events: none;
    z-index: 10;
  }

  /* ── Entry slot (positioning wrapper) ── */
  .entry-slot {
    position: absolute;
  }

  /* ── Mobile ── */
  @media (max-width: 520px) {
    .date-label { width: 56px; padding: 6px 4px 6px 6px; }
    .date-rest        { display: none; }
    .date-daym        { display: block; font-family: var(--font-tiny); font-size: var(--font-size-tiny); color: #777; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .date-year-mobile { display: block; font-family: var(--font-tiny); font-size: var(--font-size-tiny); color: #999; }
    .tick-mm          { display: none; }
  }
</style>
