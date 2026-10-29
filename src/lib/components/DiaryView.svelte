<script>
  import { browser } from '$app/environment';
  import { page } from '$app/state';
  import { onMount } from 'svelte';
  import DiaryTimeline    from '$lib/components/DiaryTimeline.svelte';
  import AudioPlayerPanel from '$lib/components/AudioPlayerPanel.svelte';
  import OverviewPanel    from '$lib/components/OverviewPanel.svelte';
  import GoblinPiStatus   from '$lib/components/GoblinPiStatus.svelte';
  import {
    isIsoDate,
    PRIVATE_API_BASE,
    PUBLIC_API_BASE,
  } from '$lib/utils.js';
  import { loadHitMetadata } from '$lib/hit-metadata.js';
  import {
    diaryEntriesForDays,
    recentDiaryBounds,
    selectDiaryDays,
  } from '$lib/diary-range.js';
  import {
    hydrateRecordingCommentAnnotations,
    withRecordingCommentAnnotations,
  } from '$lib/recording-comments.js';
  import { withLinkedTrainingSample } from '$lib/diary-samples.js';
  import { probeEditingAccess } from '$lib/editing-access.js';
  import { isEmbeddedLayout } from '$lib/embed.js';

  // Svelte 5 runes
  let { data } = $props();

  /** Entries fetched live from the diary API on every page load. */
  /** @type {import('$lib/types').Entry[]} */
  let entries   = $state([]);
  let loading   = $state(true);
  /** @type {string | null} */
  let loadError = $state(null);
  let rangeLoading = $state(false);
  let rangeError = $state('');
  let operatorAccess = $state(false);

  /** Entry kind filter. */
  let kindFilter = $state('both'); // 'text' | 'audio' | 'both'
  let showAllDays = $state(false);
  // Diary is prerendered, so SvelteKit deliberately withholds URL query
  // parameters during SSR. Resolve this mode after hydration in the browser.
  const embedded = $derived(browser && isEmbeddedLayout(page.url.searchParams));

  const filteredEntries = $derived(
    kindFilter === 'both'  ? entries :
    kindFilter === 'audio' ? entries.filter(e => e.kind === 'audio') :
    entries.filter(e => e.kind !== 'audio')
  );

  const days = $derived(selectDiaryDays(filteredEntries));
  const visibleEntries = $derived(diaryEntriesForDays(days));
  const sunByDate = $derived(data.sunByDate ?? {});

  /** @type {import('$lib/types').Entry | null} */
  let selectedEntry = $state(null);

  /**
   * panelEntry holds the entry data for AudioPlayerPanel.
   * It outlives the close action so the component still has valid props
   * while its fly-out transition is running.
   * showPanel is the boolean that actually triggers the transition.
   */
  /** @type {import('$lib/types').Entry | null} */
  let panelEntry = $state(null);
  let showPanel  = $state(false);

  /** Toggle the overview bar-chart panel. */
  let showOverview = $state(true);

  /** Time range scaled to fill the scrollable viewport. The track remains 24h. */
  let domain = $state({ startHour: 9, endHour: 20 });

  const ZOOM_LEVELS = [
    { label: '24h',    startHour: 0, endHour: 24 },
    { label: '6 to 22', startHour: 6, endHour: 22 },
    { label: '9 to 20', startHour: 9, endHour: 20 },
  ];

  async function fetchDiary({ startDate, endDate } = {}) {
    const url = new URL('/api/diary', PUBLIC_API_BASE);
    if (startDate) url.searchParams.set('startDate', startDate);
    if (endDate) url.searchParams.set('endDate', endDate);
    const res = await fetch(url);
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    const nextEntries = await res.json();
    return hydrateRecordingCommentAnnotations(nextEntries, PUBLIC_API_BASE);
  }

  async function fetchLatestDiaryDate() {
    const res = await fetch(`${PUBLIC_API_BASE}/api/diary/latest-date`);
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    const body = await res.json();
    return isIsoDate(body?.date) ? body.date : null;
  }

  async function showAllDiaryDays() {
    if (rangeLoading || showAllDays) return;
    rangeLoading = true;
    rangeError = '';
    try {
      const nextEntries = await fetchDiary();
      entries = nextEntries;
      showAllDays = true;
      void loadHitMetadata().catch((error) => {
        console.error('Failed to load all hit metadata:', error);
      });
    } catch (error) {
      rangeError = error?.message ?? 'Failed to load the complete diary';
    } finally {
      rangeLoading = false;
    }
  }

  async function showRecentDiaryDays() {
    if (rangeLoading || !showAllDays) return;
    rangeLoading = true;
    rangeError = '';
    try {
      const latestDate = await fetchLatestDiaryDate();
      const bounds = latestDate ? recentDiaryBounds(latestDate) : null;
      entries = bounds ? await fetchDiary(bounds) : [];
      showAllDays = false;
      if (bounds) {
        void loadHitMetadata(bounds).catch((error) => {
          console.error('Failed to load recent hit metadata:', error);
        });
      }
    } catch (error) {
      rangeError = error?.message ?? 'Failed to load recent diary days';
    } finally {
      rangeLoading = false;
    }
  }

  /** Open the detail panel for a given entry and update the URL hash. */
  function selectEntry(entry) {
    selectedEntry = entry;
    panelEntry    = entry;  // set data first so panel has props before mounting
    showPanel     = true;
    if (typeof window !== 'undefined') {
      history.replaceState(null, '', window.location.pathname + window.location.search + '#' + entry.id);
    }
  }

  /** Close the detail panel: triggers the fly-out transition. */
  function closePanel() {
    selectedEntry = null;  // clears timeline highlight immediately
    showPanel     = false; // triggers fly-out; panelEntry stays set until transition ends
    if (typeof window !== 'undefined') {
      history.replaceState(null, '', window.location.pathname + window.location.search);
    }
  }

  /** Called by AudioPlayerPanel after its exit transition finishes. */
  function handlePanelClosed() {
    panelEntry = null;  // now safe to clear – component is gone from DOM
  }

  /** Refresh the diary, report flags and open popup after a comment save. */
  function handleCommentChange(entry, annotations) {
    const updated = withRecordingCommentAnnotations(entry, annotations);
    entries = entries.map(item => item.id === entry.id ? updated : item);
    if (selectedEntry?.id === entry.id) selectedEntry = updated;
    if (panelEntry?.id === entry.id) panelEntry = updated;
  }

  /** Refresh every projection of an entry after its persisted trim changes. */
  function handleTrimChange(entry, trim) {
    const updated = { ...entry, ...trim };
    entries = entries.map(item => item.id === entry.id ? { ...item, ...trim } : item);
    if (selectedEntry?.id === entry.id) selectedEntry = updated;
    if (panelEntry?.id === entry.id) panelEntry = updated;
  }

  /** Refresh every projection after an approval is set or cleared. */
  function handleApprovalChange(entry, approved) {
    const updated = { ...entry, approved };
    entries = entries.map(item => item.id === entry.id ? { ...item, approved } : item);
    if (selectedEntry?.id === entry.id) selectedEntry = updated;
    if (panelEntry?.id === entry.id) panelEntry = updated;
  }

  /**
   * Delete a diary entry via the API, then remove it from the local list
   * and close the panel.
   * @param {import('$lib/types').Entry} entry
   */
  async function deleteEntry(entry) {
    try {
      const res = await fetch(`${PRIVATE_API_BASE}/api/diary/${encodeURIComponent(entry.id)}`, { method: 'DELETE' });
      if (!res.ok && res.status !== 204) throw new Error(`${res.status} ${res.statusText}`);
    } catch (e) {
      // Surface errors in the browser console; panel will still close.
      console.error('Failed to delete entry:', e);
    }
    entries = entries.filter(e => e.id !== entry.id);
    closePanel();
  }

  /** Convert a false-positive diary recording into a labeled training sample. */
  async function moveEntryToSamples(entry, label, keepInDiary = false) {
    const res = await fetch(
      `${PRIVATE_API_BASE}/api/diary/${encodeURIComponent(entry.id)}/move-to-samples`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ label, keepInDiary }),
      },
    );
    if (!res.ok) {
      let message = `${res.status} ${res.statusText}`;
      try {
        const body = await res.json();
        if (body?.error) message = body.error;
      } catch {
        // Keep the HTTP status text when the response is not JSON.
      }
      throw new Error(message);
    }

    const moveResult = await res.json();

    if (!keepInDiary) {
      entries = entries.filter(e => e.id !== entry.id);
      closePanel();
    } else {
      const updated = withLinkedTrainingSample(entry, moveResult);
      entries = entries.map(item => item.id === entry.id ? updated : item);
      if (selectedEntry?.id === entry.id) selectedEntry = updated;
      if (panelEntry?.id === entry.id) panelEntry = updated;
    }
  }

  // On mount: fetch diary entries live from the API, then handle deep-link hash.
  onMount(async () => {
    try {
      const latestDate = await fetchLatestDiaryDate();
      const bounds = latestDate ? recentDiaryBounds(latestDate) : null;
      entries = bounds ? await fetchDiary(bounds) : [];

      // Progressive enhancement: do not await metadata. This runs only for a
      // page mount, not from layout/resize effects, and follows every page the
      // bulk API advertises through links.next.
      if (bounds) {
        void loadHitMetadata(bounds).catch((e) => {
          console.error('Failed to load hit metadata:', e);
        });
      }
    } catch (e) {
      loadError = e.message;
    } finally {
      loading = false;
    }

    const hash = window.location.hash.slice(1);
    if (hash) {
      const entry = entries.find((e) => e.id === hash);
      if (entry) {
        selectedEntry = entry;
        panelEntry = entry;
        showPanel = true;
      }
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
  <title>Diary · Barktown</title>
</svelte:head>

<div class="app">
  {#if !embedded}<header class="site-header">
    <h1><img class="brand-logo" src="/logo.png" alt="" width="144" height="144" /> Barktown</h1>
    <button
      class="subtitle recordings-toggle"
      class:active={showOverview}
      onclick={() => (showOverview = !showOverview)}
      aria-pressed={showOverview}
      title="Toggle overview chart"
    >{#if loading}Loading…{:else if loadError}Error{:else}{visibleEntries.length} recorded events{/if}</button>

    <div class="kind-controls" role="group" aria-label="Entry type filter">
      {#each ['text', 'audio', 'both'] as k (k)}
        <button
          class="zoom-btn"
          class:active={kindFilter === k}
          onclick={() => (kindFilter = k)}
          aria-pressed={kindFilter === k}
        >{k}</button>
      {/each}
    </div>

    <div class="zoom-controls" role="group" aria-label="Zoom level">
      {#each ZOOM_LEVELS as level (level.label)}
        <button
          class="zoom-btn"
          class:active={domain.startHour === level.startHour && domain.endHour === level.endHour}
          onclick={() => (domain = { startHour: level.startHour, endHour: level.endHour })}
          aria-pressed={domain.startHour === level.startHour && domain.endHour === level.endHour}
        >
          {level.label}
        </button>
      {/each}
    </div>

    <a class="nav-link current" aria-current="page" href="/diary">Diary</a>
    <a class="nav-link" href="/report">Report</a>
    {#if operatorAccess}<a class="nav-link" href="/training">Training</a>{/if}
    {#if operatorAccess}<a class="nav-link" href="/quality">Quality</a>{/if}
    <a class="nav-link" href="/method">Method</a>

    <GoblinPiStatus />
  </header>{/if}

  <main class="diary-main">
    {#if !loading && !loadError}
      <div class="diary-range-controls">
        <span>{embedded ? 'showing records from the last 14 calendar days' : showAllDays ? 'showing all days with records starting from 2021' : 'showing records from the last 14 calendar days'}</span>
        {#if !embedded}
          <button
            disabled={rangeLoading}
            onclick={showAllDays ? showRecentDiaryDays : showAllDiaryDays}
          >
            {#if rangeLoading}Loading…{:else if showAllDays}Show the last 14 calendar days{:else}Show all days starting from 2021{/if}
          </button>
        {/if}
      </div>
      {#if rangeError}<p class="range-error" role="alert">{rangeError}</p>{/if}
    {/if}
    {#if showOverview && !embedded}
      <OverviewPanel entries={visibleEntries} />
    {/if}
    {#if loading}
      <p class="status-msg">Loading recordings…</p>
    {:else if loadError}
      <p class="status-msg error">Could not load diary data: {loadError}</p>
    {:else}
    <DiaryTimeline
      {days}
      startHour={domain.startHour}
      endHour={domain.endHour}
      selectedId={selectedEntry?.id ?? null}
      onselect={selectEntry}
      {sunByDate}
    />
    {/if}
  </main>
</div>

<!-- Slide-up panel: showPanel triggers enter/exit transition;
     panelEntry stays non-null until the exit animation finishes -->
{#if showPanel && panelEntry}
  <AudioPlayerPanel
    entry={panelEntry}
    onclose={closePanel}
    onclosed={handlePanelClosed}
    ondelete={deleteEntry}
    onmovesample={moveEntryToSamples}
    oncommentchange={handleCommentChange}
    ontrimchange={handleTrimChange}
    onapprovalchange={handleApprovalChange}
  />
{/if}

<style>
  :global(*, *::before, *::after) { box-sizing: border-box; }
  :global(body) {
    margin: 0;
    font-family: var(--font-body);
    background: #f7f7f5;
    color: #1a1a1a;
  }

  .app {
    min-height: 100dvh;
  }

  /* ── Header ── */
  .site-header {
    position: sticky;
    top: 0;
    /* Higher than any diary entry's z-index (entries top out at 571) so the
       header's own stacking context — and GoblinPiStatus's popup inside it —
       always paints above entries, regardless of GoblinPiStatus's internal
       z-index values (900/901), which are only compared within this bracket. */
    z-index: 1000;
    background: #fff;
    border-bottom: 1px solid #e0e0dc;
    padding: 0.6rem 1rem;
    display: flex;
    align-items: center;
    gap: 1rem;
    flex-wrap: wrap;
  }

  .site-header h1 {
    margin: 0;
    font-size: var(--font-size-medium);
    font-weight: 700;
    white-space: nowrap;
  }

  .subtitle {
    margin: 0;
    font-family: var(--font-tiny); font-size: var(--font-size-tiny);
    color: #888;
    white-space: nowrap;
  }

  .recordings-toggle {
    background: none;
    border: 1px solid transparent;
    border-radius: 4px;
    padding: 0.15rem 0.4rem;
    cursor: pointer;
    font-family: inherit;
    transition: background 0.1s, color 0.1s, border-color 0.1s;
  }
  .recordings-toggle:hover { background: #f0f0ec; border-color: #d0d0cc; color: #555; }
  .recordings-toggle.active { background: #1a1a1a; color: #fff; border-color: #1a1a1a; }

  .kind-controls {
    display: flex;
    gap: 0.25rem;
    margin-left: auto;
  }

  .zoom-controls {
    display: flex;
    gap: 0.25rem;
  }

  .zoom-btn {
    background: none;
    border: 1px solid #d0d0cc;
    border-radius: 4px;
    padding: 0.2rem 0.55rem;
    font-family: var(--font-tiny); font-size: var(--font-size-tiny);
    cursor: pointer;
    color: #555;
    transition: background 0.1s, color 0.1s;
  }
  .zoom-btn:hover   { background: #f0f0ec; }
  .zoom-btn.active  { background: #1a1a1a; color: #fff; border-color: #1a1a1a; }

  .nav-link {
    font-family: var(--font-tiny); font-size: var(--font-size-tiny);
    color: #555;
    text-decoration: none;
    white-space: nowrap;
    padding: 0.2rem 0.4rem;
    border-radius: 4px;
    transition: background 0.1s, color 0.1s;
  }
  .nav-link:hover { background: #f0f0ec; color: #1a1a1a; }
  .nav-link.current { background: #f0f0ec; color: #1a1a1a; font-weight: 650; }

  /* ── Main ── */
  .diary-main {
    padding: 0.5rem 0;
  }

  .diary-range-controls {
    min-height: 38px;
    padding: 0 1rem 0.5rem;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 0.8rem;
    color: #555;
    font-size: var(--font-size-small);
  }

  .diary-range-controls button {
    background: #fff;
    border: 1px solid #d0d0cc;
    border-radius: 4px;
    padding: 0.3rem 0.65rem;
    color: #555;
    cursor: pointer;
  }
  .diary-range-controls button:hover { background: #f0f0ec; color: #1a1a1a; }
  .diary-range-controls button:disabled { opacity: 0.55; cursor: wait; }

  .range-error {
    margin: -0.1rem 1rem 0.5rem;
    color: #c0392b;
    font-family: var(--font-tiny); font-size: var(--font-size-tiny);
    text-align: center;
  }

  .status-msg {
    padding: 3rem 1.5rem;
    text-align: center;
    color: #999;
    font-size: var(--font-size-small);
  }
  .status-msg.error { color: #c0392b; }

  @media (max-width: 620px) {
    .diary-range-controls {
      align-items: stretch;
      flex-direction: column;
      gap: 0.4rem;
      text-align: center;
    }
  }
</style>
