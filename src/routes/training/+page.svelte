<script>
  import { page } from '$app/state';
  import { onMount, tick } from 'svelte';
  import {
    ASSET_BASE,
    PRIVATE_API_BASE,
    PUBLIC_API_BASE,
    downsampleWaveform,
    waveformNorm,
    formatDuration,
    formatSampleDatetime,
    formatDate,
  } from '$lib/utils.js';
  import { SAMPLE_LABELS as LABELS, FRAGMENT_LABELS, SAMPLE_LABEL_GUIDELINES as LABEL_GUIDELINES, filterTrainingSamples, fragmentRelabelTargets, sampleLabelColor, sampleLabelShortcut, trainingLabelActionForShortcut } from '$lib/sample-labels.js';
  import { TRAINING_COLOR_ENCODINGS, TRAINING_COLOR_GUIDES } from '$lib/training-color-guides.js';
  import {
    FIT_WAVEFORM_SECONDS_PER_PIXEL,
    MIN_WAVEFORM_SECONDS_PER_PIXEL,
    centeredWaveformScrollLeft,
    formatWaveformSecondsPerPixel,
    stepWaveformSecondsPerPixel,
    waveformBarBackingWidth,
    waveformContentWidth,
    waveformFitSecondsPerPixel,
    waveformRangeScrollLeft,
    waveformZoomScale,
    zoomInvariantSvgWidth,
  } from '$lib/training-waveform-zoom.js';
  import { fragmentSelectionAfterDelete } from '$lib/training-fragment-selection.js';
  import { loadTrainingProjectionPoints } from '$lib/training-projection-data.js';
  import {
    WINDOW_REVIEW_ACTIONS,
    deriveWindowReviewSuggestionQueues,
    formatWindowReviewSummary,
    matchWindowReviewQueues,
    mergeWindowReviewAnnotations,
    withLingeringWindowReviewCandidate,
    windowConfidenceBarSegments,
  } from '$lib/training-window-review.js';
  import { probeEditingAccess } from '$lib/editing-access.js';
  import { taggedFragmentRanges, taggedPlaybackStep, taggedRangeIndexAtOrAfter } from '$lib/tagged-fragment-playback.js';
  import GoblinPiStatus from '$lib/components/GoblinPiStatus.svelte';
  import TrainingProjectionScatterplot from '$lib/components/TrainingProjectionScatterplot.svelte';
  import { isEmbeddedLayout } from '$lib/embed.js';

  // Sample and annotation reads use the anonymous public API. Mutations still
  // go directly to masmopi over Tailscale, using the same no-auth trust model
  // as GoblinPiStatus.svelte. Audio/waveform bytes remain on ASSET_BASE.
  //
  // masmopi (Pi 5, ingestion + API host), NOT gawblen (Pi 3B+, mic capture
  // only — gawblen just uploads to masmopi and has no ingest API of its own).
  const ALL_LABELS = ['all', ...LABELS, 'review', 'unmarked'];
  const NOTE_COLOR = '#f1c40f';
  const embedded = $derived(isEmbeddedLayout(page.url.searchParams));

  /** Tailnet-only mutation controls appear after the private API responds. */
  let editingAccess = $state(false);

  // Virtual SVG dimensions for the waveform editor (viewBox units).
  const VW = 1000;
  const VH = 140;
  const BARS = 500;
  const MAX_CANVAS_DIMENSION = 16384;
  // Drags shorter than this (in seconds) are treated as a plain seek click
  // rather than a fragment brush-selection.
  const BRUSH_MIN_SEC = 0.05;
  const WINDOW_REVIEW_TABS = Object.freeze([
    Object.freeze({ id: 'contrast', label: 'Contrast' }),
    Object.freeze({ id: 'lowConfidence', label: 'Low C' }),
    Object.freeze({ id: 'suspect', label: 'Suspect' }),
    Object.freeze({ id: 'kept', label: 'Kept' }),
  ]);
  const WINDOW_REVIEW_KIND_ICONS = Object.freeze({
    'low-confidence': '↓',
    suspect: '⚠',
    kept: '✓',
  });

  // ── Sample list state ──────────────────────────────────────────────────────
  /** @type {any[]} */
  let samples        = $state([]);
  let samplesLoading  = $state(false);
  let samplesError    = $state('');
  let filterLabel     = $state('all');
  let samplesSidebarCollapsed = $state(false);
  let windowReviewSidebarCollapsed = $state(true);
  let hoveredCorpusLabel = $state(/** @type {string|null} */ (null));
  let pinnedCorpusLabel = $state(/** @type {string|null} */ (null));
  let hoveredSidebarSampleId = $state(/** @type {string|null} */ (null));
  let selectedColorEncoding = $state('label');
  /** @type {any[]} */
  let projectionPoints = $state.raw([]);
  let projectionReviewError = $state('');
  /** @type {any[]} */
  let allAnnotations = $state.raw([]);
  let windowReviewTab = $state('contrast');
  /** @type {string|null} */
  let focusedReviewKey = $state(null);
  /** @type {string|null} */
  let appliedReviewKey = $state(null);
  /** @type {{ candidate: any, index: number, tab: string }|null} */
  let lingeringWindowReview = $state.raw(null);
  let windowReviewBusy = $state(false);
  let windowReviewError = $state('');
  /** @type {Map<string, number>} */
  let windowCountsByLabel = $state(new Map());
  /** @type {Map<string, number[]>} */
  let windowDurationBinsByLabel = $state(new Map());
  /** @type {Map<string, { min: number, max: number }>} */
  let colorDomainsByEncoding = $state(new Map());

  const activeCorpusLabel = $derived(hoveredCorpusLabel ?? pinnedCorpusLabel);
  const selectedColorGuide = $derived(TRAINING_COLOR_GUIDES[selectedColorEncoding] ?? TRAINING_COLOR_GUIDES.label);
  const selectedColorDomain = $derived(colorDomainsByEncoding.get(selectedColorEncoding) ?? null);
  const windowReviewSuggestionQueues = $derived(
    deriveWindowReviewSuggestionQueues(projectionPoints)
  );
  const windowReviewQueues = $derived(
    matchWindowReviewQueues(windowReviewSuggestionQueues, allAnnotations)
  );
  const windowReviewCandidates = $derived(
    windowReviewQueues[windowReviewTab] ?? []
  );
  const activeLingeringWindowReview = $derived(
    lingeringWindowReview?.tab === windowReviewTab ? lingeringWindowReview : null
  );
  const visibleWindowReviewCandidates = $derived(
    withLingeringWindowReviewCandidate(windowReviewCandidates, activeLingeringWindowReview)
  );
  const focusedReviewCandidate = $derived(
    visibleWindowReviewCandidates.find(candidate => candidate.reviewKey === focusedReviewKey) ?? null
  );
  const focusedWindowReviewApplied = $derived(
    appliedReviewKey != null && appliedReviewKey === focusedReviewKey
  );
  const focusedReviewTargetWindow = $derived(
    focusedReviewCandidate?.targetWindow ?? null
  );

  const filteredSamples = $derived(filterTrainingSamples(samples, filterLabel, sampleFragments));

  // Corpus-wide counts per label, for the summary shown when nothing is
  // selected -- lets you check progress against the benchmarks in
  // docs/training-data.md (30–50 min viable, 100+ better, per class).
  const sampleCountsByLabel = $derived.by(() => {
    const counts = new Map();
    for (const s of samples) counts.set(s.label, (counts.get(s.label) ?? 0) + 1);
    return counts;
  });
  const fragmentCountsByLabel = $derived.by(() => {
    const counts = new Map();
    for (const list of sampleFragments.values()) {
      for (const f of list) counts.set(f.label, (counts.get(f.label) ?? 0) + 1);
    }
    return counts;
  });

  function toggleCorpusLabel(label) {
    pinnedCorpusLabel = pinnedCorpusLabel === label ? null : label;
  }

  function updateWindowSummary({ counts, durationBins, colorDomains }) {
    windowCountsByLabel = new Map(counts);
    windowDurationBinsByLabel = new Map(durationBins);
    colorDomainsByEncoding = new Map(colorDomains);
  }

  function formatColorScaleEnd(value) {
    if (!Number.isFinite(value)) return '—';
    if (Number.isInteger(value) && Math.abs(value) >= 10) return value.toLocaleString();
    if (Math.abs(value) >= 100) return Math.round(value).toLocaleString();
    return Number(value.toPrecision(3)).toString();
  }

  function formatColorScaleStart(value) {
    return formatColorScaleEnd(value < 0.001 ? 0 : value);
  }

  // Fragment-duration histogram per label, binned in 0.5s buckets from 0s up
  // to 5s, plus an overflow bucket for anything longer. Shown as a tiny bar
  // chart (Datatype font) next to each label's counts.
  const DURATION_BIN_SIZE  = 0.5;
  const DURATION_BIN_COUNT = 10; // 0-0.5, 0.5-1, ... 4.5-5
  function durationBinIndex(durationSec) {
    if (durationSec >= DURATION_BIN_COUNT * DURATION_BIN_SIZE) return DURATION_BIN_COUNT;
    return Math.max(0, Math.floor(durationSec / DURATION_BIN_SIZE));
  }
  const fragmentDurationBinsByLabel = $derived.by(() => {
    const bins = new Map();
    for (const list of sampleFragments.values()) {
      for (const f of list) {
        const arr = bins.get(f.label) ?? new Array(DURATION_BIN_COUNT + 1).fill(0);
        arr[durationBinIndex(f.durationSec)]++;
        bins.set(f.label, arr);
      }
    }
    return bins;
  });
  function fragmentDurationChart(lbl) {
    const bins = fragmentDurationBinsByLabel.get(lbl) ?? new Array(DURATION_BIN_COUNT + 1).fill(0);
    const max = Math.max(0, ...bins);
    const scaled = max > 0 ? bins.map(v => Math.round((v / max) * 100)) : bins.map(() => 0);
    return `{b:${scaled.join(',')}}`;
  }
  function fragmentDurationTitle(lbl) {
    const bins = fragmentDurationBinsByLabel.get(lbl) ?? new Array(DURATION_BIN_COUNT + 1).fill(0);
    return bins
      .map((count, i) => {
        const label = i < DURATION_BIN_COUNT ? `${(i * DURATION_BIN_SIZE).toFixed(1)}-${((i + 1) * DURATION_BIN_SIZE).toFixed(1)}s` : '>5s';
        return `${label}: ${count}`;
      })
      .join('\n');
  }

  function windowDurationChart(lbl) {
    const bins = windowDurationBinsByLabel.get(lbl) ?? new Array(11).fill(0);
    const max = Math.max(0, ...bins);
    const scaled = max > 0 ? bins.map((count) => Math.round((count / max) * 100)) : bins.map(() => 0);
    return `{b:${scaled.join(',')}}`;
  }
  function windowDurationTitle(lbl) {
    const bins = windowDurationBinsByLabel.get(lbl) ?? new Array(11).fill(0);
    return bins
      .map((count, i) => `${i < 10 ? `${i * 100}-${(i + 1) * 100}ms` : '>1000ms'}: ${count}`)
      .join('\n');
  }

  async function fetchSamples() {
    samplesLoading = true;
    samplesError   = '';
    try {
      const res = await fetch(`${PUBLIC_API_BASE}/api/samples`, { signal: AbortSignal.timeout(8000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      samples = [...data].sort((a, b) => b.datetimeLocal.localeCompare(a.datetimeLocal));
      // Deep-link: open the sample whose id matches the URL hash.
      const hashId = window.location.hash.slice(1);
      if (hashId && !selected) {
        const target = samples.find(s => s.id === hashId);
        if (target) selectSample(target);
      }
    } catch (e) {
      samplesError = e?.name === 'TimeoutError' ? 'Timed out — on Tailscale?' : (e?.message ?? 'Failed to load');
    } finally {
      samplesLoading = false;
    }
  }

  /** Best-effort bulk snapshot for sidebar decorations: each sample's
   * sample-wide note text, and its fragment-coverage strip (start/end as
   * fractions of the sample's duration). Refreshed on load / reload and kept
   * current via local mutation syncs (setSampleNotePreview /
   * syncSampleFragmentsFromAnnotations) so the sidebar doesn't go stale while
   * you work on the currently selected sample. */
  async function fetchSidebarAnnotationSummary() {
    try {
      const res = await fetch(`${PUBLIC_API_BASE}/api/annotations`, { signal: AbortSignal.timeout(8000) });
      if (!res.ok) return;
      const rows = await res.json();
      allAnnotations = rows.filter(annotation => annotation.source !== 'note');
      const notes = new Map();
      const frags = new Map();
      for (const r of rows) {
        if (r.source === 'note') {
          if (r.startSec === 0 && r.endSec === 0) notes.set(r.sampleId, r.label);
          continue;
        }
        const dur = r.sampleDurationSec;
        if (!dur) continue;
        const list = frags.get(r.sampleId) ?? [];
        list.push({ startFrac: r.startSec / dur, endFrac: r.endSec / dur, durationSec: r.endSec - r.startSec, label: r.label });
        frags.set(r.sampleId, list);
      }
      sampleNotes     = notes;
      sampleFragments = frags;
    } catch (_e) {
      // non-critical — sidebar decorations just won't show until the next reload
    }
  }

  function reloadSidebar() {
    fetchSamples();
    fetchSidebarAnnotationSummary();
  }

  /** Keep the sidebar's bulk-fetched note-preview map in sync with local
   * create/edit/delete, so a sample's preview doesn't go stale or vanish
   * once you navigate away from it (without needing a manual reload). */
  function setSampleNotePreview(sampleId, label) {
    const map = new Map(sampleNotes);
    if (label == null) map.delete(sampleId);
    else map.set(sampleId, label);
    sampleNotes = map;
  }

  /** Keep the sidebar's fragment-coverage strip for the currently selected
   * sample in sync with local fragment mutations, same idea as
   * setSampleNotePreview. */
  function syncSampleFragmentsFromAnnotations() {
    if (!selected?.durationSec) return;
    const dur = selected.durationSec;
    const frags = annotations
      .filter(a => a.source !== 'note')
      .map(a => ({ startFrac: a.startSec / dur, endFrac: a.endSec / dur, durationSec: a.endSec - a.startSec, label: a.label }));
    const map = new Map(sampleFragments);
    map.set(selected.id, frags);
    sampleFragments = map;

    const nextAllAnnotations = mergeWindowReviewAnnotations(allAnnotations, selected.id, annotations);
    if (nextAllAnnotations !== allAnnotations) allAnnotations = nextAllAnnotations;
  }

  // ── Player / selection state ───────────────────────────────────────────────
  /** @type {any} */
  let selected       = $state(null);
  /** @type {HTMLAudioElement|null} */
  let audioEl        = $state(null);
  let isPlaying       = $state(false);
  let playbackMode    = $state(/** @type {'normal'|'approver'} */ ('normal'));
  let approverRangeIndex = 0;
  let currentTime     = $state(0);
  let duration        = $state(0);
  let pendingSeekSec  = $state(/** @type {number|null} */ (null));

  // rAF-based playhead: sample audioEl.currentTime at ~60 fps while playing so
  // the playhead moves smoothly. ontimeupdate stays as a seek fallback.
  $effect(() => {
    if (!isPlaying || !audioEl) return;
    let id = 0;
    const tick = () => {
      currentTime = audioEl.currentTime;
      if (playbackMode === 'approver') enforceApproverPlayback();
      id = requestAnimationFrame(tick);
    };
    id = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(id);
  });
  /** @type {{ mins: number[], maxs: number[], norm: number }|null} */
  let waveData        = $state(null);
  let waveLoading      = $state(false);
  let regenLoading     = $state(false);
  /** @type {Map<string, any>} */
  const waveCache      = new Map();
  /** @type {SVGSVGElement|null} */
  let waveSvgEl        = $state(null);
  /** @type {HTMLCanvasElement|null} */
  let waveCanvasEl     = $state(null);
  /** @type {HTMLDivElement|null} */
  let waveWrapEl       = $state(null);
  /** @type {HTMLDivElement|null} */
  let waveScrollEl     = $state(null);
  let waveViewportWidth = $state(0);
  // Zero means FIT. A non-zero value is an absolute timeline scale and is
  // deliberately retained when another sample is opened.
  let waveSecondsPerPixel = $state(FIT_WAVEFORM_SECONDS_PER_PIXEL);
  // Fragment currently hovered (label shown even when not the focused/selected one).
  let hoveredAnnId     = $state(/** @type {number|null} */ (null));

  // ── Annotations (fragments + time-coded notes) ─────────────────────────────
  /** @type {any[]} */
  let annotations         = $state([]);
  let annotationsLoading  = $state(false);
  let annotationsError    = $state('');
  /** @type {number|null} */
  let selectedAnnId       = $state(null);
  let editLabel           = $state(''); // buffer for inline-editing a note's text
  let editingNoteId       = $state(/** @type {number|null} */ (null)); // note row currently in edit mode
  let addingSampleNote    = $state(false); // drafting a new sample-wide note (unsaved)
  let newSampleNoteText   = $state('');
  let mutationError       = $state('');

  // sampleId -> sample-wide note text, for the sidebar preview. Best-effort
  // snapshot from GET /api/annotations; the currently selected sample's own
  // note is instead read live from `annotations` (see selectedSampleWideNote).
  /** @type {Map<string, string>} */
  let sampleNotes = $state(new Map());

  // sampleId -> fragment list ({startFrac, endFrac, label}), for the sidebar's
  // mini coverage strip. Same bulk-snapshot-plus-local-sync approach as
  // sampleNotes above.
  /** @type {Map<string, Array<{startFrac:number, endFrac:number, label:string}>>} */
  let sampleFragments = $state(new Map());

  // ── Brush / drag state ─────────────────────────────────────────────────────
  /** @type {'brush'|'resize-start'|'resize-end'|'move'|null} */
  let dragMode        = $state(null);
  let dragAnnId       = $state(/** @type {number|null} */ (null));
  let dragStartSec    = $state(0);
  let dragCurrentSec  = $state(0);
  let dragOrigStart   = $state(0);
  let dragOrigEnd     = $state(0);
  /** @type {{ startSec: number, endSec: number }|null} */
  let pending         = $state(null);
  let pendingLabel    = $state(LABELS[0]);
  let pendingNoteText = $state('');

  // ── Sample-level mutation state ────────────────────────────────────────────
  let deleteConfirm = $state(false);
  let deleteBusy    = $state(false);
  let renameBusy    = $state(false);
  let renameError   = $state('');
  let bulkRelabelBusy = $state(false);
  let reanalyzeConfirm   = $state(false);
  let reanalyzeBusy      = $state(false);
  let reanalyzeThreshold = $state(0.9);
  let reanalyzeError     = $state('');

  const playheadX = $derived(duration > 0 ? (currentTime / duration) * VW : 0);
  const waveFitSecondsPerPixel = $derived(
    waveformFitSecondsPerPixel(duration, waveViewportWidth)
  );
  const waveContentWidthPx = $derived(
    waveformContentWidth(duration, waveViewportWidth, waveSecondsPerPixel)
  );
  const waveScale = $derived(
    waveformZoomScale(duration, waveViewportWidth, waveSecondsPerPixel)
  );
  const waveWrapWidth = $derived(
    waveContentWidthPx > 0 ? `${waveContentWidthPx}px` : '100%'
  );
  const waveZoomLabel = $derived(formatWaveformSecondsPerPixel(waveSecondsPerPixel));

  function secToX(sec) {
    return duration > 0 ? (sec / duration) * VW : 0;
  }

  const bars = $derived(() => {
    if (!waveData) return [];
    const { mins, maxs, norm } = waveData;
    const count = mins.length;
    if (!count) return [];
    const barW = VW / count;
    const cy   = VH / 2;
    let visualPeak = 0;
    for (let i = 0; i < count; i++) {
      const v = maxs[i] / norm;
      if (v > visualPeak) visualPeak = v;
    }
    const yScale = visualPeak > 0 ? 1 / visualPeak : 1;
    return mins.map((lo, i) => {
      const hi     = maxs[i];
      const yTop   = cy - (hi / norm) * yScale * cy;
      const yBot   = cy - (lo / norm) * yScale * cy;
      const barSec = (i / count) * duration;
      return { x: i * barW, y: yTop, h: Math.max(1, yBot - yTop), played: barSec <= currentTime };
    });
  });

  /** Paints `bars()` onto the canvas layer at native pixel resolution
   * (rather than as hundreds of SVG <rect> nodes) — cheaper to render and
   * sharper, since it isn't stretched through a viewBox transform. */
  function drawWaveCanvas() {
    const canvas = waveCanvasEl;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const dpr  = window.devicePixelRatio || 1;
    // Very wide zoomed timelines can exceed the browser's canvas dimension
    // limit. CSS still stretches this backing bitmap across the full timeline.
    const w    = Math.min(MAX_CANVAS_DIMENSION, Math.max(1, Math.round(rect.width * dpr)));
    const h    = Math.max(1, Math.round(rect.height * dpr));
    if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.clearRect(0, 0, w, h);
    const scaleX = w / VW;
    const scaleY = h / VH;
    const barWidth = waveformBarBackingWidth(w, rect.width);
    for (const bar of bars()) {
      ctx.fillStyle = bar.played ? '#2255bb' : '#a0b8e8';
      ctx.fillRect(bar.x * scaleX, bar.y * scaleY, barWidth, Math.max(1, bar.h * scaleY));
    }
  }

  $effect(() => {
    bars(); // reactive dependency: redraw whenever bars change
    drawWaveCanvas();
  });

  $effect(() => {
    if (!waveWrapEl) return;
    const ro = new ResizeObserver(() => drawWaveCanvas());
    ro.observe(waveWrapEl);
    return () => ro.disconnect();
  });

  $effect(() => {
    const scrollEl = waveScrollEl;
    if (!scrollEl) return;
    const updateViewportWidth = () => {
      waveViewportWidth = scrollEl.clientWidth;
    };
    updateViewportWidth();
    const ro = new ResizeObserver(updateViewportWidth);
    ro.observe(scrollEl);
    return () => ro.disconnect();
  });

  async function setWaveSecondsPerPixel(nextSecondsPerPixel) {
    if (nextSecondsPerPixel === waveSecondsPerPixel) return;

    const scrollEl = waveScrollEl;
    const oldScrollLeft = scrollEl?.scrollLeft ?? 0;
    const viewportWidth = scrollEl?.clientWidth ?? 0;
    const oldContentWidth = scrollEl?.scrollWidth ?? viewportWidth;

    waveSecondsPerPixel = nextSecondsPerPixel;
    await tick();

    if (!scrollEl) return;
    scrollEl.scrollLeft = centeredWaveformScrollLeft(
      oldScrollLeft,
      viewportWidth,
      oldContentWidth,
      scrollEl.scrollWidth,
    );
  }

  function changeWaveZoom(direction) {
    void setWaveSecondsPerPixel(stepWaveformSecondsPerPixel(
      waveSecondsPerPixel,
      direction,
      waveFitSecondsPerPixel,
    ));
  }

  function scrollWaveformRangeIntoView(startSec, endSec, focusSec) {
    const scrollEl = waveScrollEl;
    if (!scrollEl || duration <= 0 || scrollEl.scrollWidth <= scrollEl.clientWidth) return;
    const pxPerSec = scrollEl.scrollWidth / duration;
    const nextScrollLeft = waveformRangeScrollLeft(
      scrollEl.scrollLeft,
      scrollEl.clientWidth,
      scrollEl.scrollWidth,
      startSec * pxPerSec,
      endSec * pxPerSec,
      focusSec * pxPerSec,
    );
    if (nextScrollLeft !== scrollEl.scrollLeft) {
      scrollEl.scrollTo({ left: nextScrollLeft, behavior: 'smooth' });
    }
  }

  /** Live preview of an annotation's bounds while it's being dragged. */
  function previewBounds(ann) {
    if (!(dragMode && dragAnnId === ann.id)) return { startSec: ann.startSec, endSec: ann.endSec };
    let s = ann.startSec, en = ann.endSec;
    if (dragMode === 'resize-start') s  = Math.min(dragCurrentSec, ann.endSec - 0.02);
    if (dragMode === 'resize-end')   en = Math.max(dragCurrentSec, ann.startSec + 0.02);
    if (dragMode === 'move') {
      const delta = dragCurrentSec - dragStartSec;
      const span  = dragOrigEnd - dragOrigStart;
      s  = Math.max(0, Math.min(Math.max(0, duration - span), dragOrigStart + delta));
      en = s + span;
    }
    return { startSec: Math.max(0, s), endSec: Math.min(duration, en) };
  }

  const renderFragments = $derived(
    annotations.filter(a => a.source !== 'note').map(a => ({ ...a, ...previewBounds(a) }))
  );
  const approverRanges = $derived(taggedFragmentRanges(annotations, { startSec: 0, endSec: duration }));
  // Sample-wide notes (startSec === endSec === 0) have no meaningful position
  // on the timeline, so they're only shown in the Notes panel, not marked here.
  const renderNotes = $derived(annotations.filter(a => a.source === 'note' && !isSampleWideNote(a)));

  // A note is "sample-wide" if its time code is 0ms — no separate flag in
  // the data model, just a convention enforced client-side.
  function isSampleWideNote(a) {
    return a.source === 'note' && a.startSec === 0 && a.endSec === 0;
  }
  const sortedNotes = $derived(
    annotations.filter(a => a.source === 'note').slice().sort((a, b) => a.startSec - b.startSec)
  );
  const hasSampleWideNote = $derived(annotations.some(isSampleWideNote));
  const selectedSampleWideNote = $derived(annotations.find(isSampleWideNote) ?? null);

  // Fragments whose startSec is at or beyond the sample's stored duration —
  // these can't be exported and need to be cleaned up.
  const outOfBoundsFragments = $derived(
    selected
      ? annotations.filter(a => a.source !== 'note' && a.startSec >= selected.durationSec)
      : []
  );

  // ── Data loading ────────────────────────────────────────────────────────────

  async function loadWaveform(path) {
    if (!path) { waveData = null; return; }
    const cached = waveCache.get(path);
    if (cached === 'error') { waveData = null; return; }
    if (cached) { waveData = cached; return; }
    waveLoading = true;
    try {
      const res = await fetch(`${ASSET_BASE}/${path}`, { signal: AbortSignal.timeout(8000) });
      if (!res.ok) throw new Error();
      const json  = await res.json();
      const norm  = waveformNorm(json.bits ?? 8);
      const totalBars = Math.floor(json.data.length / 2);
      const ds    = downsampleWaveform(json.data, Math.min(6000, totalBars));
      const result = { mins: ds.mins, maxs: ds.maxs, norm };
      waveCache.set(path, result);
      waveData = result;
    } catch (_e) {
      waveCache.set(path, 'error');
      waveData = null;
    } finally {
      waveLoading = false;
    }
  }

  async function handleRegenWaveform(pps) {
    if (!editingAccess || !selected || regenLoading || reanalyzeBusy) return;
    regenLoading = true;
    try {
      const res = await fetch(
        `${PRIVATE_API_BASE}/api/samples/${encodeURIComponent(selected.id)}/regenerate-waveform`,
        { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pixelsPerSecond: pps }) },
      );
      if (!res.ok) throw new Error(`${res.status}`);
      const { waveformPath } = await res.json();
      waveCache.delete(selected.waveformPath);
      waveCache.delete(waveformPath);
      selected = { ...selected, waveformPath };
      await loadWaveform(waveformPath);
    } catch (e) {
      console.error('Waveform regen failed:', e);
    } finally {
      regenLoading = false;
    }
  }

  async function fetchAnnotations(sampleId) {
    annotationsLoading = true;
    annotationsError   = '';
    try {
      const res = await fetch(`${PUBLIC_API_BASE}/api/samples/${encodeURIComponent(sampleId)}/annotations`, {
        signal: AbortSignal.timeout(8000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      annotations = await res.json();
      syncSampleFragmentsFromAnnotations();
    } catch (e) {
      annotationsError = e?.message ?? 'Failed to load annotations';
      annotations = [];
    } finally {
      annotationsLoading = false;
    }
  }

  async function selectSample(sample, seekSec = null, preserveWindowReviewFocus = false) {
    if (reanalyzeBusy) return;
    if (!preserveWindowReviewFocus) {
      focusedReviewKey = null;
      appliedReviewKey = null;
      lingeringWindowReview = null;
    }
    if (audioEl && isPlaying) audioEl.pause();
    isPlaying      = false;
    playbackMode   = 'normal';
    approverRangeIndex = 0;
    currentTime    = 0;
    duration       = sample.durationSec || 0;
    pendingSeekSec = seekSec;
    hoveredSidebarSampleId = null;
    selected       = sample;
    selectedAnnId  = null;
    hoveredAnnId   = null;
    editingNoteId  = null;
    addingSampleNote = false;
    pending        = null;
    dragMode       = null;
    mutationError  = '';
    reanalyzeConfirm = false;
    reanalyzeThreshold = 0.9;
    reanalyzeError = '';
    waveData       = null;
    annotations    = [];
    history.replaceState(null, '', '#' + sample.id);
    await Promise.all([loadWaveform(sample.waveformPath), fetchAnnotations(sample.id)]);
  }

  /** Clicking the already-selected sample's row deselects it (back to the
   * corpus summary), rather than doing nothing. */
  function toggleSample(sample) {
    if (selected?.id === sample.id) deselectSample();
    else selectSample(sample);
  }

  function deselectSample() {
    if (reanalyzeBusy) return;
    focusedReviewKey = null;
    appliedReviewKey = null;
    lingeringWindowReview = null;
    if (audioEl && isPlaying) audioEl.pause();
    isPlaying        = false;
    playbackMode     = 'normal';
    approverRangeIndex = 0;
    currentTime      = 0;
    duration         = 0;
    pendingSeekSec   = null;
    hoveredSidebarSampleId = null;
    selected         = null;
    selectedAnnId    = null;
    hoveredAnnId     = null;
    editingNoteId    = null;
    addingSampleNote = false;
    pending          = null;
    dragMode         = null;
    mutationError    = '';
    waveData         = null;
    reanalyzeConfirm = false;
    reanalyzeThreshold = 0.9;
    reanalyzeError = '';
    annotations      = [];
    history.replaceState(null, '', location.pathname + location.search);
  }

  /** Arrow up/down: move selection to the previous/next item in the
   * (possibly filtered) sidebar list. Reuses selectSample, which already
   * discards any unsaved pending fragment / in-progress note edit as part
   * of its normal cleanup. No wraparound past either end of the list. */
  function selectAdjacentSample(delta) {
    const list = filteredSamples;
    if (!list.length) return;
    if (!selected) {
      selectSample(delta > 0 ? list[0] : list[list.length - 1]);
      return;
    }
    const idx = list.findIndex(s => s.id === selected.id);
    if (idx === -1) {
      selectSample(delta > 0 ? list[0] : list[list.length - 1]);
      return;
    }
    const nextIdx = idx + delta;
    if (nextIdx < 0 || nextIdx >= list.length) return;
    selectSample(list[nextIdx]);
  }

  /** Fragments of the selected sample, in timeline order — the order arrow
   * left/right navigation moves through. */
  const sortedFragments = $derived(renderFragments.slice().sort((a, b) => a.startSec - b.startSec));

  /** Arrow left/right: move focus to the previous/next fragment of the
   * selected sample, so its label/boundaries can be edited. No wraparound;
   * if nothing is focused yet, right picks the first fragment and left
   * picks the last. */
  function selectAdjacentFragment(delta) {
    if (!editingAccess || reanalyzeBusy) return;
    const list = sortedFragments;
    if (!list.length) return;
    const idx = list.findIndex(f => f.id === selectedAnnId);
    if (idx === -1) {
      selectedAnnId = (delta > 0 ? list[0] : list[list.length - 1]).id;
      return;
    }
    const nextIdx = idx + delta;
    if (nextIdx < 0 || nextIdx >= list.length) return;
    selectedAnnId = list[nextIdx].id;
  }

  function audioSrc(sample) {
    return `${ASSET_BASE}/${encodeURIComponent(sample.audioPath).replace(/%2F/g, '/')}`;
  }

  function applyPendingSeek() {
    if (!audioEl || pendingSeekSec == null) return;
    const maxTime = Number.isFinite(audioEl.duration) ? audioEl.duration : duration;
    const seekSec = Math.max(0, Math.min(pendingSeekSec, maxTime || pendingSeekSec));
    audioEl.currentTime = seekSec;
    currentTime = seekSec;
    pendingSeekSec = null;
  }

  /** Open a projection dot in the existing sample editor and seek the full
   * recording to the analysis window represented by that dot. */
  async function openProjectionPoint(point) {
    const sample = samples.find((candidate) =>
      candidate.audioPath === point.originalAudio || candidate.id === point.originalRecording
    );
    if (!sample) return `The parent recording “${point.originalRecording}” is not in the current sample list.`;
    void selectSample(sample, point.recordingStart);
    await tick();
    if (audioEl?.readyState >= 1) applyPendingSeek();
  }

  async function focusWindowReviewCandidate(candidate) {
    if (!candidate || reanalyzeBusy || windowReviewBusy) return;
    const candidateIndex = visibleWindowReviewCandidates.findIndex(
      item => item.reviewKey === candidate.reviewKey
    );
    if (focusedReviewKey !== candidate.reviewKey) appliedReviewKey = null;
    focusedReviewKey = candidate.reviewKey;
    // Snapshot every focused row. A manual waveform edit makes the projection
    // bounds stale immediately, but the row should remain until focus moves.
    lingeringWindowReview = {
      candidate,
      index: Math.max(0, candidateIndex),
      tab: windowReviewTab,
    };
    windowReviewError = '';
    const sample = samples.find((item) => item.id === candidate.sampleId);
    if (!sample) {
      windowReviewError = 'The parent recording is not in the current sample list.';
      return;
    }

    const seekSec = candidate.targetWindow?.recordingStart ?? candidate.expected.startMs / 1000;
    if (selected?.id !== sample.id) await selectSample(sample, seekSec, true);
    else {
      pendingSeekSec = seekSec;
      applyPendingSeek();
    }
    selectedAnnId = candidate.annotationId;
    await tick();
    if (audioEl?.readyState >= 1) applyPendingSeek();
    const targetStart = candidate.targetWindow?.recordingStart ?? candidate.expected.startMs / 1000;
    const targetEnd = Number.isFinite(candidate.targetWindow?.recordingEnd)
      ? candidate.targetWindow.recordingEnd
      : candidate.expected.endMs / 1000;
    scrollWaveformRangeIntoView(
      candidate.expected.startMs / 1000,
      candidate.expected.endMs / 1000,
      (targetStart + targetEnd) / 2,
    );
  }

  function selectWindowReviewTab(tab) {
    if (windowReviewTab === tab) return;
    windowReviewTab = tab;
    focusedReviewKey = null;
    appliedReviewKey = null;
    lingeringWindowReview = null;
    windowReviewError = '';
  }

  function focusAdjacentWindowReviewCandidate(delta) {
    if (!visibleWindowReviewCandidates.length || windowReviewBusy) return;
    const currentIndex = visibleWindowReviewCandidates.findIndex(
      candidate => candidate.reviewKey === focusedReviewKey
    );
    const startIndex = currentIndex === -1 ? (delta > 0 ? -1 : visibleWindowReviewCandidates.length) : currentIndex;
    const nextIndex = Math.max(0, Math.min(visibleWindowReviewCandidates.length - 1, startIndex + delta));
    void focusWindowReviewCandidate(visibleWindowReviewCandidates[nextIndex]);
  }

  async function submitWindowReview(action) {
    const candidate = focusedReviewCandidate;
    if (!candidate || !editingAccess || windowReviewBusy || focusedWindowReviewApplied) return;
    const currentIndex = visibleWindowReviewCandidates.findIndex(
      item => item.reviewKey === candidate.reviewKey
    );
    windowReviewBusy = true;
    windowReviewError = '';
    let nextCandidate = null;
    try {
      const res = await fetch(`${PRIVATE_API_BASE}/api/annotations/${candidate.annotationId}/window-review`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action,
          expected: candidate.expected,
          proposal: action === 'keep' || action === 'unkeep' ? undefined : candidate.proposal,
        }),
        signal: AbortSignal.timeout(8000),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error ?? `HTTP ${res.status}`);

      const changedIds = new Set(data.annotations.map(annotation => annotation.id));
      allAnnotations = [
        ...allAnnotations.filter(annotation => !changedIds.has(annotation.id)),
        ...data.annotations,
      ];
      if (selected?.id === candidate.sampleId) {
        annotations = [
          ...annotations.filter(annotation => !changedIds.has(annotation.id)),
          ...data.annotations,
        ].sort((a, b) => a.startSec - b.startSec);
        syncSampleFragmentsFromAnnotations();
      }

      if (action === 'keep' || action === 'unkeep') {
        focusedReviewKey = null;
        appliedReviewKey = null;
        lingeringWindowReview = null;
        await tick();
        nextCandidate = visibleWindowReviewCandidates[
          Math.min(currentIndex, visibleWindowReviewCandidates.length - 1)
        ] ?? null;
      } else {
        appliedReviewKey = candidate.reviewKey;
        selectedAnnId = data.annotations.find(annotation => annotation.id === candidate.annotationId)?.id
          ?? data.annotations[0]?.id
          ?? null;
        await tick();
        pendingSeekSec = candidate.targetWindow.recordingStart;
        applyPendingSeek();
        const targetWindowEnd = Number.isFinite(candidate.targetWindow.recordingEnd)
          ? candidate.targetWindow.recordingEnd
          : candidate.targetWindow.recordingStart;
        scrollWaveformRangeIntoView(
          candidate.expected.startMs / 1000,
          candidate.expected.endMs / 1000,
          (candidate.targetWindow.recordingStart + targetWindowEnd) / 2,
        );
      }
    } catch (error) {
      windowReviewError = error?.message ?? 'Failed to review fragment';
      if (/changed since/.test(windowReviewError)) void fetchSidebarAnnotationSummary();
    } finally {
      windowReviewBusy = false;
    }
    if (nextCandidate) await focusWindowReviewCandidate(nextCandidate);
  }

  async function togglePlay() {
    if (!audioEl) return;
    if (isPlaying) audioEl.pause();
    else {
      playbackMode = 'normal';
      await audioEl.play().catch(() => {});
    }
  }

  function enforceApproverPlayback() {
    if (!audioEl) return;
    const ranges = approverRanges;
    const step = taggedPlaybackStep(ranges, audioEl.currentTime, approverRangeIndex);
    if (step.type === 'keep') {
      approverRangeIndex = step.index;
      return;
    }
    if (step.type === 'finished') {
      audioEl.pause();
      approverRangeIndex = 0;
      const restartTime = ranges[0]?.startSec ?? 0;
      audioEl.currentTime = restartTime;
      currentTime = restartTime;
      return;
    }
    approverRangeIndex = step.index;
    audioEl.currentTime = step.time;
    currentTime = step.time;
  }

  async function toggleApproverPlay() {
    if (!editingAccess || !audioEl || approverRanges.length === 0) return;
    if (isPlaying && playbackMode === 'approver') {
      audioEl.pause();
      return;
    }

    playbackMode = 'approver';
    approverRangeIndex = taggedRangeIndexAtOrAfter(approverRanges, audioEl.currentTime);
    if (approverRangeIndex < 0) approverRangeIndex = 0;
    const range = approverRanges[approverRangeIndex];
    if (audioEl.currentTime < range.startSec || audioEl.currentTime >= range.endSec) {
      audioEl.currentTime = range.startSec;
      currentTime = range.startSec;
    }
    if (!isPlaying) await audioEl.play().catch(() => {});
  }

  // ── Waveform pointer interaction ───────────────────────────────────────────

  function svgFraction(clientX) {
    if (!waveSvgEl) return 0;
    const rect = waveSvgEl.getBoundingClientRect();
    if (!rect.width) return 0;
    return Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
  }

  function onWaveMouseDown(e) {
    if (!selected || !duration) return;
    const sec  = svgFraction(e.clientX) * duration;
    if (!editingAccess || reanalyzeBusy) {
      if (audioEl) audioEl.currentTime = sec;
      currentTime = sec;
      return;
    }
    const role = e.target?.dataset?.role;
    const annId = e.target?.dataset?.annId ? Number(e.target.dataset.annId) : null;

    if ((role === 'handle-start' || role === 'handle-end') && annId != null) {
      const ann = annotations.find(a => a.id === annId);
      if (!ann) return;
      dragMode      = role === 'handle-start' ? 'resize-start' : 'resize-end';
      dragAnnId     = annId;
      dragOrigStart = ann.startSec;
      dragOrigEnd   = ann.endSec;
      dragCurrentSec = sec;
      selectedAnnId = annId;
    } else if (role === 'fragment-body' && annId != null) {
      const ann = annotations.find(a => a.id === annId);
      if (!ann) return;
      if (selectedAnnId === annId) {
        dragMode       = 'move';
        dragAnnId      = annId;
        dragOrigStart  = ann.startSec;
        dragOrigEnd    = ann.endSec;
        dragStartSec   = sec;
        dragCurrentSec = sec;
      } else {
        selectedAnnId = annId;
      }
    } else if (role === 'note-marker' && annId != null) {
      const ann = annotations.find(a => a.id === annId);
      if (ann) startEditNote(ann);
    } else {
      dragMode       = 'brush';
      dragStartSec   = sec;
      dragCurrentSec = sec;
      selectedAnnId  = null;
      pending        = null;
    }
  }

  function onWindowMouseMove(e) {
    if (!dragMode || !duration) return;
    dragCurrentSec = svgFraction(e.clientX) * duration;
  }

  function onWindowMouseUp() {
    if (!dragMode) return;
    const mode = dragMode;

    if (mode === 'brush') {
      const a = Math.min(dragStartSec, dragCurrentSec);
      const b = Math.max(dragStartSec, dragCurrentSec);
      dragMode = null;
      if (b - a < BRUSH_MIN_SEC) {
        if (audioEl) audioEl.currentTime = a;
      } else {
        pending         = { startSec: a, endSec: b };
        pendingLabel    = selected?.label ?? LABELS[0];
        pendingNoteText = '';
      }
      return;
    }

    // Compute the final bounds while dragMode is still set — previewBounds()
    // returns the *unchanged* original bounds once dragMode is cleared.
    const ann = annotations.find(a => a.id === dragAnnId);
    const bounds = ann ? previewBounds(ann) : null;
    dragMode = null;
    if (!ann || !bounds) return;
    commitAnnotationBounds(ann, bounds.startSec, bounds.endSec);
  }

  // ── Annotation mutations ────────────────────────────────────────────────────

  async function commitAnnotationBounds(ann, startSec, endSec) {
    if (!editingAccess || reanalyzeBusy) return;
    mutationError = '';
    try {
      const res = await fetch(`${PRIVATE_API_BASE}/api/annotations/${ann.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ startSec, endSec }),
        signal: AbortSignal.timeout(8000),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error ?? `HTTP ${res.status}`);
      annotations = annotations.map(a => a.id === ann.id ? data : a).sort((a, b) => a.startSec - b.startSec);
      syncSampleFragmentsFromAnnotations();
    } catch (e) {
      mutationError = e?.message ?? 'Failed to update annotation';
    }
  }

  async function commitFragment() {
    if (!editingAccess || reanalyzeBusy || !pending || !selected) return;
    mutationError = '';
    try {
      const res = await fetch(`${PRIVATE_API_BASE}/api/samples/${encodeURIComponent(selected.id)}/annotations`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ startSec: pending.startSec, endSec: pending.endSec, label: pendingLabel, source: 'manual' }),
        signal: AbortSignal.timeout(8000),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error ?? `HTTP ${res.status}`);
      annotations = [...annotations, data].sort((a, b) => a.startSec - b.startSec);
      syncSampleFragmentsFromAnnotations();
      pending = null;
    } catch (e) {
      mutationError = e?.message ?? 'Failed to add fragment';
    }
  }

  async function commitNote() {
    if (!editingAccess || reanalyzeBusy || !pending || !selected || !pendingNoteText.trim()) return;
    mutationError = '';
    try {
      const res = await fetch(`${PRIVATE_API_BASE}/api/samples/${encodeURIComponent(selected.id)}/annotations`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          startSec: pending.startSec, endSec: pending.startSec,
          label: pendingNoteText.trim(), source: 'note',
        }),
        signal: AbortSignal.timeout(8000),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error ?? `HTTP ${res.status}`);
      annotations = [...annotations, data].sort((a, b) => a.startSec - b.startSec);
      pending         = null;
      pendingNoteText = '';
    } catch (e) {
      mutationError = e?.message ?? 'Failed to add note';
    }
  }

  function cancelPending() {
    pending         = null;
    pendingNoteText = '';
  }

  /** Svelte action: focus an input as soon as it's mounted (e.g. a freshly opened inline edit field). */
  function autofocusAction(node) {
    node.focus();
  }

  async function relabelSelected(newLabel) {
    if (!editingAccess || reanalyzeBusy || bulkRelabelBusy) return;
    const ann = annotations.find(a => a.id === selectedAnnId);
    if (!ann) return;
    mutationError = '';
    try {
      const res = await fetch(`${PRIVATE_API_BASE}/api/annotations/${ann.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ label: newLabel }),
        signal: AbortSignal.timeout(8000),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error ?? `HTTP ${res.status}`);
      annotations = annotations.map(a => a.id === ann.id ? data : a);
      syncSampleFragmentsFromAnnotations();
    } catch (e) {
      mutationError = e?.message ?? 'Failed to update annotation';
    }
  }

  // ── Note editing (inline, in the notes panel) ──────────────────────────────

  function startEditNote(ann) {
    if (!editingAccess || reanalyzeBusy) return;
    selectedAnnId = ann.id;
    editingNoteId = ann.id;
    editLabel     = ann.label;
  }

  async function saveNoteLabel(annId, text) {
    if (!editingAccess || reanalyzeBusy) return;
    const ann     = annotations.find(a => a.id === annId);
    editingNoteId = null;
    const trimmed = text.trim();
    if (!ann || !trimmed || trimmed === ann.label) return;
    mutationError = '';
    try {
      const res = await fetch(`${PRIVATE_API_BASE}/api/annotations/${annId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ label: trimmed }),
        signal: AbortSignal.timeout(8000),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error ?? `HTTP ${res.status}`);
      annotations = annotations.map(a => a.id === annId ? data : a);
      if (isSampleWideNote(data)) setSampleNotePreview(data.sampleId, data.label);
    } catch (e) {
      mutationError = e?.message ?? 'Failed to update note';
    }
  }

  // ── Sample-wide note (time code 0ms) — no fragment/selection needed ───────

  function startSampleWideNote() {
    if (!editingAccess || reanalyzeBusy || hasSampleWideNote || addingSampleNote || !selected) return;
    addingSampleNote  = true;
    newSampleNoteText = '';
  }

  function cancelSampleWideNoteDraft() {
    addingSampleNote  = false;
    newSampleNoteText = '';
  }

  async function commitSampleWideNote() {
    if (!editingAccess || reanalyzeBusy || !addingSampleNote) return;
    const text = newSampleNoteText.trim();
    addingSampleNote = false;
    if (!text || !selected) return;
    mutationError = '';
    try {
      const res = await fetch(`${PRIVATE_API_BASE}/api/samples/${encodeURIComponent(selected.id)}/annotations`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ startSec: 0, endSec: 0, label: text, source: 'note' }),
        signal: AbortSignal.timeout(8000),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error ?? `HTTP ${res.status}`);
      annotations = [...annotations, data].sort((a, b) => a.startSec - b.startSec);
      setSampleNotePreview(data.sampleId, data.label);
    } catch (e) {
      mutationError = e?.message ?? 'Failed to add sample note';
    }
  }

  // ── Deletion (any annotation, by id) ───────────────────────────────────────

  async function deleteAnnotationById(annId) {
    if (!editingAccess || reanalyzeBusy) return;
    const ann = annotations.find(a => a.id === annId);
    if (!ann) return;
    const replacementAnnId = ann.source === 'note'
      ? null
      : fragmentSelectionAfterDelete(annotations, ann.id);
    mutationError = '';
    try {
      const res = await fetch(`${PRIVATE_API_BASE}/api/annotations/${ann.id}`, {
        method: 'DELETE', signal: AbortSignal.timeout(8000),
      });
      if (!res.ok && res.status !== 204) throw new Error(`HTTP ${res.status}`);
      annotations = annotations.filter(a => a.id !== ann.id);
      // Only advance if this fragment is still selected. The reviewer may
      // have selected something else while the delete request was in flight.
      if (selectedAnnId === ann.id) selectedAnnId = replacementAnnId;
      if (editingNoteId === ann.id) editingNoteId = null;
      if (isSampleWideNote(ann)) setSampleNotePreview(ann.sampleId, null);
      else syncSampleFragmentsFromAnnotations();
    } catch (e) {
      mutationError = e?.message ?? 'Failed to delete annotation';
    }
  }

  async function deleteSelectedAnnotation() {
    if (editingAccess && selectedAnnId != null) await deleteAnnotationById(selectedAnnId);
  }

  // ── Sample-level mutations ─────────────────────────────────────────────────

  function openReanalyzeConfirm() {
    if (!editingAccess || !selected || reanalyzeBusy) return;
    deleteConfirm = false;
    reanalyzeError = '';
    reanalyzeConfirm = true;
  }

  function cancelReanalyze() {
    if (reanalyzeBusy) return;
    reanalyzeConfirm = false;
  }

  async function confirmReanalyzeSample() {
    if (!editingAccess || !selected || !reanalyzeConfirm || reanalyzeBusy) return;
    const sample = selected;
    reanalyzeConfirm = false;
    reanalyzeBusy = true;
    reanalyzeError = '';
    pending = null;
    selectedAnnId = null;
    hoveredAnnId = null;
    editingNoteId = null;
    addingSampleNote = false;
    dragMode = null;
    try {
      const res = await fetch(
        `${PRIVATE_API_BASE}/api/samples/${encodeURIComponent(sample.id)}/reanalyze`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ candidateThreshold: reanalyzeThreshold }),
        },
      );
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error(data?.error ?? `HTTP ${res.status}`);
      if (!Array.isArray(data?.annotations)) throw new Error('Re-analysis response has invalid annotations');
      if (selected?.id === sample.id) {
        annotations = data.annotations;
        syncSampleFragmentsFromAnnotations();
      }
    } catch (e) {
      reanalyzeError = e?.message ?? 'Failed to re-analyze sample';
    } finally {
      reanalyzeBusy = false;
    }
  }

  async function confirmDeleteSample() {
    if (!editingAccess || reanalyzeBusy || !selected) return;
    deleteBusy = true;
    try {
      const res = await fetch(`${PRIVATE_API_BASE}/api/samples/${encodeURIComponent(selected.id)}`, {
        method: 'DELETE', signal: AbortSignal.timeout(15000),
      });
      if (!res.ok && res.status !== 204) throw new Error(`HTTP ${res.status}`);
      samples       = samples.filter(s => s.id !== selected.id);
      selected      = null;
      deleteConfirm = false;
    } catch (e) {
      mutationError = e?.message ?? 'Failed to delete sample';
    } finally {
      deleteBusy = false;
    }
  }

  async function changeCategory(newLabel) {
    if (!editingAccess || reanalyzeBusy || bulkRelabelBusy || !selected || newLabel === selected.label) return;
    renameBusy  = true;
    renameError = '';
    try {
      const res = await fetch(`${PRIVATE_API_BASE}/api/samples/${encodeURIComponent(selected.id)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ label: newLabel }),
        signal: AbortSignal.timeout(15000),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error ?? `HTTP ${res.status}`);
      samples = samples.map(s => s.id === selected.id ? data : s);
      if (audioEl && isPlaying) audioEl.pause();
      isPlaying   = false;
      currentTime = 0;
      selected    = data;
      waveData    = null;
      await Promise.all([loadWaveform(data.waveformPath), fetchAnnotations(data.id)]);
    } catch (e) {
      renameError = e?.message ?? 'Failed to change category';
    } finally {
      renameBusy = false;
    }
  }

  /** Shift + a label hotkey reclassifies every fragment in the open sample,
   * then changes the sample category. Notes are deliberately left alone. */
  async function relabelAllFragmentsAndSample(newLabel) {
    if (!editingAccess || !selected || reanalyzeBusy || renameBusy || bulkRelabelBusy || !LABELS.includes(newLabel)) return;

    const sample = selected;
    const fragments = fragmentRelabelTargets(annotations, newLabel);
    bulkRelabelBusy = true;
    mutationError = '';
    renameError = '';

    try {
      // Wait for every request to settle so recovery does not race requests
      // that are still updating other fragments.
      const results = await Promise.allSettled(fragments.map(async (ann) => {
        const res = await fetch(`${PRIVATE_API_BASE}/api/annotations/${ann.id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ label: newLabel }),
          signal: AbortSignal.timeout(8000),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data?.error ?? `HTTP ${res.status}`);
        return data;
      }));

      const updatedById = new Map();
      let updateError = null;
      for (const result of results) {
        if (result.status === 'fulfilled') updatedById.set(result.value.id, result.value);
        else updateError ??= result.reason;
      }
      if (selected?.id === sample.id && updatedById.size > 0) {
        annotations = annotations.map(a => updatedById.get(a.id) ?? a);
        syncSampleFragmentsFromAnnotations();
      }
      if (updateError) throw updateError;

      if (sample.label !== newLabel) {
        const res = await fetch(`${PRIVATE_API_BASE}/api/samples/${encodeURIComponent(sample.id)}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ label: newLabel }),
          signal: AbortSignal.timeout(15000),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data?.error ?? `HTTP ${res.status}`);
        samples = samples.map(s => s.id === sample.id ? data : s);

        if (selected?.id === sample.id) {
          if (audioEl && isPlaying) audioEl.pause();
          isPlaying = false;
          currentTime = 0;
          selected = data;
          waveData = null;
          history.replaceState(null, '', '#' + data.id);
          await Promise.all([loadWaveform(data.waveformPath), fetchAnnotations(data.id)]);
        }
      }

      void fetchSidebarAnnotationSummary();
    } catch (e) {
      mutationError = e?.message ?? 'Failed to update all fragments and the sample label';
      // Bulk updates can partially succeed. Refresh the still-open sample so
      // the UI reflects the server and retrying only applies missing changes.
      if (selected?.id === sample.id) await fetchAnnotations(sample.id);
      void fetchSamples();
      void fetchSidebarAnnotationSummary();
    } finally {
      bulkRelabelBusy = false;
    }
  }

  // ── Keyboard shortcuts ──────────────────────────────────────────────────────

  function handleKeydown(e) {
    const inField = e.target?.tagName === 'INPUT' || e.target?.tagName === 'SELECT' || e.target?.tagName === 'TEXTAREA';

    if (selected && !inField && !e.ctrlKey && !e.metaKey && !e.altKey) {
      if (e.key === '+' || e.key === '=') {
        e.preventDefault();
        changeWaveZoom(1);
      } else if (e.key === '-') {
        e.preventDefault();
        changeWaveZoom(-1);
      } else if (e.key === '0') {
        e.preventDefault();
        void setWaveSecondsPerPixel(FIT_WAVEFORM_SECONDS_PER_PIXEL);
      }
    }

    if (editingAccess && e.key === 'Escape') {
      if (reanalyzeConfirm) { reanalyzeConfirm = false; return; }
      if (pending) { pending = null; return; }
      if (selectedAnnId != null) { selectedAnnId = null; return; }
    }
    if (reanalyzeConfirm || reanalyzeBusy || bulkRelabelBusy) return;
    // Allow AltGraph-produced brackets as well as direct [ / ] keys.
    if (editingAccess && !inField && !e.metaKey && (e.key === '[' || e.key === ']')) {
      e.preventDefault();
      focusAdjacentWindowReviewCandidate(e.key === ']' ? 1 : -1);
      return;
    }
    if (editingAccess && !inField && !e.ctrlKey && !e.metaKey && !e.altKey) {
      if (
        e.key.toLowerCase() === 'p'
        && windowReviewTab === 'contrast'
        && focusedReviewCandidate?.action
        && !focusedWindowReviewApplied
      ) {
        e.preventDefault();
        void submitWindowReview(focusedReviewCandidate.action);
        return;
      }
      if (e.key.toLowerCase() === 'k' && focusedReviewCandidate && !focusedWindowReviewApplied) {
        e.preventDefault();
        void submitWindowReview(windowReviewTab === 'kept' ? 'unkeep' : 'keep');
        return;
      }
    }
    if (editingAccess && !inField && (e.key === 'Delete' || e.key === 'Backspace') && selectedAnnId != null) {
      e.preventDefault();
      deleteSelectedAnnotation();
    }
    if (editingAccess && !inField && e.key === 'Enter' && pending) {
      e.preventDefault();
      commitFragment();
    }
    if (!inField && !e.ctrlKey && !e.metaKey && !e.altKey && e.key === ' ') {
      e.preventDefault();
      if (!e.repeat) {
        if (e.shiftKey) void toggleApproverPlay();
        else void togglePlay();
      }
    }
    if (!inField && (e.key === 'ArrowUp' || e.key === 'ArrowDown' || e.key === 'q' || e.key === 'w')) {
      e.preventDefault();
      selectAdjacentSample((e.key === 'ArrowDown' || e.key === 'w') ? 1 : -1);
    }
    if (editingAccess && !inField && selected && (e.key === 'ArrowRight' || e.key === 'ArrowLeft')) {
      e.preventDefault();
      selectAdjacentFragment(e.key === 'ArrowRight' ? 1 : -1);
    }
    // Label shortcuts: Shift applies valid sample labels to every fragment and
    // the sample itself; without Shift, classify/relabel one fragment as before.
    if (editingAccess && !inField && !e.ctrlKey && !e.metaKey && !e.altKey) {
      const action = trainingLabelActionForShortcut(e.key, e.shiftKey);
      if (action?.scope === 'sample' && selected) {
        e.preventDefault();
        void relabelAllFragmentsAndSample(action.label);
      } else if (action?.scope === 'fragment') {
        if (pending) {
          e.preventDefault();
          pendingLabel = action.label;
          void commitFragment();
        } else if (selectedAnnId != null) {
          const ann = annotations.find(a => a.id === selectedAnnId);
          if (ann && ann.source !== 'note') {
            e.preventDefault();
            void relabelSelected(action.label);
          }
        }
      }
    }
  }

  function handleKeyup(e) {
    if (e.key === 'Shift') hoveredSidebarSampleId = null;
  }

  onMount(() => {
    let disposed = false;
    void probeEditingAccess().then((available) => {
      if (!disposed) editingAccess = available;
    });
    void loadTrainingProjectionPoints()
      .then((points) => {
        if (!disposed) projectionPoints = points;
      })
      .catch((error) => {
        if (!disposed) projectionReviewError = error?.message ?? 'Failed to load projection data';
      });
    return () => {
      disposed = true;
    };
  });

  fetchSamples();
  fetchSidebarAnnotationSummary();

  function handleHashChange() {
    const id = window.location.hash.slice(1);
    if (!id) { if (selected) deselectSample(); return; }
    if (selected?.id === id) return;
    const target = samples.find(s => s.id === id);
    if (target) selectSample(target);
  }
