<script>
  import DayRow from './DayRow.svelte';
  import { diaryTimelineLayout } from '$lib/diary-timeline-layout.js';

  /**
   * @type {{
   *   days: { date: string, entries: import('$lib/types').Entry[] }[];
   *   startHour: number;
   *   endHour: number;
   *   operatorAccess?: boolean;
   *   selectedId: string | null;
   *   onselect: (entry: import('$lib/types').Entry) => void;
   *   sunByDate: Record<string, { date: string, sunrise: string|null, sunset: string|null }>;
   * }}
   */
  let { days, startHour, endHour, selectedId, onselect, sunByDate = {}, operatorAccess = false } = $props();

  const DESKTOP_DATE_WIDTH = 108;
  const MOBILE_DATE_WIDTH = 56;
  const MOBILE_BREAKPOINT = 520;

  /** @type {HTMLDivElement | null} */
  let viewportElement = $state(null);
  let viewportWidth = $state(0);

  const dateColumnWidth = $derived(
    viewportWidth > 0 && viewportWidth <= MOBILE_BREAKPOINT
      ? MOBILE_DATE_WIDTH
      : DESKTOP_DATE_WIDTH
  );
  const layout = $derived(
    diaryTimelineLayout(viewportWidth, dateColumnWidth, startHour, endHour)
  );

  // Changing scale aligns the chosen start hour with the fixed date column.
  // Resizing recalculates the same alignment against the new viewport width.
  $effect(() => {
    const viewport = viewportElement;
    const width = viewportWidth;
    const scrollLeft = layout.scrollLeft;
    if (!viewport || width <= 0) return;
    viewport.scrollLeft = scrollLeft;
  });
</script>

<!-- The scroll region must be focusable so keyboard users can pan it. -->
<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
<div
  class="timeline-viewport"
  class:full-day={startHour === 0 && endHour === 24}
  bind:this={viewportElement}
  bind:clientWidth={viewportWidth}
  role="region"
  aria-label="Diary timeline, horizontally scrollable"
  tabindex="0"
>
  <div
    class="timeline-content"
    style:width={viewportWidth > 0 ? `${layout.contentWidth}px` : '100%'}
  >
    {#each days as day (day.date)}
      <DayRow
        date={day.date}
        entries={day.entries}
        {selectedId}
        {onselect}
        {operatorAccess}
        sunEntry={sunByDate[day.date] ?? null}
      />
    {/each}

    {#if days.length === 0}
      <p class="empty">No recordings found.</p>
    {/if}
  </div>
</div>

<style>
  .timeline-viewport {
    width: 100%;
    max-width: 100vw;
    min-width: 0;
    overflow-x: auto;
    overflow-y: hidden;
    overscroll-behavior-inline: contain;
  }

  .timeline-viewport.full-day {
    overflow-x: hidden;
  }

  .timeline-viewport:focus-visible {
    outline: 2px solid #4a7cdc;
    outline-offset: -2px;
  }

  .timeline-content {
    display: flex;
    flex-direction: column;
    min-width: 100%;
  }

  .empty {
    padding: 3rem 1.5rem;
    color: #999;
    text-align: center;
  }
</style>