</script>

<svelte:head>
  <title>Training corpus summary · Barktown</title>
</svelte:head>

<svelte:window onmousemove={onWindowMouseMove} onmouseup={onWindowMouseUp} onkeydown={handleKeydown} onkeyup={handleKeyup} onhashchange={handleHashChange} />

<div class="app" class:embedded>
  {#if !embedded}<header class="site-header">
    <a class="brand" href="/">🐕 Barktown</a>
    <nav aria-label="Barktown views">
      <a href="/diary">Diary</a>
      <a href="/report">Report</a>
      <a class="current" aria-current="page" href="/training">Training</a>
      {#if editingAccess}<a href="/quality">Quality</a>{/if}
      <a href="/method">Method</a>
    </nav>
    <GoblinPiStatus />
  </header>{/if}

  <div class="training-body">
    {#if !embedded}<aside class="samples-pane" class:collapsed={samplesSidebarCollapsed} aria-label="Training samples">
      <button
        class="sidebar-toggle"
        type="button"
        aria-controls="training-samples-sidebar-content"
        aria-expanded={!samplesSidebarCollapsed}
        aria-label={samplesSidebarCollapsed ? 'Expand sample sidebar' : 'Collapse sample sidebar'}
        title={samplesSidebarCollapsed ? 'Expand samples' : 'Collapse samples'}
        onclick={() => (samplesSidebarCollapsed = !samplesSidebarCollapsed)}
      >{samplesSidebarCollapsed ? '›' : '‹'}</button>
      <div id="training-samples-sidebar-content" class="samples-pane-content">
        <div class="samples-filter">
        {#each ALL_LABELS as lbl}
          <button class="filter-pill" class:active={filterLabel === lbl} onclick={() => (filterLabel = lbl)}>{lbl}</button>
        {/each}
        <button class="filter-pill reload-pill" onclick={reloadSidebar} title="Reload">
          {samplesLoading ? '…' : '↺'}
        </button>
        </div>

        {#if samplesError}
          <div class="samples-msg samples-err">{samplesError}</div>
        {:else if samplesLoading && samples.length === 0}
          <div class="samples-msg">Loading…</div>
        {:else if filteredSamples.length === 0}
          <div class="samples-msg">No samples{filterLabel !== 'all' ? ` for "${filterLabel}"` : ''}.</div>
        {:else}
          <div class="samples-list">
            {#each filteredSamples as sample, i (sample.id)}
              {@const notePreview = selected?.id === sample.id ? selectedSampleWideNote?.label : sampleNotes.get(sample.id)}
              {@const fragBlocks = sampleFragments.get(sample.id) ?? []}
              {@const sampleDay = sample.datetimeLocal.slice(0, 10)}
              {@const prevDay = i > 0 ? filteredSamples[i - 1].datetimeLocal.slice(0, 10) : null}
              {@const sampleTime = sample.datetimeLocal.slice(11, 19)}
              {#if sampleDay !== prevDay}
                <div class="day-header">{formatDate(sampleDay)}</div>
              {/if}
              <button
                class="sample-row"
                class:playing={selected?.id === sample.id}
                onpointerenter={(event) => {
                  if (event.shiftKey) hoveredSidebarSampleId = sample.id;
                }}
                onpointerleave={() => {
                  if (hoveredSidebarSampleId === sample.id) hoveredSidebarSampleId = null;
                }}
                onclick={() => toggleSample(sample)}
              >
                <span class="sample-label-pill" style:background={sampleLabelColor(sample.label)} title={sample.label}>{sample.label.slice(0, 3)}</span>
                <span class="sample-name">
                  <span class="sample-name-main">
                    {sampleTime}
                    {#if sample.diaryId}<span class="sample-diary-icon" title="Linked to diary entry">📖</span>{/if}
                  </span>
                  {#if notePreview}<span class="sample-note-preview">{notePreview}</span>{/if}
                </span>
                <span class="sample-dur">{formatDuration(sample.durationSec)}</span>
                {#if fragBlocks.length}
                  <span class="sample-frag-strip">
                    {#each fragBlocks as frag, i (i)}
                      <span
                        class="sample-frag-block"
                        style="left:{(frag.startFrac * 100).toFixed(2)}%; width:{Math.max(0.6, (frag.endFrac - frag.startFrac) * 100).toFixed(2)}%; background:{sampleLabelColor(frag.label)}"
                      ></span>
                    {/each}
                  </span>
                {/if}
              </button>
            {/each}
          </div>
        {/if}
      </div>
    </aside>{/if}

    <main class="editor-pane">
      {#if !selected}
        <h1 class="page-title">Training corpus summary</h1>
        <div class="corpus-summary">
          <TrainingProjectionScatterplot
            {samples}
            activeLabel={activeCorpusLabel}
            activeSampleId={hoveredSidebarSampleId}
            bind:colorEncoding={selectedColorEncoding}
            onwindowsummary={updateWindowSummary}
            onopen={openProjectionPoint}
          />

          <div class="corpus-summary-layout">
            <aside class="encoding-explanation" aria-live="polite">
              <div class="encoding-explanation-heading">
                <label class="encoding-title-control">
                  <span>Color dots by:</span>
                  <select bind:value={selectedColorEncoding}>
                    {#each TRAINING_COLOR_ENCODINGS as encoding}
                      <option value={encoding.value}>{encoding.label}</option>
                    {/each}
                  </select>
                </label>
                {#if selectedColorDomain}
                  <div class="explanation-color-legend" aria-label={`${selectedColorGuide.title} color scale`}>
                    <small>{formatColorScaleStart(selectedColorDomain.min)}</small>
                    <i></i>
                    <small>{formatColorScaleEnd(selectedColorDomain.max)}</small>
                  </div>
                {/if}
              </div>
              <section>
                <p>{selectedColorGuide.plain}</p>
              </section>
              <section>
                <p>{selectedColorGuide.detailed}</p>
              </section>
            </aside>

            <div class="corpus-summary-copy">
            <table class="corpus-table">
              <thead>
                <tr>
                  <th>Label</th>
                  <th>Duration</th>
                  <th>Occupancy</th>
                  <th>Samples</th>
                  <th>Fragments</th>
                  <th>Fragment durations<small>0.5s bins · hover for counts</small></th>
                  <th>Windows</th>
                  <th>Window durations<small>0.1s bins · hover for counts</small></th>
                </tr>
              </thead>
              <tbody>
                {#each LABELS as lbl}
                  {@const fragCount = fragmentCountsByLabel.get(lbl) ?? 0}
                  {@const guide = LABEL_GUIDELINES[lbl]}
                  <!-- svelte-ignore a11y_no_static_element_interactions a11y_click_events_have_key_events -->
                  <tr
                    class:filter-active={activeCorpusLabel === lbl}
                    class:filter-muted={activeCorpusLabel && activeCorpusLabel !== lbl}
                    onpointerenter={() => (hoveredCorpusLabel = lbl)}
                    onpointerleave={() => (hoveredCorpusLabel = null)}
                    onclick={() => toggleCorpusLabel(lbl)}
                    title={`Focus ${lbl}; click to ${pinnedCorpusLabel === lbl ? 'clear' : 'keep'} focus`}
                  >
                    <td><span class="sample-label-pill" style:background={sampleLabelColor(lbl)}>{lbl}</span></td>
                    <td class="corpus-guideline">{guide?.duration ?? '\u2014'}</td>
                    <td class="corpus-guideline">{guide?.occupancy ?? '\u2014'}</td>
                    <td>{sampleCountsByLabel.get(lbl) ?? 0}</td>
                    <td
                      class="corpus-frag-count"
                      class:corpus-low={fragCount < 30}
                      class:corpus-mid={fragCount >= 30 && fragCount < 100}
                      class:corpus-good={fragCount >= 100}
                    >{fragCount}</td>
                    <td class="corpus-chart-cell" title={fragmentDurationTitle(lbl)}>
                      <span class="chart">{fragmentDurationChart(lbl)}</span>
                    </td>
                    <td>{windowCountsByLabel.get(lbl)?.toLocaleString() ?? '—'}</td>
                    <td class="corpus-chart-cell" title={windowDurationTitle(lbl)}>
                      <span class="chart window-chart">{windowDurationChart(lbl)}</span>
                    </td>
                  </tr>
                {/each}
              </tbody>
            </table>
            <p class="corpus-summary-legend">
              Desired number of fragments: <span class="corpus-low">&lt;30 not enough</span> · <span class="corpus-mid">30–99 viable</span> · <span class="corpus-good">100+ good</span>
            </p>
            <p class="corpus-summary-legend">
              Hover the table row above to highlight the dots in scatterplot. Click to select.
            </p>
            </div>
          </div>
          <h1 class="section-title">
              Each dot is a window. What are YAMNet windows and how are they made?
          </h1>
          <img
            class="windows-explanation"
            src="/images/explanation-windows.png"
            alt="Explanation of how labelled fragments are divided into embedding windows"
          />
          <p class="corpus-summary-legend">
            <a href="https://www.youtube.com/watch?v=zD0jE6ZGeG0&t=156s" target="_blank">Learn more about YAMNET windows</a>
          </p>
        </div>
      {:else}
        <button class="corpus-back-btn" onclick={deselectSample}>← Back to corpus overview</button>

        <div class="editor-header">
          <span class="sample-label-pill" style:background={sampleLabelColor(selected.label)}>{selected.label}</span>
          <span class="editor-title">{formatSampleDatetime(selected.datetimeLocal, { seconds: true })}</span>
          <span class="editor-dur">{formatDuration(selected.durationSec)}</span>
          {#if selected.diaryId}
            <a class="cross-link-btn" href="/diary#{selected.diaryId}" title="View source diary entry">📖</a>
          {/if}

          {#if editingAccess}
            <label class="category-control">
              <span>Category</span>
              <select value={selected.label} disabled={renameBusy || reanalyzeBusy || bulkRelabelBusy} onchange={(e) => changeCategory(e.currentTarget.value)}>
                {#each LABELS as lbl}
                  <option value={lbl}>{lbl}</option>
                {/each}
              </select>
            </label>

            <button
              class="reanalyze-btn"
              disabled={reanalyzeBusy || renameBusy || deleteBusy || bulkRelabelBusy}
              onclick={openReanalyzeConfirm}
              title="Replace bark, review, and yap fragments using the current classifier"
            >{reanalyzeBusy ? 'Analyzing…' : 'Re-analyze'}</button>

            <button
              class="danger-btn"
              disabled={reanalyzeBusy || bulkRelabelBusy}
              onclick={() => { reanalyzeConfirm = false; deleteConfirm = true; }}
            >Delete sample</button>
          {/if}
        </div>

        {#if editingAccess && renameError}<div class="error-msg">{renameError}</div>{/if}
        {#if editingAccess && reanalyzeError}<div class="error-msg">{reanalyzeError}</div>{/if}
        {#if editingAccess && bulkRelabelBusy}<div class="bulk-relabel-status" role="status">Updating every fragment and the sample label…</div>{/if}

        {#if editingAccess && deleteConfirm}
          <div class="confirm-bar">
            <span>Delete this sample and its annotations? This cannot be undone.</span>
            <button class="danger-btn" disabled={deleteBusy} onclick={confirmDeleteSample}>
              {deleteBusy ? 'Deleting…' : 'Confirm delete'}
            </button>
            <button class="action-btn" onclick={() => (deleteConfirm = false)}>Cancel</button>
          </div>
        {:else if editingAccess && reanalyzeConfirm}
          <div class="confirm-bar reanalyze-confirm-bar">
            <span>Replace every bark, review, and yap fragment using the current detector settings?</span>
            <label class="reanalyze-threshold">
              <span>Threshold override: {reanalyzeThreshold.toFixed(2)}</span>
              <input
                type="range"
                min="0.8"
                max="1"
                step="0.01"
                bind:value={reanalyzeThreshold}
                disabled={reanalyzeBusy}
                aria-label="Re-analysis confidence threshold override"
              />
            </label>
            <button class="action-btn" disabled={reanalyzeBusy} onclick={confirmReanalyzeSample}>Run</button>
            <button class="action-btn" disabled={reanalyzeBusy} onclick={cancelReanalyze}>Cancel</button>
          </div>
        {/if}

        <!-- svelte-ignore a11y_media_has_caption -->
        <audio
          bind:this={audioEl}
          src={audioSrc(selected)}
          onplay={() => (isPlaying = true)}
          onpause={() => (isPlaying = false)}
          onended={() => {
            isPlaying = false;
            if (playbackMode === 'approver' && approverRanges.length > 0 && audioEl) {
              approverRangeIndex = 0;
              audioEl.currentTime = approverRanges[0].startSec;
              currentTime = approverRanges[0].startSec;
            }
          }}
          ontimeupdate={() => { if (audioEl) currentTime = audioEl.currentTime; }}
          onloadedmetadata={() => {
            if (audioEl) {
              duration = audioEl.duration || selected.durationSec;
              applyPendingSeek();
            }
          }}
        ></audio>

        <div class="player-controls">
          <button class="play-pause-btn" onclick={togglePlay} aria-label={isPlaying ? 'Pause' : 'Play'}>{isPlaying ? '⏸' : '▶'}</button>
          {#if editingAccess}
            <button
              class="approver-play-btn"
              class:active={playbackMode === 'approver'}
              onclick={toggleApproverPlay}
              disabled={annotationsLoading || approverRanges.length === 0}
              aria-label={isPlaying && playbackMode === 'approver' ? 'Pause approver listening' : 'Play tagged fragments only'}
              aria-pressed={playbackMode === 'approver'}
              title={annotationsLoading
                ? 'Loading tagged fragments…'
                : approverRanges.length === 0
                  ? 'No tagged fragments to play'
                  : 'Approver listening: play tagged fragments only (Shift+Space)'}
            >{isPlaying && playbackMode === 'approver' ? '⏸' : '▶┊▶'}</button>
          {/if}
          <span class="mini-time">{formatDuration(currentTime)} / {formatDuration(duration)}</span>
          {#if editingAccess}
            <span class="hint">Drag on the waveform to select a fragment · click a fragment to edit it · Delete removes the selection</span>
          {/if}
          <div class="player-tool-controls">
            {#if editingAccess && selected}
              <div class="wave-resolution-controls" role="group" aria-label="Waveform source resolution">
                <span class="regen-label">Resolution:</span>
                <button class="regen-btn" onclick={() => handleRegenWaveform(20)}  disabled={regenLoading || reanalyzeBusy} title="20 px/s (default)">20/s</button>
                <button class="regen-btn" onclick={() => handleRegenWaveform(50)}  disabled={regenLoading || reanalyzeBusy} title="50 px/s">50/s</button>
                <button class="regen-btn" onclick={() => handleRegenWaveform(100)} disabled={regenLoading || reanalyzeBusy} title="100 px/s">100/s</button>
              </div>
            {/if}
            <div class="wave-zoom-controls" role="group" aria-label="Horizontal waveform zoom">
              <span class="zoom-label">Zoom</span>
              <button
                class="zoom-btn"
                type="button"
                disabled={waveSecondsPerPixel === FIT_WAVEFORM_SECONDS_PER_PIXEL}
                title="Zoom out (−)"
                aria-label="Zoom waveform out"
                onclick={() => changeWaveZoom(-1)}
              >−</button>
              <button
                class="zoom-reset-btn"
                type="button"
                disabled={waveSecondsPerPixel === FIT_WAVEFORM_SECONDS_PER_PIXEL}
                title="Reset zoom (0)"
                aria-label="Reset waveform zoom"
                onclick={() => setWaveSecondsPerPixel(FIT_WAVEFORM_SECONDS_PER_PIXEL)}
              >{waveZoomLabel}</button>
              <button
                class="zoom-btn"
                type="button"
                disabled={waveSecondsPerPixel > 0 && waveSecondsPerPixel <= MIN_WAVEFORM_SECONDS_PER_PIXEL}
                title="Zoom in (+)"
                aria-label="Zoom waveform in"
                onclick={() => changeWaveZoom(1)}
              >+</button>
            </div>
          </div>
        </div>

        <div class="wave-editor-scroll" bind:this={waveScrollEl}>
        <div class="wave-editor-wrap" bind:this={waveWrapEl} style:width={waveWrapWidth}>
          <!-- Waveform bars are painted here at native pixel resolution
               instead of as hundreds of SVG <rect> nodes (see drawWaveCanvas). -->
          <canvas class="wave-canvas" bind:this={waveCanvasEl}></canvas>

          <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
          <svg
            class="wave-editor"
            class:readonly={!editingAccess || reanalyzeBusy}
            viewBox="0 0 {VW} {VH}"
            preserveAspectRatio="none"
            bind:this={waveSvgEl}
            onmousedown={onWaveMouseDown}
            role="img"
            aria-label={editingAccess && !reanalyzeBusy ? 'Waveform editor — drag to select a fragment' : 'Audio waveform — click to seek'}
          >
            {#if !waveData}
              <line x1="0" y1={VH / 2} x2={VW} y2={VH / 2} stroke={waveLoading ? '#c0d0f0' : '#e0e0e0'} stroke-width="1" />
            {/if}

            {#each renderFragments as ann (ann.id)}
              {@const x = secToX(ann.startSec)}
              {@const w = Math.max(zoomInvariantSvgWidth(2, waveScale), secToX(ann.endSec) - x)}
              <rect
                class="fragment-band"
                x={x} y="0" width={w} height={VH}
                fill={sampleLabelColor(ann.label)}
                opacity={selectedAnnId === ann.id ? 0.5 : hoveredAnnId === ann.id ? 0.4 : 0.3}
                data-role={editingAccess && !reanalyzeBusy ? 'fragment-body' : undefined}
                data-ann-id={editingAccess && !reanalyzeBusy ? ann.id : undefined}
                role="presentation"
                onmouseenter={() => (hoveredAnnId = ann.id)}
                onmouseleave={() => (hoveredAnnId = null)}
              ></rect>
              {#if editingAccess && !reanalyzeBusy && selectedAnnId === ann.id}
                {@const handleWidth = zoomInvariantSvgWidth(6, waveScale)}
                <rect class="frag-handle" x={x - handleWidth / 2} y={VH * (2 / 3)} width={handleWidth} height={VH / 3} data-role="handle-start" data-ann-id={ann.id}></rect>
                <rect class="frag-handle" x={x + w - handleWidth / 2} y={VH * (2 / 3)} width={handleWidth} height={VH / 3} data-role="handle-end" data-ann-id={ann.id}></rect>
              {/if}
            {/each}

            {#if focusedReviewTargetWindow && focusedReviewCandidate.sampleId === selected.id}
              {@const reviewWindowX = secToX(focusedReviewTargetWindow.recordingStart)}
              {@const reviewWindowWidth = Math.max(
                zoomInvariantSvgWidth(2, waveScale),
                secToX(focusedReviewTargetWindow.recordingEnd) - reviewWindowX,
              )}
              <rect
                class="review-window"
                x={reviewWindowX}
                y="1"
                width={reviewWindowWidth}
                height={VH - 2}
                rx="2"
                aria-label="Suspect classifier window"
              ></rect>
            {/if}

          {#each renderNotes as ann (ann.id)}
            {@const x = secToX(ann.startSec)}
            <line class="fixed-svg-stroke" x1={x} y1="0" x2={x} y2={VH} stroke={NOTE_COLOR} stroke-width={selectedAnnId === ann.id ? 3 : 2} data-role="note-marker" data-ann-id={ann.id}></line>
            <ellipse cx={x} cy="7" rx={zoomInvariantSvgWidth(5, waveScale)} ry="5" fill={NOTE_COLOR} data-role="note-marker" data-ann-id={ann.id}></ellipse>
          {/each}

          {#if pending}
            {@const x = secToX(pending.startSec)}
            {@const w = Math.max(zoomInvariantSvgWidth(1, waveScale), secToX(pending.endSec) - x)}
            <rect x={x} y="0" width={w} height={VH} fill="#1a1a1a" opacity="0.15"></rect>
          {/if}
          {#if dragMode === 'brush'}
            {@const x = secToX(Math.min(dragStartSec, dragCurrentSec))}
            {@const w = Math.max(zoomInvariantSvgWidth(1, waveScale), secToX(Math.max(dragStartSec, dragCurrentSec)) - x)}
            <rect x={x} y="0" width={w} height={VH} fill="#1a1a1a" opacity="0.12"></rect>
          {/if}

            <line class="fixed-svg-stroke" x1={playheadX} y1="0" x2={playheadX} y2={VH} stroke="#1a1a1a" stroke-width="1.5"></line>
          </svg>

          <!-- Fragment labels as an HTML overlay, not SVG <text>: stays a
               fixed pixel size regardless of the viewBox's non-uniform
               scaling, and only shown for the hovered/focused fragment so
               labels don't pile up when fragments are dense. -->
          <div class="fragment-labels-layer">
            {#each renderFragments as ann (ann.id)}
              {#if hoveredAnnId === ann.id || selectedAnnId === ann.id}
                {@const leftPct = (secToX(ann.startSec) / VW) * 100}
                <div class="fragment-label-html" style="left: {leftPct}%">
                  <span class="fragment-label-text">{ann.label}</span>
                  <span class="fragment-label-text fragment-dur">{(ann.endSec - ann.startSec).toFixed(1)}s</span>
                </div>
              {/if}
            {/each}
          </div>
        </div>
        </div>

        {#if mutationError}<div class="error-msg">{mutationError}</div>{/if}

        <div class="notes-panel">
          <div class="notes-panel-header">
            <span class="notes-panel-title">Notes</span>
            {#if editingAccess}
              <button
                class="action-btn"
                disabled={hasSampleWideNote || addingSampleNote}
                onclick={startSampleWideNote}
                title={hasSampleWideNote ? 'This sample already has a sample-wide note' : ''}
              >
                + Add a note
              </button>
            {/if}
          </div>

          {#if addingSampleNote}
            <div class="note-row-item">
              <span class="note-time">Sample-wide</span>
              <input
                class="note-input"
                placeholder="Note for the whole sample…"
                bind:value={newSampleNoteText}
                use:autofocusAction
                onkeydown={(e) => {
                  if (e.key === 'Enter') { e.preventDefault(); e.currentTarget.blur(); }
                  if (e.key === 'Escape') { e.preventDefault(); cancelSampleWideNoteDraft(); e.currentTarget.blur(); }
                }}
                onblur={commitSampleWideNote}
              />
            </div>
          {/if}

          {#each sortedNotes as note (note.id)}
            <div class="note-row-item" class:selected={selectedAnnId === note.id}>
              <span class="note-time">{isSampleWideNote(note) ? 'Sample-wide' : formatDuration(note.startSec)}</span>
              {#if editingAccess && editingNoteId === note.id}
                <input
                  class="note-input"
                  bind:value={editLabel}
                  use:autofocusAction
                  onkeydown={(e) => {
                    if (e.key === 'Enter') { e.preventDefault(); e.currentTarget.blur(); }
                    if (e.key === 'Escape') { e.preventDefault(); editingNoteId = null; e.currentTarget.blur(); }
                  }}
                  onblur={() => { if (editingNoteId === note.id) saveNoteLabel(note.id, editLabel); }}
                />
              {:else if editingAccess}
                <button class="note-text-btn" onclick={() => startEditNote(note)}>{note.label}</button>
              {:else}
                <span class="note-text-static">{note.label}</span>
              {/if}
              {#if editingAccess}
                <button class="note-delete-btn" title="Delete note" onclick={() => deleteAnnotationById(note.id)}>×</button>
              {/if}
            </div>
          {/each}

          {#if !addingSampleNote && sortedNotes.length === 0}
            <div class="notes-empty">No notes yet.</div>
          {/if}
        </div>
        {#if outOfBoundsFragments.length > 0}
          <div class="oob-panel">
            <div class="oob-panel-header">
              <span class="oob-panel-title">Out-of-bounds fragments</span>
              <span class="oob-panel-hint">These start beyond the sample's duration ({formatDuration(selected.durationSec)}) and will be skipped on export.</span>
            </div>
            {#each outOfBoundsFragments as ann (ann.id)}
              <div class="oob-row">
                <span class="sample-label-pill" style:background={sampleLabelColor(ann.label)}>{ann.label.slice(0, 3)}</span>
                <span class="oob-range">{formatDuration(ann.startSec)} – {formatDuration(ann.endSec)}</span>
                {#if editingAccess}
                  <button class="note-delete-btn" title="Delete fragment" onclick={() => deleteAnnotationById(ann.id)}>×</button>
                {/if}
              </div>
            {/each}
          </div>
        {/if}

        {#if editingAccess}
          <div class="shortcuts-hint">Use shortcuts! [Space] Play/Pause · [Shift]+[Space] Tagged fragments only · [+][−][0] Zoom · [Delete] Remove fragment · [↑][↓] or [Q][W] Navigate · [←][→] Focus fragment · [Enter] Apply · [Shift]+[label] Relabel all fragments + sample</div>
        {/if}

        {#if editingAccess && pending}
          <div class="pending-toolbar">
            <span class="pending-range">{formatDuration(pending.startSec)} – {formatDuration(pending.endSec)} selected</span>
            <div class="pending-labels">
              {#each FRAGMENT_LABELS as lbl}
                {@const sc = sampleLabelShortcut(lbl)}
                {@const idx = lbl.indexOf(sc)}
                <button class="filter-pill" class:active={pendingLabel === lbl} onclick={() => (pendingLabel = lbl)}>{lbl.slice(0, idx)}<u>{sc}</u>{lbl.slice(idx + 1)}</button>
              {/each}
            </div>
            <button class="action-btn" onclick={commitFragment}>Save fragment (↵)</button>
            <div class="note-row">
              <input class="note-input" placeholder="…or add a time-coded note" bind:value={pendingNoteText} />
              <button class="action-btn" disabled={!pendingNoteText.trim()} onclick={commitNote}>Add note</button>
            </div>
            <button class="action-btn" onclick={cancelPending}>Cancel</button>
          </div>
        {/if}

        {#if editingAccess && selectedAnnId != null}
          {@const ann = annotations.find(a => a.id === selectedAnnId)}
          {#if ann && ann.source !== 'note'}
            <div class="selection-toolbar">
              <span class="ann-range">{formatDuration(ann.startSec)} – {formatDuration(ann.endSec)}</span>
              <div class="pending-labels">
                {#each FRAGMENT_LABELS as lbl}
                  {@const sc = sampleLabelShortcut(lbl)}
                  {@const idx = lbl.indexOf(sc)}
                  <button class="filter-pill" class:active={ann.label === lbl} onclick={() => relabelSelected(lbl)}>{lbl.slice(0, idx)}<u>{sc}</u>{lbl.slice(idx + 1)}</button>
                {/each}
              </div>
              <button class="danger-btn" onclick={deleteSelectedAnnotation}>Delete</button>
              <button class="action-btn" onclick={() => (selectedAnnId = null)}>Close</button>
            </div>
          {/if}
        {/if}

        {#if annotationsError}<div class="error-msg">{annotationsError}</div>{/if}
      {/if}
    </main>

    {#if editingAccess && !embedded}
      <aside class="window-review-pane" class:collapsed={windowReviewSidebarCollapsed} aria-label="Suspicious bark fragment review">
        <button
          class="sidebar-toggle"
          type="button"
          aria-controls="window-review-sidebar-content"
          aria-expanded={!windowReviewSidebarCollapsed}
          aria-label={windowReviewSidebarCollapsed ? 'Expand window review sidebar' : 'Collapse window review sidebar'}
          title={windowReviewSidebarCollapsed ? 'Expand window review' : 'Collapse window review'}
          onclick={() => (windowReviewSidebarCollapsed = !windowReviewSidebarCollapsed)}
        >{windowReviewSidebarCollapsed ? '‹' : '›'}</button>
        <div id="window-review-sidebar-content" class="window-review-content">
          <div class="window-review-heading">
            <strong>Window review</strong>
            <span>{visibleWindowReviewCandidates.length}</span>
          </div>
          <div class="window-review-tabs" role="tablist" aria-label="Window review queues">
          {#each WINDOW_REVIEW_TABS as tab}
            <button
              type="button"
              role="tab"
              aria-selected={windowReviewTab === tab.id}
              class:active={windowReviewTab === tab.id}
              onclick={() => selectWindowReviewTab(tab.id)}
            >{tab.label}<small>{windowReviewQueues[tab.id]?.length ?? 0}</small></button>
          {/each}
          </div>

        {#if projectionReviewError}
          <div class="window-review-message error-msg">{projectionReviewError}</div>
        {:else if projectionPoints.length === 0 || allAnnotations.length === 0}
          <div class="window-review-message">Loading…</div>
        {:else if visibleWindowReviewCandidates.length === 0}
          <div class="window-review-message">No fragments in this queue.</div>
        {:else}
          <div class="window-review-list">
            {#each visibleWindowReviewCandidates as candidate (candidate.reviewKey)}
              {@const applied = appliedReviewKey === candidate.reviewKey}
              {@const reviewAction = WINDOW_REVIEW_ACTIONS[candidate.action]}
              {@const reviewIcon = reviewAction?.icon ?? WINDOW_REVIEW_KIND_ICONS[candidate.reviewKind]}
              <button
                class="window-review-row"
                class:active={candidate.reviewKey === focusedReviewKey}
                class:applied
                disabled={windowReviewBusy}
                onclick={() => focusWindowReviewCandidate(candidate)}
                title={applied
                  ? 'Applied; adjust the fragment or select another review item to dismiss'
                  : reviewAction?.label ?? `${candidate.reviewKind} review`}
                aria-label={`${applied ? 'Applied, ' : ''}${reviewAction?.label ?? candidate.reviewKind}, ${candidate.windows.length} windows`}
              >
                <span class="window-review-icon" aria-hidden="true">{reviewIcon}</span>
                <span class="window-review-details">
                  <span>{formatWindowReviewSummary(candidate)} </span><span class="window-confidence-bars" aria-hidden="true">{#each windowConfidenceBarSegments(candidate.scores, candidate.targetIndex) as segment (segment.index)}<span class:target={segment.target}>{segment.bar}</span>{/each}</span>
                </span>
              </button>
            {/each}
          </div>
        {/if}

        {#if windowReviewError}<div class="window-review-message error-msg">{windowReviewError}</div>{/if}
        <div class="window-review-actions">
          {#if windowReviewTab === 'contrast'}
            <button
              class="action-btn"
              disabled={!focusedReviewCandidate || windowReviewBusy || focusedWindowReviewApplied}
              onclick={() => focusedReviewCandidate && submitWindowReview(focusedReviewCandidate.action)}
            >{focusedWindowReviewApplied ? 'Applied' : 'Apply'} <kbd>P</kbd></button>
          {:else if windowReviewTab !== 'kept'}
            <span class="window-review-manual">Adjust manually</span>
          {/if}
          <button
            class="action-btn"
            disabled={!focusedReviewCandidate || windowReviewBusy || focusedWindowReviewApplied}
            onclick={() => submitWindowReview(windowReviewTab === 'kept' ? 'unkeep' : 'keep')}
          >{windowReviewTab === 'kept' ? 'Unkeep' : 'Keep'} <kbd>K</kbd></button>
        </div>
          <div class="window-review-shortcuts"><kbd>[</kbd>/<kbd>]</kbd> navigate · <kbd>Space</kbd> listen</div>
        </div>
      </aside>
    {/if}
  </div>
</div>

<style>
  :global(*, *::before, *::after) { box-sizing: border-box; }
  :global(body) {
    margin: 0;
    font-family: var(--font-body);
    background: #f7f7f5;
    color: #1a1a1a;
  }

  .app { min-height: 100dvh; }

  /* ── Header ── */
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

  .site-header nav {
    margin-left: auto;
    display: flex;
    align-items: center;
    gap: 0.2rem;
  }

  .site-header nav a {
    padding: 0.2rem 0.4rem;
    border-radius: 4px;
    color: #555;
    font-family: var(--font-tiny); font-size: var(--font-size-tiny);
    text-decoration: none;
    white-space: nowrap;
  }

  .site-header nav a:hover,
  .site-header nav a.current { background: #f0f0ec; color: #1a1a1a; }
  .site-header nav a.current { font-weight: 650; }

  /* ── Layout ── */
  .training-body {
    display: flex;
    align-items: flex-start;
    min-height: calc(100dvh - 49px);
  }

  .app.embedded .training-body {
    min-height: 100dvh;
  }

  .samples-pane {
    width: 320px;
    flex-shrink: 0;
    border-right: 1px solid #e0e0dc;
    background: #fff;
    height: calc(100dvh - 49px);
    display: flex;
    flex-direction: column;
    position: sticky;
    top: 49px;
    overflow: hidden;
    transition: width 0.15s ease;
  }

  .samples-pane-content,
  .window-review-content {
    display: flex;
    flex: 1;
    min-width: 0;
    min-height: 0;
    flex-direction: column;
  }

  .samples-pane.collapsed,
  .window-review-pane.collapsed {
    width: 36px;
  }

  .samples-pane.collapsed .samples-pane-content,
  .window-review-pane.collapsed .window-review-content {
    display: none;
  }

  .sidebar-toggle {
    position: absolute;
    z-index: 5;
    top: 0.55rem;
    width: 26px;
    height: 26px;
    padding: 0;
    border: 1px solid #d8d8d4;
    border-radius: 4px;
    background: #fff;
    color: #666;
    font-family: var(--font-monospace);
    font-size: 1.15rem;
    line-height: 1;
    cursor: pointer;
  }
  .sidebar-toggle:hover { border-color: #aaa; background: #f3f3ef; color: #222; }
  .samples-pane > .sidebar-toggle { right: 0.3rem; }
  .window-review-pane > .sidebar-toggle { left: 0.3rem; }
  .samples-pane .samples-filter { padding-right: 2.65rem; }
  .window-review-pane .window-review-heading { padding-left: 2.65rem; }

  .samples-pane.collapsed > .sidebar-toggle,
  .window-review-pane.collapsed > .sidebar-toggle {
    left: 4px;
    right: auto;
  }

  .editor-pane {
    flex: 1;
    min-width: 0;
    padding: 1rem 1.2rem 2rem;
  }

  .window-review-pane {
    width: 300px;
    flex-shrink: 0;
    position: sticky;
    top: 49px;
    height: calc(100dvh - 49px);
    display: flex;
    flex-direction: column;
    border-left: 1px solid #e0e0dc;
    background: #fff;
    overflow: hidden;
    transition: width 0.15s ease;
  }
  .window-review-heading {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 0.75rem 0.8rem;
    border-bottom: 1px solid #ecece7;
    font-family: var(--font-tiny);
    font-size: var(--font-size-tiny);
    text-transform: uppercase;
  }
  .window-review-heading span {
    min-width: 1.7rem;
    padding: 0.1rem 0.35rem;
    border-radius: 10px;
    background: #f0f0ec;
    text-align: center;
    font-variant-numeric: tabular-nums;
  }
  .window-review-tabs {
    display: grid;
    grid-template-columns: repeat(4, minmax(0, 1fr));
    border-bottom: 1px solid #ecece7;
  }
  .window-review-tabs button {
    min-width: 0;
    padding: 0.45rem 0.2rem 0.4rem;
    border: 0;
    border-right: 1px solid #ecece7;
    border-bottom: 2px solid transparent;
    background: #fafaf8;
    color: #777;
    font-family: var(--font-tiny);
    font-size: var(--font-size-tiny);
    cursor: pointer;
  }
  .window-review-tabs button:last-child { border-right: 0; }
  .window-review-tabs button:hover { background: #f3f3ef; color: #333; }
  .window-review-tabs button.active { border-bottom-color: #4a7cdc; background: #fff; color: #222; font-weight: 700; }
  .window-review-tabs small {
    display: block;
    margin-top: 0.1rem;
    color: #aaa;
    font: inherit;
    font-weight: 400;
    font-variant-numeric: tabular-nums;
  }
  .window-review-list { flex: 1; min-height: 0; overflow-y: auto; }
  .window-review-row {
    display: grid;
    grid-template-columns: 1.8rem 1fr;
    align-items: baseline;
    width: 100%;
    padding: 0.48rem 0.75rem;
    border: 0;
    border-bottom: 1px solid #f1f1ed;
    background: transparent;
    color: #333;
    font-family: var(--font-monospace);
    font-size: var(--font-size-tiny);
    font-variant-numeric: tabular-nums;
    text-align: left;
    white-space: pre;
    cursor: pointer;
  }
  .window-review-icon { display: block; width: 1.8rem; }
  .window-review-details { min-width: 0; }
  .window-confidence-bars { letter-spacing: 0.04em; }
  .window-confidence-bars .target {
    padding: 0 0.08em;
    border-radius: 2px;
    background: #ffe09a;
    color: #8b4d00;
    font-weight: 900;
  }
  .window-review-row:hover { background: #f7f7f4; }
  .window-review-row.active { background: #eef3fc; box-shadow: inset 3px 0 0 #4a7cdc; }
  .window-review-row:disabled { cursor: wait; opacity: 0.65; }
  .window-review-message { padding: 0.8rem; color: #999; font-family: var(--font-tiny); font-size: var(--font-size-tiny); }
  .window-review-actions {
    display: flex;
    gap: 0.4rem;
    padding: 0.65rem 0.75rem 0.35rem;
    border-top: 1px solid #ecece7;
  }
  .window-review-actions .action-btn { flex: 1; }
  .window-review-manual {
    flex: 1;
    align-self: center;
    color: #888;
    font-family: var(--font-tiny);
    font-size: var(--font-size-tiny);
    text-align: center;
  }
  .window-review-shortcuts {
    padding: 0.15rem 0.75rem 0.7rem;
    color: #999;
    font-family: var(--font-tiny);
    font-size: var(--font-size-tiny);
  }
  .window-review-pane kbd {
    font-family: var(--font-monospace);
    font-size: inherit;
  }

  .page-title {
    margin: 0 0 0.35rem;
    font-size: var(--font-size-large);
  }
  .section-title {
    margin: 2rem 0 0.35rem;
    font-size: var(--font-size-large);
  }

  @media (max-width: 760px) {
    .site-header { align-items: flex-start; flex-wrap: wrap; gap: 0.45rem 0.8rem; }
    .site-header nav { width: 100%; order: 3; overflow-x: auto; margin-left: 0; }
    .training-body { flex-direction: column; }
    .samples-pane { width: 100%; position: static; height: 40vh; border-right: none; border-bottom: 1px solid #e0e0dc; }
    .window-review-pane { width: 100%; position: static; height: 38vh; border-left: none; border-top: 1px solid #e0e0dc; }
    .samples-pane.collapsed,
    .window-review-pane.collapsed { width: 100%; height: 36px; }
  }

  .corpus-summary { container-type: inline-size; padding: 0 0.3rem 2rem; width: 100%; max-width: 90rem; }
  .corpus-summary-layout {
    display: grid;
    grid-template-columns: minmax(46rem, 64rem) minmax(18rem, 24rem);
    grid-template-areas: 'table explanation';
    align-items: start;
    gap: 1.25rem;
    margin-top: 1.5rem;
  }
  .corpus-summary-copy { grid-area: table; min-width: 0; }
  .encoding-explanation {
    grid-area: explanation;
    padding: 0.85rem 1rem;
    border: 1px solid #deded8;
    border-radius: 6px;
    background: #fff;
    color: #444;
  }
  .encoding-explanation-heading {
    display: flex;
    align-items: baseline;
    flex-wrap: wrap;
    gap: 0.35rem 0.55rem;
    margin-bottom: 0.85rem;
  }
  .encoding-title-control {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 0.3rem;
  }
  .encoding-title-control > span {
    width: 100%;
    color: #999;
    font-family: var(--font-tiny); font-size: var(--font-size-tiny);
    font-weight: 700;
    text-transform: uppercase;
  }
  .encoding-title-control select {
    max-width: 14rem;
    padding: 0.25rem 1.7rem 0.25rem 0.4rem;
    border: 1px solid #d0d0ca;
    border-radius: 4px;
    background: #fff;
    color: #222;
    font: inherit;
    font-size: var(--font-size-medium);
    font-weight: 700;
  }
  .encoding-explanation code { padding: 0.08rem 0.3rem; border-radius: 3px; background: #f0f0ec; color: #666; font-family: var(--font-monospace); font-size: var(--font-size-tiny); }
  .explanation-color-legend {
    width: 100%;
    display: grid;
    grid-template-columns: auto minmax(100px, 1fr) auto;
    align-items: center;
    gap: 0.4rem;
    color: #777;
    font-family: var(--font-tiny); font-size: var(--font-size-tiny);
  }
  .explanation-color-legend i {
    height: 9px;
    border-radius: 5px;
    background: linear-gradient(to right, #440154, #3b528b, #21918c, #5ec962, #fde725);
  }
  .explanation-color-legend small { font-size: inherit; font-variant-numeric: tabular-nums; }
  .encoding-explanation section + section { margin-top: 0.85rem; padding-top: 0.75rem; border-top: 1px solid #ecece7; }
  .encoding-explanation h2 { margin: 0 0 0.28rem; color: #777; font-family: var(--font-heading); font-size: var(--font-size-tiny); text-transform: uppercase; }
  .encoding-explanation p { margin: 0; font-family: var(--font-tiny); font-size: var(--font-size-tiny); line-height: 1.5; }
  @container (max-width: 1100px) {
    .corpus-summary-layout {
      grid-template-columns: minmax(0, 1fr);
      grid-template-areas: 'explanation' 'table';
    }
  }
  .windows-explanation {
    display: block;
    width: auto;
    max-width: 100%;
    height: 350px;
    margin-top: 0.75rem;
    object-fit: contain;
    object-position: left top;
  }
  .corpus-table { border-collapse: collapse; width: 100%; font-size: var(--font-size-small); }
  .corpus-table th {
    text-align: left;
    font-family: var(--font-tiny); font-size: var(--font-size-tiny);
    text-transform: uppercase;
    color: #999;
    padding: 0.3rem 0.5rem;
    border-bottom: 1px solid #e0e0dc;
  }
  .corpus-table th small {
    display: block;
    margin-top: 0.2rem;
    color: #aaa;
    font-family: var(--font-tiny); font-size: var(--font-size-tiny);
    font-weight: 400;
    line-height: 1.25;
    text-transform: none;
    white-space: normal;
  }
  .corpus-table td {
    padding: 0.35rem 0.5rem;
    border-bottom: 1px solid #f0f0ec;
    font-variant-numeric: tabular-nums;
  }
  .corpus-table th:not(:first-child), .corpus-table td:not(:first-child) { text-align: right; }
  .corpus-table tbody tr { cursor: pointer; transition: opacity 0.1s, background 0.1s; }
  .corpus-table tbody tr:hover,
  .corpus-table tbody tr.filter-active { background: #fff; }
  .corpus-table tbody tr.filter-active { box-shadow: inset 3px 0 0 #555; }
  .corpus-table tbody tr.filter-muted { opacity: 0.48; }

  .corpus-guideline { color: #999; white-space: nowrap; }
  .corpus-frag-count { font-weight: 700; }
  .corpus-low  { color: #c0392b; }
  .corpus-mid  { color: #b8860b; }
  .corpus-good { color: #27ae60; }

  .corpus-summary-legend { font-family: var(--font-tiny); font-size: var(--font-size-tiny); color: #999; margin-top: 1rem; }

  .corpus-back-btn {
    display: block;
    width: 100%;
    margin: 0 0 1rem;
    padding: 0.85rem 1rem;
    border: 1px solid #d4d4ce;
    border-radius: 7px;
    background: #fff;
    color: #1a1a1a;
    font-family: inherit;
    font-size: var(--font-size-medium);
    font-weight: 700;
    text-align: left;
    cursor: pointer;
    transition: background 0.1s, border-color 0.1s;
  }
  .corpus-back-btn:hover { background: #f0f0ec; border-color: #bdbdb6; }
  .corpus-back-btn:focus-visible { outline: 3px solid rgba(74, 124, 220, 0.3); outline-offset: 2px; }

  /* ── Duration histogram sparkline (Datatype font bar-chart ligatures) ── */
  .corpus-chart-cell { white-space: nowrap; }
  .chart {
    font-family: var(--font-data);
    font-variation-settings: 'wdth' 15;
    font-weight: 400;
    font-size: var(--font-size-large);
    line-height: 1;
    color: #4a7cdc;
  }
  .window-chart { color: #2ea096; }

  /* ── Filter pills / list (shared look with GoblinPiStatus samples tab) ── */
  .samples-filter {
    display: flex;
    flex-wrap: wrap;
    gap: 0.3rem;
    padding: 0.7rem 0.9rem;
    border-bottom: 1px solid #f0f0ec;
    flex-shrink: 0;
    background: #fff;
  }

  .filter-pill {
    font-family: var(--font-monospace);
    font-size: var(--font-size-tiny);
    font-weight: 500;
    padding: 0.2rem 0.55rem;
    border: 1px solid #d8d8d4;
    border-radius: 10px;
    background: #f5f5f2;
    color: #666;
    cursor: pointer;
    transition: background 0.1s, color 0.1s;
  }
  .filter-pill:hover { background: #eaeae6; color: #333; }
  .filter-pill.active { background: #1a1a1a; color: #fff; border-color: #1a1a1a; }
  .reload-pill { border-style: dashed; }

  .samples-msg { padding: 1rem 0.9rem; font-family: var(--font-tiny); font-size: var(--font-size-tiny); color: #999; }
  .samples-err { color: #c0392b; }

  .samples-list { padding-bottom: 0.5rem; overflow-y: auto; flex: 1; }

  .sample-row {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    width: 100%;
    padding: 0.4rem 0.9rem;
    border: none;
    background: none;
    cursor: pointer;
    font-family: inherit;
    border-bottom: 1px solid #f4f4f0;
    text-align: left;
    transition: background 0.1s;
    position: relative;
  }
  .sample-row:hover { background: #f7f7f4; }
  .sample-row.playing { background: #eef3fc; }

  .day-header {
    padding: 0.45rem 0.9rem 0.2rem;
    font-family: var(--font-tiny); font-size: var(--font-size-tiny);
    font-weight: 800;
    color: #222;
    text-transform: uppercase;
    border-bottom: 1px solid #cccccc;
    margin-top: 1.3rem;
  }
  .day-header:first-child { border-top: none; margin-top: 0; }

  .sample-frag-strip {
    position: absolute;
    left: 0;
    right: 0;
    bottom: 0;
    height: 2px;
  }
  .sample-frag-block {
    position: absolute;
    top: 0;
    bottom: 0;
    opacity: 0.85;
  }

  .sample-label-pill {
    font-family: var(--font-monospace);
    font-size: var(--font-size-tiny);
    font-weight: 700;
    text-transform: uppercase;
    padding: 0.1rem 0.4rem;
    border-radius: 8px;
    flex-shrink: 0;
    color: #fff;
  }
  .sample-name {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 0.05rem;
  }
  .sample-name-main {
    font-family: var(--font-tiny); font-size: var(--font-size-tiny);
    color: #333;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    font-variant-numeric: tabular-nums;
  }
  .sample-diary-icon {
    font-family: var(--font-tiny); font-size: var(--font-size-tiny);
    opacity: 0.6;
    margin-left: 0.25rem;
    vertical-align: middle;
  }
  .sample-note-preview {
    font-family: var(--font-tiny); font-size: var(--font-size-tiny);
    color: #a8860a;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .sample-dur { font-family: var(--font-tiny); font-size: var(--font-size-tiny); color: #aaa; flex-shrink: 0; font-variant-numeric: tabular-nums; }

  /* ── Editor header ── */
  .editor-header {
    display: flex;
    align-items: center;
    gap: 0.7rem;
    flex-wrap: wrap;
    margin-bottom: 0.6rem;
  }
  .editor-title { font-size: var(--font-size-small); font-weight: 600; }
  .editor-dur { font-family: var(--font-tiny); font-size: var(--font-size-tiny); color: #888; font-variant-numeric: tabular-nums; }
  .cross-link-btn {
    font-size: var(--font-size-small); padding: 0.1rem 0.25rem; border-radius: 5px;
    text-decoration: none; color: inherit; border: 1px solid transparent;
    margin-left: 0.15rem;
  }
  .cross-link-btn:hover { background: #e8f4ff; border-color: #b0d0f0; }

  .category-control {
    display: flex;
    align-items: center;
    gap: 0.35rem;
    font-family: var(--font-tiny); font-size: var(--font-size-tiny);
    color: #666;
    margin-left: auto;
  }
  .category-control select {
    font-family: inherit;
    font-family: var(--font-tiny); font-size: var(--font-size-tiny);
    padding: 0.2rem 0.4rem;
    border: 1px solid #d0d0cc;
    border-radius: 4px;
    background: #fff;
  }

  .danger-btn {
    background: #e74c3c;
    color: #fff;
    border: none;
    border-radius: 4px;
    padding: 0.32rem 0.75rem;
    font-family: var(--font-tiny); font-size: var(--font-size-tiny);
    cursor: pointer;
  }
  .danger-btn:hover { opacity: 0.85; }

  .reanalyze-btn {
    background: #e8f4ff;
    color: #2255bb;
    border: 1px solid #b0d0f0;
    border-radius: 4px;
    padding: 0.32rem 0.75rem;
    font-family: var(--font-tiny); font-size: var(--font-size-tiny);
    cursor: pointer;
  }
  .reanalyze-btn:hover:not(:disabled) { background: #d8eaff; }
  .danger-btn:disabled,
  .reanalyze-btn:disabled {
    opacity: 0.4; cursor: default;
  }

  .action-btn {
    background: #1a1a1a;
    color: #fff;
    border: none;
    border-radius: 4px;
    padding: 0.32rem 0.75rem;
    font-family: var(--font-tiny); font-size: var(--font-size-tiny);
    cursor: pointer;
  }
  .action-btn:hover:not(:disabled) { opacity: 0.8; }
  .action-btn:disabled { opacity: 0.4; cursor: default; }

  .confirm-bar {
    display: flex;
    align-items: center;
    gap: 0.6rem;
    background: #fdecea;
    border: 1px solid #f5c6c0;
    border-radius: 6px;
    padding: 0.5rem 0.7rem;
    font-family: var(--font-tiny); font-size: var(--font-size-tiny);
    margin-bottom: 0.7rem;
    flex-wrap: wrap;
  }

  .confirm-bar.reanalyze-confirm-bar { background: #eef5ff; border-color: #bfd3f3; }
  .reanalyze-threshold {
    display: flex;
    align-items: center;
    gap: 0.45rem;
    min-width: 15rem;
    color: #31517c;
    font-variant-numeric: tabular-nums;
  }
  .reanalyze-threshold span { min-width: 10rem; font-weight: 700; }
  .reanalyze-threshold input {
    width: 7rem;
    accent-color: #2255bb;
    cursor: pointer;
  }

  .error-msg {
    color: #c0392b;
    font-family: var(--font-tiny); font-size: var(--font-size-tiny);
    margin: 0.4rem 0;
  }

  /* ── Player ── */
  .player-controls {
    display: flex;
    align-items: center;
    gap: 0.6rem;
    flex-wrap: wrap;
    margin-bottom: 0.4rem;
  }
  .play-pause-btn {
    background: #1a1a1a;
    color: #fff;
    border: none;
    border-radius: 50%;
    width: 32px;
    height: 32px;
    font-family: var(--font-tiny); font-size: var(--font-size-tiny);
    cursor: pointer;
    flex-shrink: 0;
  }
  .play-pause-btn:hover { opacity: 0.8; }
  .approver-play-btn {
    width: 25px;
    height: 25px;
    padding: 0;
    border: 1px solid #b8b8b2;
    border-radius: 50%;
    background: transparent;
    color: #777;
    font-family: var(--font-tiny);
    font-size: 8px;
    line-height: 1;
    cursor: pointer;
    opacity: 0.7;
    flex-shrink: 0;
  }
  .approver-play-btn:hover:not(:disabled),
  .approver-play-btn.active { border-color: #666; color: #333; opacity: 1; }
  .approver-play-btn:disabled { cursor: default; opacity: 0.25; }
  .mini-time { font-family: var(--font-tiny); font-size: var(--font-size-tiny); color: #666; font-variant-numeric: tabular-nums; flex-shrink: 0; }
  .hint { flex: 1 1 18rem; font-family: var(--font-tiny); font-size: var(--font-size-tiny); color: #aaa; }
  .player-tool-controls {
    display: flex;
    align-items: center;
    gap: 0.6rem;
    margin-left: auto;
  }
  .wave-resolution-controls,
  .wave-zoom-controls {
    display: inline-flex;
    align-items: center;
    gap: 0.2rem;
  }
  .regen-label { font-family: var(--font-tiny); font-size: var(--font-size-tiny); color: #aaa; }
  .regen-btn {
    font-family: var(--font-tiny); font-size: var(--font-size-tiny); padding: 0.1rem 0.35rem;
    border: 1px solid #c0c8d8; border-radius: 4px;
    background: #f4f6fa; color: #445; cursor: pointer;
    line-height: 1.4;
  }
  .regen-btn:hover:not(:disabled) { background: #e0e8f8; }
  .regen-btn:disabled { opacity: 0.5; cursor: default; }

  .zoom-label { font-family: var(--font-tiny); font-size: var(--font-size-tiny); color: #aaa; }
  .zoom-btn,
  .zoom-reset-btn {
    height: 24px;
    border: 1px solid #c0c8d8;
    background: #f4f6fa;
    color: #445;
    font-family: var(--font-tiny);
    font-size: var(--font-size-tiny);
    line-height: 1;
    cursor: pointer;
  }
  .zoom-btn { width: 24px; padding: 0; border-radius: 4px; }
  .zoom-reset-btn { min-width: 3.5rem; padding: 0 0.35rem; border-radius: 4px; font-variant-numeric: tabular-nums; }
  .zoom-btn:hover:not(:disabled),
  .zoom-reset-btn:hover:not(:disabled) { background: #e0e8f8; }
  .zoom-btn:disabled,
  .zoom-reset-btn:disabled { opacity: 0.45; cursor: default; }

  .wave-editor-scroll {
    width: 100%;
    overflow-x: auto;
    overflow-y: hidden;
    border-radius: 4px;
    background: #f4f6fb;
  }

  .wave-editor-wrap {
    position: relative;
    min-width: 100%;
    height: 160px;
    overflow: hidden;
    background: #f4f6fb;
  }
  .wave-canvas {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    display: block;
  }
  .wave-editor {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    display: block;
    background: transparent;
    cursor: crosshair;
    user-select: none;
  }
  .wave-editor.readonly { cursor: pointer; }

  .fragment-band { cursor: pointer; }
  .wave-editor.readonly .fragment-band { cursor: inherit; }
  .frag-handle { fill: #1a1a1a; opacity: 0.35; cursor: ew-resize; }
  .review-window {
    fill: rgba(255, 255, 255, 0.12);
    stroke: #111;
    stroke-width: 2;
    stroke-dasharray: 5 3;
    vector-effect: non-scaling-stroke;
    pointer-events: none;
  }
  .fixed-svg-stroke { vector-effect: non-scaling-stroke; }

  /* HTML overlay for fragment labels — a fixed font-size here always renders
     at true pixel size, unlike SVG <text> which gets stretched by the
     wave-editor's non-uniform (preserveAspectRatio="none") scaling. */
  .fragment-labels-layer {
    position: absolute;
    inset: 0;
    pointer-events: none;
  }
  .fragment-label-html {
    position: absolute;
    top: 2px;
    left: 0;
    padding-left: 3px;
    display: flex;
    flex-direction: column;
    line-height: 1.15;
    white-space: nowrap;
  }
  .fragment-label-text { font-size: var(--font-size-medium); color: #1a1a1a; }
  .fragment-label-text.fragment-dur { color: rgba(0, 0, 0, 0.5); }

  /* ── Toolbars ── */
  .pending-toolbar,
  .selection-toolbar {
    display: flex;
    align-items: center;
    gap: 0.6rem;
    flex-wrap: wrap;
    background: #fafaf8;
    border: 1px solid #e8e8e4;
    border-radius: 6px;
    padding: 0.6rem 0.8rem;
    margin-top: 0.6rem;
    font-family: var(--font-tiny); font-size: var(--font-size-tiny);
  }

  .pending-range, .ann-range { color: #666; font-variant-numeric: tabular-nums; white-space: nowrap; }
  .pending-labels { display: flex; gap: 0.3rem; flex-wrap: wrap; }

  .note-row { display: flex; align-items: center; gap: 0.4rem; }
  .note-input {
    font-family: inherit;
    font-family: var(--font-tiny); font-size: var(--font-size-tiny);
    padding: 0.3rem 0.5rem;
    border: 1px solid #d0d0cc;
    border-radius: 4px;
    min-width: 200px;
  }

  /* ── Notes panel ── */
  .notes-panel {
    margin-top: 0.6rem;
    background: #fffef8;
    border: 1px solid #e8e8e4;
    border-radius: 6px;
    padding: 0.5rem 0.7rem;
  }
  .notes-panel-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.6rem;
    margin-bottom: 0.35rem;
  }
  .notes-panel-title {
    font-family: var(--font-tiny); font-size: var(--font-size-tiny);
    font-weight: 700;
    text-transform: uppercase;
    color: #999;
  }
  .note-row-item {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.3rem 0;
    border-bottom: 1px solid #f4f4ee;
  }
  .note-row-item:last-child { border-bottom: none; }
  .note-row-item.selected { background: #fdf6d8; }
  .note-row-item .note-input { flex: 1; min-width: 0; }
  .note-time {
    font-family: var(--font-tiny); font-size: var(--font-size-tiny);
    color: #a8860a;
    font-variant-numeric: tabular-nums;
    flex-shrink: 0;
    min-width: 5rem;
  }
  .note-text-btn {
    flex: 1;
    min-width: 0;
    text-align: left;
    background: none;
    border: none;
    font-family: inherit;
    font-family: var(--font-tiny); font-size: var(--font-size-tiny);
    color: #1a1a1a;
    cursor: pointer;
    padding: 0.15rem 0.3rem;
    border-radius: 3px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .note-text-btn:hover { background: #f4f4ee; }
  .note-text-static {
    flex: 1;
    min-width: 0;
    padding: 0.15rem 0.3rem;
    font-family: var(--font-tiny); font-size: var(--font-size-tiny);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .note-delete-btn {
    background: none;
    border: none;
    color: #c0392b;
    font-size: var(--font-size-small);
    line-height: 1;
    cursor: pointer;
    padding: 0.1rem 0.3rem;
    flex-shrink: 0;
  }
  .note-delete-btn:hover { opacity: 0.7; }
  .notes-empty { font-family: var(--font-tiny); font-size: var(--font-size-tiny); color: #aaa; padding: 0.2rem 0; }
  .shortcuts-hint { font-family: var(--font-tiny); font-size: var(--font-size-tiny); color: #aaa; margin-top: 0.6rem; line-height: 1.5; }
  .bulk-relabel-status { font-family: var(--font-tiny); font-size: var(--font-size-tiny); color: #666; margin: 0.45rem 0; }

  /* ── Out-of-bounds fragments panel ── */
  .oob-panel {
    margin-top: 0.75rem;
    border: 1px solid #f5c6cb;
    border-radius: 6px;
    padding: 0.5rem 0.75rem;
    background: #fff8f8;
  }
  .oob-panel-header { margin-bottom: 0.4rem; }
  .oob-panel-title { font-family: var(--font-tiny); font-size: var(--font-size-tiny); font-weight: 600; color: #c0392b; margin-right: 0.5rem; }
  .oob-panel-hint { font-family: var(--font-tiny); font-size: var(--font-size-tiny); color: #a0402a; }
  .oob-row {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.2rem 0;
    font-family: var(--font-tiny); font-size: var(--font-size-tiny);
  }
  .oob-range { flex: 1; font-variant-numeric: tabular-nums; color: #555; }
</style>
