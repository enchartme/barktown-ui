<script>
  import { onMount, tick } from 'svelte';
  import { formatDuration, formatDate, downsampleWaveform, waveformNorm, ASSET_BASE, PRIVATE_API_BASE } from '$lib/utils.js';
  import { formatAudioPanelAnalysisParameters, formatAudioPanelStats, formatAudioPanelTitle, hitMetadataById, setHitMetadata } from '$lib/hit-metadata.js';
  import { recordingComment } from '$lib/recording-comments.js';
  import { diaryTrimBounds, trimHitMetadata } from '$lib/diary-trim.js';
  import { probeEditingAccess } from '$lib/editing-access.js';
  import { hitMetadataFragmentRanges, taggedPlaybackStep, taggedRangeIndexAtOrAfter } from '$lib/tagged-fragment-playback.js';
  import {
    SAMPLE_LABELS,
    sampleLabelColor,
    sampleLabelShortcut,
    sampleMoveForShortcut,
  } from '$lib/sample-labels.js';
  import { fly }           from 'svelte/transition';

  /**
   * @type {{
   *   entry: import('$lib/types').Entry;
   *   onclose: () => void;
   *   onclosed?: () => void;
   *   ondelete?: (entry: import('$lib/types').Entry) => void;
   *   onmovesample?: (entry: import('$lib/types').Entry, label: string, keepInDiary: boolean) => Promise<void>;
   *   oncommentchange?: (entry: import('$lib/types').Entry, annotations: Record<string, unknown>[]) => void;
   *   ontrimchange?: (entry: import('$lib/types').Entry, trim: {trimStartMs: number|null, trimStopMs: number|null}) => void;
   *   onapprovalchange?: (entry: import('$lib/types').Entry, approved: string|null) => void;
   *   onprevious?: () => void;
   *   onnext?: () => void;
   * }}
   */
  let {
    entry,
    onclose,
    onclosed,
    ondelete,
    onmovesample,
    oncommentchange,
    ontrimchange,
    onapprovalchange,
    onprevious,
    onnext,
  } = $props();

  /** Tailnet-only mutation controls appear after the private API responds. */
  let editingAccess = $state(false);
  let approvalSaving = $state(false);
  let approvalError = $state('');

  $effect(() => {
    void entry.id;
    approvalError = '';
  });

  // ── Audio element reference ────────────────────────────────────────────────
  /** @type {HTMLAudioElement | null} */
  let audioEl = $state(null);
  /** @type {HTMLDivElement | null} */
  let playerPanelEl = $state(null);
  /** @type {HTMLButtonElement | null} */
  let shortcutHelpButtonEl = $state(null);
  /** @type {HTMLButtonElement | null} */
  let shortcutHelpCloseEl = $state(null);

  const reportShortcutsEnabled = $derived(Boolean(onprevious || onnext));
  let shortcutHelpOpen = $state(false);

  // ── Playback state ─────────────────────────────────────────────────────────
  let isPlaying   = $state(false);
  let playbackMode = $state(/** @type {'normal'|'approver'} */ ('normal'));
  let approverRangeIndex = 0;
  let currentTime = $state(0);
  let duration    = $state(0);

  const trimBounds = $derived(diaryTrimBounds(entry));
  const visibleDuration = $derived(trimBounds.durationSec);
  const visibleCurrentTime = $derived(
    Math.max(0, Math.min(visibleDuration, currentTime - trimBounds.startSec)),
  );
  const waveformStartMs = $derived(editingAccess ? 0 : trimBounds.startMs);
  const waveformStopMs = $derived(editingAccess ? trimBounds.sourceDurationMs : trimBounds.stopMs);
  const waveformDurationMs = $derived(Math.max(0, waveformStopMs - waveformStartMs));
  const waveformDuration = $derived(waveformDurationMs / 1000);
  const waveformCurrentTime = $derived(
    Math.max(0, Math.min(waveformDuration, currentTime - waveformStartMs / 1000)),
  );
  // rAF-based playhead: sample audioEl.currentTime at ~60 fps while playing so
  // the playhead moves smoothly. ontimeupdate (~4 Hz) stays as a seek fallback.
  $effect(() => {
    if (!isPlaying || !audioEl) return;
    let id = 0;
    const tick = () => {
      currentTime = audioEl.currentTime;
      if (playbackMode === 'approver') {
        enforceApproverPlayback();
      } else if (currentTime >= trimBounds.stopSec - 0.01) {
        audioEl.pause();
        audioEl.currentTime = trimBounds.startSec;
        currentTime = trimBounds.startSec;
        return;
      }
      id = requestAnimationFrame(tick);
    };
    id = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(id);
  });

  // ── Waveform data ──────────────────────────────────────────────────────────
  // Module-level cache shared with WaveformPreview (avoids second fetch when
  // the user opens the panel for an already-previewed entry).
  /** @type {Map<string, { data: number[], mins: number[], maxs: number[], norm: number, rawLength: number } | 'error'>} */
  const waveformCache = new Map();

  /** @type {{ data: number[], mins: number[], maxs: number[], norm: number, rawLength: number } | null} */
  let waveData   = $state(null);
  let wfLoading  = $state(false);

  /** @type {HTMLCanvasElement | null} */
  let waveCanvasEl = $state(null);
  /** @type {HTMLDivElement | null} */
  let waveWrapEl   = $state(null);

  // Virtual waveform SVG dimensions (viewBox units, not pixels).
  // Using a viewBox lets the SVG scale to any container width.
  const VW = 1000; // virtual width
  const VH = 80;   // virtual height

  // Number of bars to render in the player waveform.
  const PLAYER_BARS = 500;

  // ── Derived waveform bars ─────────────────────────────────────────────────
  const bars = $derived.by(() => {
    if (!waveData) return [];
    const { data, norm } = waveData;
    const rawCount = Math.floor(data.length / 2);
    const sourceDurationMs = trimBounds.sourceDurationMs;
    const firstRawIndex = sourceDurationMs > 0
      ? Math.max(0, Math.floor((waveformStartMs / sourceDurationMs) * rawCount))
      : 0;
    const endRawIndex = sourceDurationMs > 0
      ? Math.min(rawCount, Math.ceil((waveformStopMs / sourceDurationMs) * rawCount))
      : rawCount;
    const visibleData = data.slice(firstRawIndex * 2, endRawIndex * 2);
    const { mins, maxs } = downsampleWaveform(visibleData, PLAYER_BARS);
    const count = mins.length;
    if (!count)    return [];

    const barW    = VW / count;
    const centerY = VH / 2;
    const gc      = _gainCurve; // reactive dep — redraws when curve is set

    // Find the tallest visual amplitude after gain, so we can scale the Y axis
    // to always fill the full height regardless of how flat the gain curve is.
    let visualPeak = 0;
    for (let i = 0; i < count; i++) {
      const gainIndex = gc
        ? Math.min(gc.length - 1, Math.floor(
          ((firstRawIndex + (i / count) * (endRawIndex - firstRawIndex)) / Math.max(1, rawCount)) * gc.length,
        ))
        : 0;
      const v = (maxs[i] / norm) * (gc ? gc[gainIndex] : 1);
      if (v > visualPeak) visualPeak = v;
    }
    const yScale = visualPeak > 0 ? 1 / visualPeak : 1;

    return Array.from({ length: count }, (_, i) => {
      const gainIndex = gc
        ? Math.min(gc.length - 1, Math.floor(
          ((firstRawIndex + (i / count) * (endRawIndex - firstRawIndex)) / Math.max(1, rawCount)) * gc.length,
        ))
        : 0;
      const lo = mins[i];
      const gain = gc ? gc[gainIndex] : 1;
      const hi = maxs[i];
      const yTop    = centerY - (hi / norm) * gain * yScale * centerY;
      const yBottom = centerY - (lo / norm) * gain * yScale * centerY;
      return {
        x: i * barW,
        y: yTop,
        w: Math.max(0.5, barW - 0.5),
        h: Math.max(1, yBottom - yTop),
      };
    });
  });

  // Playhead x position in virtual SVG units.
  const playheadX = $derived(
    waveformDuration > 0 ? (waveformCurrentTime / waveformDuration) * VW : 0
  );

  /** Paints `bars()` onto the canvas layer at native pixel resolution
   * (rather than as hundreds of SVG <rect> nodes) — cheaper to render and
   * sharper, since it isn't stretched through a viewBox transform. */
  function drawWaveCanvas() {
    const canvas = waveCanvasEl;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const dpr  = window.devicePixelRatio || 1;
    const w    = Math.max(1, Math.round(rect.width * dpr));
    const h    = Math.max(1, Math.round(rect.height * dpr));
    if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.clearRect(0, 0, w, h);
    const scaleX = w / VW;
    const scaleY = h / VH;
    const px = playheadX;
    for (const bar of bars) {
      ctx.fillStyle = bar.x <= px ? '#2255bb' : '#a0b8e8';
      ctx.fillRect(bar.x * scaleX, bar.y * scaleY, Math.max(1, bar.w * scaleX), Math.max(1, bar.h * scaleY));
    }
  }

  $effect(() => {
    bars; // reactive dependency: redraw whenever bars or the playhead change
    playheadX;
    drawWaveCanvas();
  });

  $effect(() => {
    if (!waveWrapEl) return;
    const ro = new ResizeObserver(() => drawWaveCanvas());
    ro.observe(waveWrapEl);
    return () => ro.disconnect();
  });

  // ── Fetch waveform when entry changes ────────────────────────────────────
  $effect(() => {
    const path = entry.waveformPath;
    if (!path) { waveData = null; return; }

    const cached = waveformCache.get(path);
    if (cached && cached !== 'error') {
      waveData = cached;
      return;
    }
    if (cached === 'error') return;

    wfLoading = true;
    fetch(`${ASSET_BASE}/${path}`)
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then((json) => {
        const norm   = waveformNorm(json.bits ?? 8);
        const ds     = downsampleWaveform(json.data, PLAYER_BARS);
        const result = {
          data: json.data,
          mins: ds.mins,
          maxs: ds.maxs,
          norm,
          rawLength: json.length,
        };
        waveformCache.set(path, result);
        if (entry.waveformPath === path) waveData = result;
      })
      .catch(() => waveformCache.set(path, 'error'))
      .finally(() => { wfLoading = false; });
  });

  // ── Reset player state when entry changes ────────────────────────────────
  $effect(() => {
    // Reading `entry` makes this re-run on entry change.
    void entry.id;
    currentTime = trimBounds.startSec;
    duration    = audioEl?.duration || entry.durationSec || 0;
    isPlaying   = false;
    playbackMode = 'normal';
    approverRangeIndex = 0;
  });

  // ── Hit metadata (bark timestamps + confidence + loudness from goblin) ────
  const hitMetadata = $derived($hitMetadataById.get(entry.id) ?? null);
  const visibleHitMetadata = $derived(trimHitMetadata(hitMetadata, entry));
  const waveformHitMetadata = $derived(editingAccess ? hitMetadata : visibleHitMetadata);
  const approverRanges = $derived(hitMetadataFragmentRanges(hitMetadata, {
    startSec: trimBounds.startSec,
    endSec: trimBounds.stopSec,
  }));
  // Hit whose confidence/loudness labels are shown — only on hover, since
  // they'd otherwise overlap when hits are close together.
  let hoveredHitIndex = $state(/** @type {number|null} */ (null));

  $effect(() => {
    void entry.id;
    hoveredHitIndex = null;
  });

  // ── Volume / gain ──────────────────────────────────────────────────────────
  /** Manual volume in dB. Slider range -30..0. */
  let volumeDb   = $state(0);
  /** When true, per-moment waveform lookahead adjusts gain dynamically. */
  let autoAdjust     = $state(false);
  /** How aggressively to suppress loud sections. 0 = off, 1 = extreme. */
  let suppressLoud   = $state(0);
  /** Amplitude threshold (0..1): only samples above this are suppressed. */
  let suppressCutoff = $state(0);
  /** How much to boost quiet sections toward volume 1. 0 = off, 1 = full makeup. */
  let boostQuiet     = $state(0);
  /** Amplitude threshold (0..1): only samples below this are boosted. */
  let boostCutoff    = $state(1);

  /** dB → linear gain (0..1). */
  function dbToLinear(db) { return Math.pow(10, db / 20); }

  /**
   * Precomputed gain curve: one multiplier per waveform sample.
   * Recomputed whenever waveData changes or autoAdjust is toggled.
   * Reactive so bars() updates when the curve is computed.
   */
  let _gainCurve = /** @type {Float32Array | null} */ ($state(null));

  // Keep audioEl.volume in sync with slider when auto-adjust is off.
  $effect(() => {
    if (audioEl && !autoAdjust) audioEl.volume = dbToLinear(volumeDb);
  });

  // Rebuild gain curve whenever any normalisation param changes.
  $effect(() => {
    if (!autoAdjust || !waveData) { _gainCurve = null; return; }
    const { maxs, norm } = waveData;
    const n = maxs.length;

    // Phase 1 — suppress samples whose peak is above suppressCutoff.
    const suppressTarget = Math.pow(0.0001, suppressLoud);
    const curve = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const peak = maxs[i] / norm;  // 0..1
      if (peak <= suppressCutoff || suppressLoud === 0) {
        curve[i] = 1; // below cutoff or strength is off: no change
      } else {
        const fullSuppress = peak > 0 ? Math.min(1, suppressTarget / peak) : 1;
        curve[i] = 1 + suppressLoud * (fullSuppress - 1);
      }
    }

    // Phase 2 — boost samples whose peak is below boostCutoff.
    // For each eligible sample, compute the gain that would bring its amplitude
    // up to boostCutoff (i.e. as loud as the quietest "not-quiet" sound).
    // Blend toward that target by boostQuiet.  Capped at 1.0 (audioEl.volume max).
    if (boostQuiet > 0) {
      for (let i = 0; i < n; i++) {
        const peak = maxs[i] / norm;
        if (peak <= 0 || peak >= boostCutoff) continue;
        const targetGain = Math.min(1, boostCutoff / peak);   // gain to reach the cutoff level
        curve[i] = Math.min(1, curve[i] + boostQuiet * (targetGain - curve[i]));
      }
    }

    _gainCurve = curve;
  });

  /** On each timeupdate, look up the precomputed gain for the current position. */
  function applyAutoVolume() {
    if (!audioEl || !_gainCurve) return;
    const dur = audioEl.duration;
    if (!dur) return;
    const idx = Math.min(_gainCurve.length - 1,
      Math.floor((audioEl.currentTime / dur) * _gainCurve.length));
    audioEl.volume = Math.max(0, Math.min(1, dbToLinear(volumeDb) * _gainCurve[idx]));
  }

  const volLabel        = $derived(volumeDb === 0 ? '0 dB' : `${volumeDb.toFixed(1)} dB`);
  const suppressLabel   = $derived(suppressLoud   === 0 ? 'off' : `${Math.round(suppressLoud   * 100)}%`);
  const boostLabel      = $derived(boostQuiet     === 0 ? 'off' : `${Math.round(boostQuiet     * 100)}%`);
  const suppressCutLbl  = $derived(`>${Math.round(suppressCutoff * 100)}%`);
  const boostCutLbl     = $derived(`<${Math.round(boostCutoff    * 100)}%`);
  async function togglePlay() {
    if (!audioEl) return;
    if (isPlaying) {
      audioEl.pause();
    } else {
      playbackMode = 'normal';
      if (audioEl.currentTime < trimBounds.startSec || audioEl.currentTime >= trimBounds.stopSec - 0.01) {
        audioEl.currentTime = trimBounds.startSec;
        currentTime = trimBounds.startSec;
      }
      audioEl.play().catch(() => {}); // ignore AbortError on rapid toggling
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
      const restartTime = ranges[0]?.startSec ?? trimBounds.startSec;
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

  // Pause playback when close is triggered so audio doesn't continue in the background.
  function handleClose() {
    if (audioEl && isPlaying) audioEl.pause();
    onclose();
  }

  // Delete: pause, ask for confirmation, then call parent handler.
  let deleteConfirm = $state(false);
  function handleDeleteClick() {
    if (audioEl && isPlaying) audioEl.pause();
    deleteConfirm = true;
  }
  function handleDeleteConfirm() {
    deleteConfirm = false;
    ondelete?.(entry);
  }
  function handleDeleteCancel() {
    deleteConfirm = false;
  }

  async function openShortcutHelp() {
    deleteConfirm = false;
    shortcutHelpOpen = true;
    await tick();
    shortcutHelpCloseEl?.focus({ preventScroll: true });
  }

  async function closeShortcutHelp() {
    shortcutHelpOpen = false;
    await tick();
    shortcutHelpButtonEl?.focus({ preventScroll: true });
  }

  // Download: fetch as blob (audio is cross-origin, so <a download> alone won't work).
  let downloadLoading = $state(false);
  async function handleDownload() {
    if (downloadLoading) return;
    downloadLoading = true;
    try {
      const res = await fetch(audioSrc);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const blob = await res.blob();
      const blobUrl = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = blobUrl;
      a.download = entry.filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(blobUrl);
    } catch (e) {
      console.error('Download failed:', e);
    } finally {
      downloadLoading = false;
    }
  }

  // False-positive flow: use a separate compact dialog so the full label
  // taxonomy remains easy to tap on a phone-sized screen.
  let samplePickerOpen = $state(false);
  let movingLabel      = $state('');
  let moveError        = $state('');
  let keepInDiary      = $state(true);

  function handleFalsePositiveClick() {
    if (audioEl && isPlaying) audioEl.pause();
    deleteConfirm = false;
    moveError = '';
    samplePickerOpen = true;
  }

  function closeSamplePicker() {
    if (movingLabel) return;
    samplePickerOpen = false;
    moveError = '';
    keepInDiary = true;
  }

  async function handleMoveToSample(label, shouldKeepInDiary = keepInDiary) {
    if (!onmovesample || movingLabel) return;
    movingLabel = label;
    moveError = '';
    try {
      await onmovesample(entry, label, shouldKeepInDiary);
      samplePickerOpen = false;
      keepInDiary = true;
    } catch (e) {
      moveError = e?.message ?? 'Could not move this recording.';
    } finally {
      movingLabel = '';
    }
  }

  // ── Re-analyze: re-score the archived source with YAMNet + classifier ────
  let reanalyzeLoading = $state(false);
  let reanalyzeError   = $state('');
  let reanalyzeThreshold = $state(0.9);
  let reanalyzeConfirm = $state(false);

  $effect(() => {
    void entry.id;
    reanalyzeThreshold = 0.9;
    reanalyzeConfirm = false;
    reanalyzeError = '';
  });

  // ── Non-destructive trim ──────────────────────────────────────────────────
  let draftTrimStartMs = $state(0);
  let draftTrimStopMs = $state(0);
  let trimDragging = $state(/** @type {'start'|'stop'|null} */ (null));
  let trimSaving = $state(false);
  let trimError = $state('');

  $effect(() => {
    void entry.id;
    void entry.trimStartMs;
    void entry.trimStopMs;
    if (trimDragging || trimSaving) return;
    draftTrimStartMs = trimBounds.startMs;
    draftTrimStopMs = trimBounds.stopMs;
    trimError = '';
  });

  const trimStartX = $derived(waveformDurationMs > 0
    ? ((draftTrimStartMs - waveformStartMs) / waveformDurationMs) * VW
    : 0);
  const trimStopX = $derived(waveformDurationMs > 0
    ? ((draftTrimStopMs - waveformStartMs) / waveformDurationMs) * VW
    : VW);

  async function saveTrim(trimStartMs, trimStopMs) {
    if (!editingAccess || trimSaving) return;
    if (trimStartMs === trimBounds.startMs && trimStopMs === trimBounds.stopMs) return;
    trimSaving = true;
    trimError = '';
    try {
      const res = await fetch(`${PRIVATE_API_BASE}/api/diary/${encodeURIComponent(entry.id)}/trim`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ trimStartMs, trimStopMs }),
        signal: AbortSignal.timeout(8000),
      });
      const saved = await res.json().catch(() => null);
      if (!res.ok) throw new Error(saved?.error ?? `HTTP ${res.status}`);
      ontrimchange?.(entry, {
        trimStartMs: saved?.trimStartMs ?? null,
        trimStopMs: saved?.trimStopMs ?? null,
      });
      if (audioEl) {
        audioEl.pause();
        audioEl.currentTime = trimStartMs / 1000;
        currentTime = trimStartMs / 1000;
      }
    } catch (e) {
      draftTrimStartMs = trimBounds.startMs;
      draftTrimStopMs = trimBounds.stopMs;
      trimError = e?.message ?? 'Could not save the trim.';
    } finally {
      trimSaving = false;
    }
  }

  async function toggleApproval() {
    if (!editingAccess || approvalSaving) return;
    const shouldApprove = !entry.approved;
    approvalSaving = true;
    approvalError = '';
    try {
      const res = await fetch(`${PRIVATE_API_BASE}/api/diary/${encodeURIComponent(entry.id)}/approved`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ approved: shouldApprove }),
        signal: AbortSignal.timeout(8000),
      });
      const saved = await res.json().catch(() => null);
      if (!res.ok) throw new Error(saved?.error ?? `HTTP ${res.status}`);
      if (shouldApprove && typeof saved?.approved !== 'string') {
        throw new Error('Approval response has an invalid timestamp');
      }
      if (!shouldApprove && saved?.approved !== null) {
        throw new Error('Approval response has an invalid shape');
      }
      onapprovalchange?.(entry, saved.approved);
    } catch (e) {
      approvalError = e?.message ?? 'Could not update approval.';
    } finally {
      approvalSaving = false;
    }
  }

  function trimPointerMilliseconds(event) {
    const svg = event.currentTarget.ownerSVGElement;
    if (!svg || waveformDurationMs <= 0) return waveformStartMs;
    const rect = svg.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width));
    return Math.round(waveformStartMs + ratio * waveformDurationMs);
  }

  function handleTrimPointerDown(side, event) {
    if (!editingAccess || trimSaving || waveformDurationMs <= 1) return;
    event.preventDefault();
    event.stopPropagation();
    trimDragging = side;
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function handleTrimPointerMove(side, event) {
    if (trimDragging !== side) return;
    event.preventDefault();
    event.stopPropagation();
    const value = trimPointerMilliseconds(event);
    const minGap = Math.min(100, Math.max(1, waveformDurationMs));
    if (side === 'start') {
      draftTrimStartMs = Math.max(waveformStartMs, Math.min(value, draftTrimStopMs - minGap));
    } else {
      draftTrimStopMs = Math.min(waveformStopMs, Math.max(value, draftTrimStartMs + minGap));
    }
  }

  function handleTrimPointerUp(side, event) {
    if (trimDragging !== side) return;
    event.preventDefault();
    event.stopPropagation();
    trimDragging = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    void saveTrim(draftTrimStartMs, draftTrimStopMs);
  }

  function handleTrimPointerCancel(event) {
    if (!trimDragging) return;
    event.stopPropagation();
    trimDragging = null;
    draftTrimStartMs = trimBounds.startMs;
    draftTrimStopMs = trimBounds.stopMs;
  }

  function handleTrimKeydown(side, event) {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    event.preventDefault();
    event.stopPropagation();
    const direction = event.key === 'ArrowRight' ? 1 : -1;
    const step = event.shiftKey ? 10000 : 1000;
    const minGap = Math.min(100, Math.max(1, waveformDurationMs));
    if (side === 'start') {
      draftTrimStartMs = Math.max(
        waveformStartMs,
        Math.min(draftTrimStartMs + direction * step, draftTrimStopMs - minGap),
      );
    } else {
      draftTrimStopMs = Math.min(
        waveformStopMs,
        Math.max(draftTrimStopMs + direction * step, draftTrimStartMs + minGap),
      );
    }
    void saveTrim(draftTrimStartMs, draftTrimStopMs);
  }

  // ── Whole-recording comment ──────────────────────────────────────────────
  let commentEditing = $state(false);
  let commentDraft = $state('');
  let commentSaving = $state(false);
  let commentError = $state('');
  /** Optimistic local value while the parent replaces its entry snapshot. */
  let savedComment = $state(/** @type {string|null} */ (null));

  $effect(() => {
    void entry.id;
    commentEditing = false;
    commentDraft = '';
    commentError = '';
    savedComment = null;
  });

  const visibleComment = $derived(savedComment ?? recordingComment(entry));

  function startCommentEdit() {
    if (!editingAccess) return;
    commentDraft = visibleComment;
    commentError = '';
    commentEditing = true;
  }

  function cancelCommentEdit() {
    if (commentSaving) return;
    commentEditing = false;
    commentDraft = '';
    commentError = '';
  }

  async function saveComment() {
    const label = commentDraft.trim();
    if (!editingAccess || !label || commentSaving) return;
    commentSaving = true;
    commentError = '';
    try {
      const res = await fetch(`${PRIVATE_API_BASE}/api/diary/${encodeURIComponent(entry.id)}/comment`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ label }),
        signal: AbortSignal.timeout(8000),
      });
      const annotations = await res.json().catch(() => null);
      if (!res.ok) throw new Error(annotations?.error ?? `HTTP ${res.status}`);
      if (!Array.isArray(annotations)) throw new Error('Comment response has an invalid shape');
      savedComment = label;
      commentEditing = false;
      oncommentchange?.(entry, annotations);
    } catch (e) {
      commentError = e?.message ?? 'Failed to save comment';
    } finally {
      commentSaving = false;
    }
  }

  async function clearComment() {
    if (!editingAccess || !visibleComment || commentSaving) return;
    commentSaving = true;
    commentError = '';
    try {
      const res = await fetch(`${PRIVATE_API_BASE}/api/diary/${encodeURIComponent(entry.id)}/comment`, {
        method: 'DELETE',
        signal: AbortSignal.timeout(8000),
      });
      const annotations = await res.json().catch(() => null);
      if (!res.ok) throw new Error(annotations?.error ?? `HTTP ${res.status}`);
      if (!Array.isArray(annotations)) throw new Error('Comment response has an invalid shape');
      savedComment = '';
      commentDraft = '';
      commentEditing = false;
      oncommentchange?.(entry, annotations);
    } catch (e) {
      commentError = e?.message ?? 'Failed to clear comment';
    } finally {
      commentSaving = false;
    }
  }

  function handleReanalyzeClick() {
    if (!editingAccess || reanalyzeLoading || !entry.reanalyzable) return;
    if (reportShortcutsEnabled) {
      deleteConfirm = false;
      reanalyzeConfirm = true;
      return;
    }
    void runReanalysis();
  }

  function handleReanalyzeCancel() {
    if (reanalyzeLoading) return;
    reanalyzeConfirm = false;
  }

  async function handleReanalyzeConfirm() {
    if (!reanalyzeConfirm || reanalyzeLoading) return;
    reanalyzeConfirm = false;
    await runReanalysis();
  }

  async function runReanalysis() {
    if (!editingAccess || reanalyzeLoading || !entry.reanalyzable) return;
    reanalyzeLoading = true;
    reanalyzeError = '';
    try {
      const request = reportShortcutsEnabled
        ? {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ candidateThreshold: reanalyzeThreshold }),
          }
        : { method: 'POST' };
      const res = await fetch(
        `${PRIVATE_API_BASE}/api/diary/${encodeURIComponent(entry.id)}/reanalyze`,
        request,
      );
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error(data?.error ?? `HTTP ${res.status}`);
      setHitMetadata(entry.id, data);
      const savedTrim = {
        trimStartMs: data?.trimStartMs ?? null,
        trimStopMs: data?.trimStopMs ?? null,
      };
      const updatedEntry = { ...entry, ...savedTrim, approved: data?.approved ?? null };
      ontrimchange?.(updatedEntry, savedTrim);
      onapprovalchange?.(updatedEntry, updatedEntry.approved);
      if (audioEl) {
        audioEl.pause();
        const nextStart = Number.isInteger(data?.trimStartMs) ? data.trimStartMs / 1000 : 0;
        audioEl.currentTime = nextStart;
        currentTime = nextStart;
      }
    } catch (e) {
      reanalyzeError = e?.message ?? 'Re-analysis failed.';
    } finally {
      reanalyzeLoading = false;
    }
  }

  function handlePlay()  { isPlaying = true; }
  function handlePause() { isPlaying = false; }
  function handleEnded() {
    isPlaying = false;
    const restartTime = playbackMode === 'approver' && approverRanges.length > 0
      ? approverRanges[0].startSec
      : trimBounds.startSec;
    approverRangeIndex = 0;
    currentTime = restartTime;
    if (audioEl) audioEl.currentTime = restartTime;
  }

  function handleTimeUpdate() {
    if (!audioEl) return;
    currentTime = audioEl.currentTime;
    if (playbackMode !== 'approver' && currentTime >= trimBounds.stopSec - 0.01 && trimBounds.stopSec < duration - 0.01) {
      audioEl.pause();
      audioEl.currentTime = trimBounds.startSec;
      currentTime = trimBounds.startSec;
    }
    applyAutoVolume();
  }
  function handleLoadedMetadata() {
    if (!audioEl) return;
    duration = audioEl.duration || entry.durationSec;
    audioEl.currentTime = trimBounds.startSec;
    currentTime = trimBounds.startSec;
  }

  // ── Waveform click-to-seek ────────────────────────────────────────────────

  /** @param {MouseEvent & { currentTarget: SVGSVGElement }} e */
  async function handleWaveformClick(e) {
    if (!audioEl || !waveformDuration) return;
    const rect  = e.currentTarget.getBoundingClientRect();
    const ratio = (e.clientX - rect.left) / rect.width;
    const requestedTime = waveformStartMs / 1000
      + Math.max(0, Math.min(1, ratio)) * waveformDuration;
    audioEl.currentTime = Math.max(
      trimBounds.startSec,
      Math.min(trimBounds.stopSec - 0.001, requestedTime),
    );
  }

  /** @param {KeyboardEvent & { currentTarget: SVGSVGElement }} e */
  function handleWaveformKeydown(e) {
    if (!audioEl || !visibleDuration) return;
    if (e.key === 'ArrowRight') { e.preventDefault(); audioEl.currentTime = Math.min(trimBounds.stopSec, currentTime + 5); }
    if (e.key === 'ArrowLeft' ) { e.preventDefault(); audioEl.currentTime = Math.max(trimBounds.startSec, currentTime - 5); }
    // Prevent browsers from firing a synthetic click on the SVG when space is
    // pressed while the waveform has focus.  That synthetic click would call
    // handleWaveformClick with clientX=0, seeking playback to position 0.
    // The global keydown handler takes care of the actual play/pause toggle.
    if (e.key === ' ')          { e.preventDefault(); }
  }

  // ── Keyboard shortcuts ────────────────────────────────────────────────────
  function handleGlobalKeydown(e) {
    if (e.key === 'Escape') {
      if (shortcutHelpOpen) void closeShortcutHelp();
      else if (samplePickerOpen) closeSamplePicker();
      else if (reanalyzeConfirm) handleReanalyzeCancel();
      else if (deleteConfirm) handleDeleteCancel();
      else handleClose();
      return;
    }
    const target = /** @type {HTMLElement | null} */ (e.target);
    const tag = target?.tagName;
    const inField = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target?.isContentEditable;
    const key = e.key.toLowerCase();
    const withoutCommandModifier = !e.ctrlKey && !e.metaKey && !e.altKey;

    // An open child dialog owns the keyboard until it is dismissed.
    if (shortcutHelpOpen || samplePickerOpen) return;

    if (reanalyzeConfirm) {
      if (tag !== 'BUTTON' && !inField && withoutCommandModifier && key === 'enter') {
        e.preventDefault();
        if (!e.repeat) void handleReanalyzeConfirm();
      }
      return;
    }

    if (deleteConfirm) {
      if (!inField && withoutCommandModifier && key === 'enter') {
        e.preventDefault();
        if (!e.repeat) handleDeleteConfirm();
      }
      return;
    }

    if (
      !inField
      && withoutCommandModifier
      && (key === 'arrowup' || key === 'arrowdown' || key === 'q' || key === 'w')
      && (onprevious || onnext)
    ) {
      e.preventDefault();
      if (key === 'arrowdown' || key === 'w') onnext?.();
      else onprevious?.();
      return;
    }

    if (
      reportShortcutsEnabled
      && editingAccess
      && ondelete
      && !inField
      && withoutCommandModifier
      && (key === 'delete' || key === 'backspace')
    ) {
      e.preventDefault();
      if (!e.repeat) handleDeleteClick();
      return;
    }

    const sampleMove = sampleMoveForShortcut(e.key, e.shiftKey);
    if (
      reportShortcutsEnabled
      && editingAccess
      && onmovesample
      && !entry.sampleId
      && !movingLabel
      && !inField
      && withoutCommandModifier
      && sampleMove
    ) {
      e.preventDefault();
      if (!e.repeat) {
        if (audioEl && isPlaying) audioEl.pause();
        void handleMoveToSample(sampleMove.label, sampleMove.keepInDiary);
      }
      return;
    }

    if (
      editingAccess
      && !inField
      && withoutCommandModifier
      && !e.shiftKey
      && key === 'p'
    ) {
      e.preventDefault();
      if (!e.repeat) void toggleApproval();
      return;
    }
    if (e.key === ' ') {
      // Don't hijack space when the user is typing in a text field, or when
      // a panel button has focus (the button handles space natively via
      // onclick; firing togglePlay here too would double-toggle immediately).
      // Buttons behind the modal must not retain Space: that would re-open the
      // current entry instead of starting playback.
      const panelButton = tag === 'BUTTON' && (
        playerPanelEl?.contains(target) || target?.closest('.sample-picker')
      );
      if (!inField && withoutCommandModifier && (e.shiftKey || !panelButton)) {
        e.preventDefault(); // prevent page scroll
        if (!e.repeat) {
          if (e.shiftKey) void toggleApproverPlay();
          else void togglePlay();
        }
      }
    }
  }
  onMount(() => {
    let disposed = false;
    const previouslyFocused = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    playerPanelEl?.focus({ preventScroll: true });
    void probeEditingAccess().then((available) => {
      if (!disposed) editingAccess = available;
    });
    document.addEventListener('keydown', handleGlobalKeydown);
    return () => {
      disposed = true;
      document.removeEventListener('keydown', handleGlobalKeydown);
      if (previouslyFocused?.isConnected) previouslyFocused.focus({ preventScroll: true });
    };
  });

  // ── Helpers ───────────────────────────────────────────────────────────────
  const formattedDate  = $derived(formatDate(entry.date));
  const formattedDur   = $derived(formatDuration(visibleDuration));
  const formattedCur   = $derived(formatDuration(visibleCurrentTime));
  const displayEntry = $derived({ ...entry, durationSec: visibleDuration });
  const displayLabel   = $derived(formatAudioPanelTitle(displayEntry, visibleHitMetadata));
  const analysisSummary = $derived(formatAudioPanelStats(visibleHitMetadata, visibleDuration));
  const analysisParameters = $derived(formatAudioPanelAnalysisParameters(hitMetadata));
  const audioSrc       = $derived(`${ASSET_BASE}/${entry.audioPath}`);
</script>

<!-- Slide up from bottom -->
<div
  class="panel-backdrop"
  onclick={handleClose}
  onkeydown={(e) => e.key === 'Enter' && handleClose()}
  role="button"
  tabindex="-1"
  aria-label="Close player"
>
</div>

<div
  bind:this={playerPanelEl}
  class="player-panel"
  role="dialog"
  tabindex="-1"
  aria-label="Audio player: {visibleComment || displayLabel}"
  aria-modal="true"
  transition:fly={{ y: 200, duration: 220 }}
  onoutroend={onclosed}
>
  <!-- ── Panel header ── -->
  <div class="panel-header">
    <div class="panel-meta">
      <span class="panel-kind panel-kind--{entry.kind}">{entry.kind}</span>
      <span class="panel-datetime">{entry.date} · {entry.time}</span>
      <span class="panel-dur">{formattedDur}</span>
    </div>
    {#if editingAccess && deleteConfirm}
      <span class="delete-confirm">
        <span class="delete-confirm-text">Delete?</span>
        <button class="delete-confirm-yes" onclick={handleDeleteConfirm} aria-label="Confirm delete">Yes</button>
        <button class="delete-confirm-no"  onclick={handleDeleteCancel} aria-label="Cancel delete">No</button>
      </span>
    {:else if editingAccess && reportShortcutsEnabled && reanalyzeConfirm}
      <span class="delete-confirm reanalyze-confirm">
        <label
          class="reanalyze-threshold"
          title="Classifier threshold for this re-analysis only"
        >
          <span>t {reanalyzeThreshold.toFixed(2)}</span>
          <input
            type="range"
            min="0.8"
            max="1"
            step="0.01"
            bind:value={reanalyzeThreshold}
            aria-label="Re-analysis classifier threshold"
          />
        </label>
        <button class="reanalyze-confirm-run" onclick={handleReanalyzeConfirm} aria-label="Start re-analysis">Run</button>
        <button class="delete-confirm-no" onclick={handleReanalyzeCancel} aria-label="Cancel re-analysis">Cancel</button>
      </span>
    {:else}
      {#if editingAccess}
        <button
          class="approval-btn"
          class:approved={Boolean(entry.approved)}
          onclick={toggleApproval}
          disabled={approvalSaving}
          aria-label={entry.approved ? 'Remove recording approval' : 'Approve recording'}
          aria-pressed={Boolean(entry.approved)}
          title={entry.approved ? 'Remove approval (P)' : 'Approve recording (P)'}
        >{entry.approved ? '✅' : '👍'}</button>
      {/if}
      {#if editingAccess && onmovesample && !entry.sampleId}
        <button class="false-positive-btn" onclick={handleFalsePositiveClick} aria-label="Mark as false positive" title="Move this false positive to training samples">👎</button>
      {/if}
      {#if editingAccess}
        <button
          class="reanalyze-btn"
          onclick={handleReanalyzeClick}
          disabled={reanalyzeLoading || !entry.reanalyzable}
          aria-label="Re-analyze recording"
          title={entry.reanalyzable
            ? 'Re-run deterministic bark-window classification against the source WAV'
            : 'Source WAV is not available for re-analysis'}
        >{reanalyzeLoading ? '⏳' : '🔁'}</button>
      {/if}
      {#if entry.sampleId}
        <a class="cross-link-btn" href="/training#{entry.sampleId}" title="View linked training sample">🔬</a>
      {/if}
      {#if editingAccess && ondelete}
        <button class="delete-btn" onclick={handleDeleteClick} aria-label="Delete entry" title="Delete this recording">🗑</button>
      {/if}
    {/if}
    {#if editingAccess}
      <button
        class="download-btn"
        onclick={handleDownload}
        disabled={downloadLoading}
        aria-label="Download recording"
        title="Download audio file"
      >{downloadLoading ? '⏳' : '📥'}</button>
    {/if}
    {#if editingAccess && reportShortcutsEnabled}
      <button
        bind:this={shortcutHelpButtonEl}
        class="shortcut-help-btn"
        onclick={openShortcutHelp}
        aria-label="Show keyboard shortcuts"
        aria-haspopup="dialog"
        aria-expanded={shortcutHelpOpen}
        title="Keyboard shortcuts"
      >ℹ️</button>
    {/if}
    <button class="close-btn" class:admin-controls-hidden={!editingAccess} onclick={handleClose} aria-label="Close player">✕</button>
  </div>

  {#if editingAccess && commentEditing}
    <form class="comment-editor" onsubmit={(event) => { event.preventDefault(); saveComment(); }}>
      <input
        class="comment-input"
        bind:value={commentDraft}
        aria-label="Recording comment"
        placeholder="Add a comment…"
        disabled={commentSaving}
        onkeydown={(event) => {
          event.stopPropagation();
          if (event.key === 'Escape') {
            event.preventDefault();
            cancelCommentEdit();
          }
        }}
      />
      <button class="comment-save" type="submit" disabled={!commentDraft.trim() || commentSaving}>
        {commentSaving ? 'Saving…' : 'Save'}
      </button>
      {#if visibleComment}
        <button class="comment-clear" type="button" onclick={clearComment} disabled={commentSaving}>Clear</button>
      {/if}
      <button class="comment-cancel" type="button" onclick={cancelCommentEdit} disabled={commentSaving}>Cancel</button>
    </form>
  {:else if editingAccess}
    <button
      class="panel-comment"
      class:empty={!visibleComment}
      onclick={startCommentEdit}
      title={visibleComment ? 'Edit comment' : 'Add comment'}
    >
      <span>{visibleComment || 'Add comment'}</span>
      <span class="comment-edit-icon" aria-hidden="true">✎</span>
    </button>
  {:else if visibleComment}
    <p class="panel-comment-readonly">{visibleComment}</p>
  {/if}

  {#if analysisSummary}
    <p class="panel-analysis">{analysisSummary}</p>
  {/if}

  {#if editingAccess && entry.waveformPath}
    <div class="trim-status" class:error={Boolean(trimError)}>
      {#if trimSaving}Saving trim…{:else if trimError}{trimError}{:else}Drag the waveform edge handles to set the visible range. Re-analysis fits it around newly found barks.{/if}
    </div>
  {/if}

  {#if commentError}
    <p class="comment-error" role="alert">{commentError}</p>
  {/if}

  {#if reanalyzeError}
    <p class="reanalyze-error">{reanalyzeError}</p>
  {/if}

  {#if movingLabel && !samplePickerOpen}
    <p class="move-status">Moving to {movingLabel} samples…</p>
  {:else if moveError && !samplePickerOpen}
    <p class="move-error" role="alert">{moveError}</p>
  {/if}

  {#if approvalError}
    <p class="approval-error" role="alert">{approvalError}</p>
  {/if}

  <!-- ── Waveform area ── -->
  <div class="waveform-area">
    {#if entry.waveformPath && !wfLoading && waveData}
      <div class="player-waveform-wrap" bind:this={waveWrapEl}>
        <!-- Waveform bars are painted here at native pixel resolution
             instead of as hundreds of SVG <rect> nodes (see drawWaveCanvas). -->
        <canvas class="wave-canvas" bind:this={waveCanvasEl}></canvas>

        <!-- SVG waveform with playhead overlay -->
        <!-- Clicking the SVG seeks to the clicked position -->
        <svg
          class="player-waveform"
          viewBox="0 0 {VW} {VH}"
          preserveAspectRatio="none"
          role="slider"
          tabindex="0"
          aria-label="Seek waveform. Current position: {formattedCur}"
          aria-valuemin="0"
          aria-valuemax={waveformDuration}
          aria-valuenow={waveformCurrentTime}
          onclick={handleWaveformClick}
          onkeydown={handleWaveformKeydown}
        >
        <!-- Invisible hit-area rectangle covering the full viewbox.
             SVG's default pointer-events is "painted" so clicks in the
             gaps between bars are dead zones in Chrome.  A transparent rect
             (fill="transparent" counts as painted, unlike fill="none")
             ensures every pixel inside the SVG fires the seek handler. -->
        <rect x="0" y="0" width={VW} height={VH} fill="transparent" />

        <!-- Hit markers: each confirmed bark hit from goblin inference.
             hx = end of the detection window (block_end_ts - clip_start_ts).
             A faint band extends back by window_s to show the uncertainty range
             — the bark happened somewhere inside the band, not necessarily at hx. -->
        {#if waveformHitMetadata && waveformDuration > 0}
          {@const winPx = (waveformHitMetadata.windowS / waveformDuration) * VW}
          {#each waveformHitMetadata.timestamps as ts, i}
            {@const hx = (ts / waveformDuration) * VW}
            {@const conf = waveformHitMetadata.confidences[i]}
            {@const loud = waveformHitMetadata.loudnesses[i]}
            {@const tickAlpha = 0.45 + conf * 0.45}
            <g
              pointer-events="all"
              role="presentation"
              onmouseenter={() => (hoveredHitIndex = i)}
              onmouseleave={() => (hoveredHitIndex = null)}
            >
              <!-- Detection-window band: bark is somewhere inside here —
                   more opaque while hovered, same as fragment highlighting
                   on focus in /training. -->
              <rect
                x={Math.max(0, hx - winPx)}
                y="0"
                width={Math.min(hx, winPx)}
                height={VH}
                fill="rgba(230, 120, 0, {hoveredHitIndex === i ? 0.5 : 0.1})"
              />
              <!-- Tick at end of window -->
              <line
                x1={hx} y1="0"
                x2={hx} y2={VH}
                stroke="rgba(230, 120, 0, {tickAlpha})"
                stroke-width="1.5"
              />
              <!-- Labels: right-aligned to the tick, two lines at top — only
                   while hovered, otherwise they clutter/overlap. -->
              {#if hoveredHitIndex === i}
                <text
                  x={hx - 3}
                  y="14"
                  font-size="var(--font-size-small)"
                  font-family="monospace"
                  text-anchor="end"
                  fill="rgba(200, 90, 0, {tickAlpha})"
                  pointer-events="none"
                >C{conf.toFixed(2)}</text>
                <text
                  x={hx - 3}
                  y="28"
                  font-size="var(--font-size-small)"
                  font-family="monospace"
                  text-anchor="end"
                  fill="rgba(200, 90, 0, {tickAlpha})"
                  pointer-events="none"
                >L{loud.toFixed(1)}x</text>
              {/if}
              <!-- Diamond at bottom -->
              <polygon
                points="{hx},{VH - 10} {hx - 4},{VH - 5} {hx},{VH} {hx + 4},{VH - 5}"
                fill="rgb(230, 120, 0)"
                opacity={tickAlpha}
              >
                <title>Hit {i + 1}/{waveformHitMetadata.timestamps.length} · confidence {Math.round(conf * 100)}% · loudness {loud.toFixed(1)}× · bark is within the shaded band</title>
              </polygon>
            </g>
          {/each}
        {/if}

        {#if editingAccess && waveformDuration > 0}
          <!-- Editors retain the full source as context. Public/read-only
               playback crops this same waveform to the persisted section. -->
          <rect
            class="trim-excluded"
            x="0" y="0" width={Math.max(0, trimStartX)} height={VH}
            pointer-events="none"
          />
          <rect
            class="trim-excluded"
            x={Math.min(VW, trimStopX)} y="0"
            width={Math.max(0, VW - trimStopX)} height={VH}
            pointer-events="none"
          />
          <g
            class="trim-handle trim-handle-start"
            class:dragging={trimDragging === 'start'}
            role="slider"
            tabindex="0"
            aria-label="Trim start"
            aria-valuemin={waveformStartMs}
            aria-valuemax={Math.max(trimBounds.startMs, draftTrimStopMs - 1)}
            aria-valuenow={draftTrimStartMs}
            onpointerdown={(event) => handleTrimPointerDown('start', event)}
            onpointermove={(event) => handleTrimPointerMove('start', event)}
            onpointerup={(event) => handleTrimPointerUp('start', event)}
            onpointercancel={handleTrimPointerCancel}
            onkeydown={(event) => handleTrimKeydown('start', event)}
            onclick={(event) => event.stopPropagation()}
          >
            <line x1={trimStartX} y1="0" x2={trimStartX} y2={VH} />
            <path d={`M ${trimStartX} 6 L ${trimStartX + 18} 14 L ${trimStartX} 22 Z`} />
          </g>
          <g
            class="trim-handle trim-handle-stop"
            class:dragging={trimDragging === 'stop'}
            role="slider"
            tabindex="0"
            aria-label="Trim end"
            aria-valuemin={Math.min(trimBounds.stopMs, draftTrimStartMs + 1)}
            aria-valuemax={waveformStopMs}
            aria-valuenow={draftTrimStopMs}
            onpointerdown={(event) => handleTrimPointerDown('stop', event)}
            onpointermove={(event) => handleTrimPointerMove('stop', event)}
            onpointerup={(event) => handleTrimPointerUp('stop', event)}
            onpointercancel={handleTrimPointerCancel}
            onkeydown={(event) => handleTrimKeydown('stop', event)}
            onclick={(event) => event.stopPropagation()}
          >
            <line x1={trimStopX} y1="0" x2={trimStopX} y2={VH} />
            <path d={`M ${trimStopX} 6 L ${trimStopX - 18} 14 L ${trimStopX} 22 Z`} />
          </g>
        {/if}

        <!-- Playhead line -->
        {#if waveformDuration > 0}
          <line
            x1={playheadX} y1="0"
            x2={playheadX} y2={VH}
            stroke="#1a1a1a"
            stroke-width="1.5"
            pointer-events="none"
          />
          <!-- Playhead knob -->
          <circle
            cx={playheadX}
            cy={VH / 2}
            r="4"
            fill="#1a1a1a"
            pointer-events="none"
          />
        {/if}
        </svg>
      </div>
    {:else if entry.waveformPath && wfLoading}
      <div class="waveform-loading">Loading waveform…</div>
    {:else}
      <!-- No waveform available: progress bar fallback -->
      <div class="waveform-fallback">
        <div
          class="progress-bar-fill"
          style="width: {visibleDuration > 0 ? (visibleCurrentTime / visibleDuration) * 100 : 0}%"
        ></div>
      </div>
    {/if}

    <div class="line-under-waveform">
      <!-- Time display -->
      <div class="time-display">
        <span>{formattedCur}</span>
        <span class="time-sep">/</span>
        <span>{formattedDur}</span>
      </div>

      
      {#if editingAccess && analysisParameters}
        <div class="analysis-parameters">{analysisParameters}</div>
      {/if}
    </div>
  </div>

  <!-- ── Playback controls ── -->
  <div class="controls">
    <button
      class="play-btn"
      onclick={togglePlay}
      aria-label={isPlaying ? 'Pause' : 'Play'}
      disabled={!audioEl}
    >
      {#if isPlaying}
        <!-- Pause icon -->
        <svg viewBox="0 0 24 24" fill="currentColor" width="28" height="28">
          <rect x="5" y="3" width="4" height="18" rx="1"/>
          <rect x="15" y="3" width="4" height="18" rx="1"/>
        </svg>
      {:else}
        <!-- Play icon -->
        <svg viewBox="0 0 24 24" fill="currentColor" width="28" height="28">
          <polygon points="5,3 19,12 5,21"/>
        </svg>
      {/if}
    </button>
    {#if editingAccess}
      <button
        class="approver-play-btn"
        class:active={playbackMode === 'approver'}
        onclick={toggleApproverPlay}
        disabled={!hitMetadata || approverRanges.length === 0}
        aria-label={isPlaying && playbackMode === 'approver' ? 'Pause approver listening' : 'Play tagged fragments only'}
        aria-pressed={playbackMode === 'approver'}
        title={!hitMetadata
          ? 'Loading tagged fragments…'
          : approverRanges.length === 0
            ? 'No tagged fragments to play'
            : 'Approver listening: play tagged fragments only (Shift+Space)'}
      >{isPlaying && playbackMode === 'approver' ? '⏸' : '▶┊▶'}</button>
    {/if}
  </div>

  <!-- ── Volume control ── -->
  <div class="volume-row">
    <label class="vol-label" for="vol-slider">{volLabel}</label>
    <input
      id="vol-slider"
      class="vol-slider"
      type="range"
      min="-30"
      max="0"
      step="0.5"
      bind:value={volumeDb}
      aria-label="Volume"
    />
    <label class="auto-label">
      <input type="checkbox" bind:checked={autoAdjust} />
      auto
    </label>
    {#if autoAdjust}
      <div class="norm-rows">
        <div class="norm-row">
          <span class="norm-label">suppress {suppressLabel}</span>
          <input class="norm-slider" type="range" min="0" max="1" step="0.01"
            bind:value={suppressLoud} aria-label="Suppress amount" />
          <span class="norm-label cutoff-lbl">{suppressCutLbl}</span>
          <input class="norm-slider cutoff-slider" type="range" min="0" max="1" step="0.01"
            bind:value={suppressCutoff} aria-label="Suppress cutoff" />
        </div>
        <div class="norm-row">
          <span class="norm-label">boost {boostLabel}</span>
          <input class="norm-slider" type="range" min="0" max="1" step="0.01"
            bind:value={boostQuiet} aria-label="Boost amount" />
          <span class="norm-label cutoff-lbl">{boostCutLbl}</span>
          <input class="norm-slider cutoff-slider" type="range" min="0" max="1" step="0.01"
            bind:value={boostCutoff} aria-label="Boost cutoff" />
        </div>
      </div>
    {/if}
  </div>

  <!-- Native audio element (hidden, drives playback) -->
  <audio
    bind:this={audioEl}
    src={audioSrc}
    preload="metadata"
    onplay={handlePlay}
    onpause={handlePause}
    onended={handleEnded}
    ontimeupdate={handleTimeUpdate}
    onloadedmetadata={handleLoadedMetadata}
  ></audio>
</div>

{#if shortcutHelpOpen}
  <button
    class="shortcut-help-backdrop"
    onclick={() => void closeShortcutHelp()}
    aria-label="Close keyboard shortcuts"
  ></button>
  <div
    class="shortcut-help-dialog"
    role="dialog"
    aria-modal="true"
    aria-labelledby="shortcut-help-title"
  >
    <header class="shortcut-help-header">
      <div>
        <h2 id="shortcut-help-title">Keyboard shortcuts</h2>
        <p>Available while a report recording is open.</p>
      </div>
      <button
        bind:this={shortcutHelpCloseEl}
        class="shortcut-help-close"
        onclick={() => void closeShortcutHelp()}
        aria-label="Close keyboard shortcuts"
      >✕</button>
    </header>

    <dl class="shortcut-list">
      <div><dt><kbd>Space</kbd></dt><dd>Play or pause</dd></div>
      <div><dt><kbd>Shift</kbd> + <kbd>Space</kbd></dt><dd>Play tagged fragments only</dd></div>
      <div><dt><kbd>Esc</kbd></dt><dd>Close this sheet, another dialog, or the player</dd></div>
      <div><dt><kbd>↑</kbd> <span>or</span> <kbd>Q</kbd></dt><dd>Previous recording</dd></div>
      <div><dt><kbd>↓</kbd> <span>or</span> <kbd>W</kbd></dt><dd>Next recording</dd></div>
      <div><dt><kbd>←</kbd> <kbd>→</kbd></dt><dd>Seek 5 seconds when the waveform is focused</dd></div>
    </dl>

    <section class="shortcut-help-section">
      <h3>Operator actions</h3>
      <p class="shortcut-help-note">Available with private editing access.</p>
      <dl class="shortcut-list">
        <div><dt><kbd>P</kbd></dt><dd>Toggle approval</dd></div>
        <div><dt><kbd>Del</kbd> <span>or</span> <kbd>Backspace</kbd></dt><dd>Ask to delete recording</dd></div>
        <div><dt><kbd>Enter</kbd></dt><dd>Confirm deletion</dd></div>
        <div><dt><kbd>label</kbd></dt><dd>Move to training samples and keep in diary</dd></div>
        <div><dt><kbd>Shift</kbd> + <kbd>label</kbd></dt><dd>Move to training samples and remove from diary</dd></div>
      </dl>
    </section>

    <section class="shortcut-help-section">
      <h3>Training-sample labels</h3>
      <div class="shortcut-labels">
        {#each SAMPLE_LABELS as label}
          <div>
            <kbd>{sampleLabelShortcut(label).toUpperCase()}</kbd>
            <span class="shortcut-label-dot" style:background={sampleLabelColor(label)}></span>
            <span>{label}</span>
          </div>
        {/each}
      </div>
    </section>
  </div>
{/if}

{#if samplePickerOpen}
  <button
    class="sample-picker-backdrop"
    onclick={closeSamplePicker}
    aria-label="Close Move to samples dialog"
    disabled={Boolean(movingLabel)}
  ></button>
  <div class="sample-picker" role="dialog" aria-modal="true" aria-labelledby="sample-picker-title">
    <div class="sample-picker-header">
      <h2 id="sample-picker-title">Move to samples</h2>
      <button class="sample-picker-close" onclick={closeSamplePicker} aria-label="Close" disabled={Boolean(movingLabel)}>✕</button>
    </div>
    <div class="sample-labels" aria-label="Sample label">
      {#each SAMPLE_LABELS as label}
        <button
          class="sample-label-pill"
          style:background={sampleLabelColor(label)}
          onclick={() => handleMoveToSample(label)}
          disabled={Boolean(movingLabel)}
          aria-label="Move to {label} samples"
        >{movingLabel === label ? 'Moving…' : label}</button>
      {/each}
    </div>
    {#if moveError}<p class="sample-picker-error" role="alert">{moveError}</p>{/if}
    <label class="keep-in-diary-label">
      <input type="checkbox" bind:checked={keepInDiary} disabled={Boolean(movingLabel)} />
      Keep in diary
    </label>
  </div>
{/if}

<style>
  /* ── Backdrop ── */
  .panel-backdrop {
    position: fixed;
    inset: 0;
    background: rgba(0,0,0,0.25);
    z-index: 600; /* above diary entries (max z-index 570) */
  }

  /* ── Panel ── */
  .player-panel {
    position: fixed;
    bottom: 0;
    left: 0;
    right: 0;
    z-index: 601;
    background: #fff;
    border-top: 1px solid #d0d0cc;
    border-radius: 12px 12px 0 0;
    box-shadow: 0 -4px 24px rgba(0,0,0,0.12);
    padding: 1rem 1.25rem 1.5rem;
    max-width: 860px;
    margin: 0 auto;
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
  }
  .player-panel:focus { outline: none; }

  /* ── Header ── */
  .panel-header {
    display: flex;
    align-items: flex-start;
    gap: 0.5rem;
    position: relative;
  }

  .panel-meta {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    flex-wrap: wrap;
  }

  .panel-kind {
    font-family: var(--font-tiny); font-size: var(--font-size-tiny);
    font-weight: 700;
    text-transform: uppercase;
    padding: 1px 6px;
    border-radius: 3px;
  }
  .panel-kind--audio { background: #dce8ff; color: #2255bb; }
  .panel-kind--note  { background: #fff3cd; color: #7a6000; }
  .panel-kind--empty { background: #ebebeb; color: #666; }

  .panel-datetime {
    font-family: var(--font-tiny); font-size: var(--font-size-tiny);
    color: #666;
  }

  .panel-dur {
    font-family: var(--font-tiny); font-size: var(--font-size-tiny);
    color: #999;
  }

  .panel-comment {
    width: fit-content;
    max-width: 100%;
    margin: 0;
    padding: 0;
    display: inline-flex;
    align-items: baseline;
    gap: 0.4rem;
    border: 0;
    background: transparent;
    color: #1a1a1a;
    cursor: pointer;
    font-family: inherit;
    font-size: var(--font-size-medium);
    font-weight: 600;
    text-align: left;
  }
  .panel-comment:hover { color: #2255bb; }
  .panel-comment.empty { color: #888; font-weight: 500; }
  .comment-edit-icon { color: #999; font-family: var(--font-tiny); font-size: var(--font-size-tiny); }
  .panel-comment-readonly {
    width: fit-content;
    max-width: 100%;
    margin: 0;
    font-size: var(--font-size-medium);
    font-weight: 600;
  }

  .comment-editor {
    display: flex;
    align-items: center;
    gap: 0.4rem;
  }
  .comment-input {
    min-width: 0;
    flex: 1;
    border: 1px solid #b9c7df;
    border-radius: 5px;
    padding: 0.42rem 0.55rem;
    font: inherit;
    font-size: var(--font-size-small);
  }
  .comment-input:focus { outline: 2px solid #4a7cdc; outline-offset: 1px; }
  .comment-save,
  .comment-clear,
  .comment-cancel {
    border: 1px solid #c8c8c3;
    border-radius: 5px;
    padding: 0.38rem 0.65rem;
    background: #fff;
    color: #444;
    cursor: pointer;
    font: inherit;
    font-family: var(--font-tiny); font-size: var(--font-size-tiny);
  }
  .comment-save { border-color: #2255bb; background: #2255bb; color: #fff; }
  .comment-clear { border-color: #d9aaa5; color: #a33a30; }
  .comment-save:disabled,
  .comment-clear:disabled,
  .comment-cancel:disabled { cursor: default; opacity: 0.5; }
  .panel-analysis {
    margin: -0.45rem 0 0;
    color: #888;
    font-family: var(--font-tiny); font-size: var(--font-size-tiny);
  }
  .comment-error {
    margin: -0.4rem 0 0;
    color: #c0392b;
    font-family: var(--font-tiny); font-size: var(--font-size-tiny);
  }

  .close-btn {
    flex-shrink: 0;
    background: none;
    border: none;
    font-size: var(--font-size-medium);
    color: #888;
    cursor: pointer;
    padding: 0.1rem 0.35rem;
    border-radius: 4px;
    line-height: 1;
    margin-left: 0.15rem;
  }
  .close-btn:hover { background: #f0f0ec; color: #333; }
  .close-btn.admin-controls-hidden { margin-left: auto; }

  .download-btn,
  .delete-btn,
  .approval-btn,
  .false-positive-btn,
  .reanalyze-btn,
  .shortcut-help-btn {
    flex-shrink: 0;
    background: none;
    border: none;
    font-size: var(--font-size-medium);
    color: #aaa;
    cursor: pointer;
    padding: 0.1rem 0.35rem;
    border-radius: 4px;
    line-height: 1;
  }
  .false-positive-btn { margin-left: 0; }
  .approval-btn:hover { background: #eaf7ec; color: #247a35; }
  .approval-btn.approved { color: #247a35; }
  .approval-btn:disabled { cursor: wait; opacity: 0.5; }
  .reanalyze-threshold {
    display: inline-flex;
    align-items: center;
    gap: 0.2rem;
    flex-shrink: 0;
    color: #777;
    font-family: var(--font-tiny);
    font-size: var(--font-size-tiny);
    white-space: nowrap;
  }
  .reanalyze-threshold span { min-width: 2.85rem; text-align: right; }
  .reanalyze-threshold input {
    width: 3.75rem;
    margin: 0;
    accent-color: #2255bb;
    cursor: pointer;
  }
  .reanalyze-threshold input:disabled { cursor: not-allowed; opacity: 0.4; }
  .reanalyze-confirm-run {
    border: 0;
    border-radius: 4px;
    padding: 0.15rem 0.5rem;
    background: #2255bb;
    color: #fff;
    cursor: pointer;
    font-family: var(--font-tiny);
    font-size: var(--font-size-tiny);
  }
  .reanalyze-confirm-run:hover { background: #194493; }
  .reanalyze-btn:hover { background: #e8f4ff; color: #2255bb; }
  .reanalyze-btn:disabled { opacity: 0.35; cursor: not-allowed; filter: grayscale(1); }
  .reanalyze-btn:disabled:hover { background: none; color: #aaa; }
  .cross-link-btn {
    display: inline-flex; align-items: center; justify-content: center;
    font-size: var(--font-size-medium); line-height: 1; padding: 0.2rem 0.3rem;
    border-radius: 6px; text-decoration: none; color: inherit;
    border: 1px solid transparent;
  }
  .cross-link-btn:hover { background: #e8f4ff; border-color: #b0d0f0; }
  .download-btn { margin-left: auto; }
  .download-btn:hover { background: #e8f4ff; color: #2255bb; }
  .download-btn:disabled { opacity: 0.5; cursor: default; }
  .shortcut-help-btn:hover { background: #eef1f5; color: #2255bb; }
  .delete-btn:hover { background: #fdecea; color: #c0392b; }
  .false-positive-btn:hover { background: #fff3cd; color: #6f5900; }

  .reanalyze-error,
  .approval-error,
  .move-error,
  .move-status {
    margin: 0 1rem 0.5rem;
    font-size: var(--font-size-small);
  }
  .reanalyze-error,
  .approval-error,
  .move-error {
    color: #c0392b;
  }
  .move-status { color: #666; }

  .delete-confirm {
    display: flex;
    align-items: center;
    gap: 0.35rem;
    margin-left: auto;
    flex-shrink: 0;  }
  .delete-confirm-text {
    font-family: var(--font-tiny); font-size: var(--font-size-tiny);
    color: #c0392b;
    font-weight: 600;
  }
  .delete-confirm-yes {
    font-family: var(--font-tiny); font-size: var(--font-size-tiny);
    padding: 0.15rem 0.5rem;
    background: #c0392b;
    color: #fff;
    border: none;
    border-radius: 4px;
    cursor: pointer;
  }
  .delete-confirm-yes:hover { background: #a93226; }
  .delete-confirm-no {
    font-family: var(--font-tiny); font-size: var(--font-size-tiny);
    padding: 0.15rem 0.5rem;
    background: #f0f0ec;
    color: #333;
    border: none;
    border-radius: 4px;
    cursor: pointer;
  }
  .delete-confirm-no:hover { background: #e0e0dc; }

  /* ── Keyboard-shortcut cheatsheet ── */
  .shortcut-help-backdrop {
    position: fixed;
    inset: 0;
    z-index: 604;
    width: 100%;
    height: 100%;
    border: 0;
    background: rgba(0,0,0,0.38);
    cursor: default;
  }

  .shortcut-help-dialog {
    position: fixed;
    left: 50%;
    top: 50%;
    z-index: 605;
    width: min(92vw, 620px);
    max-height: min(86vh, 720px);
    overflow-y: auto;
    transform: translate(-50%, -50%);
    border-radius: 12px;
    background: #fff;
    box-shadow: 0 12px 44px rgba(0,0,0,0.26);
    padding: 1.1rem;
  }

  .shortcut-help-header {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 1rem;
  }
  .shortcut-help-header h2 {
    margin: 0;
    font-size: var(--font-size-large);
  }
  .shortcut-help-header p,
  .shortcut-help-note {
    margin: 0.25rem 0 0;
    color: #777;
    font-family: var(--font-tiny);
    font-size: var(--font-size-tiny);
  }
  .shortcut-help-close {
    flex: 0 0 auto;
    border: 0;
    border-radius: 4px;
    padding: 0.25rem 0.4rem;
    background: transparent;
    color: #777;
    cursor: pointer;
    font-size: var(--font-size-medium);
  }
  .shortcut-help-close:hover { background: #f0f0ec; color: #222; }

  .shortcut-help-section {
    margin-top: 1rem;
    padding-top: 0.85rem;
    border-top: 1px solid #e7e7e2;
  }
  .shortcut-help-section h3 {
    margin: 0;
    font-size: var(--font-size-small);
  }
  .shortcut-list {
    margin: 0.9rem 0 0;
    display: grid;
    gap: 0.45rem;
  }
  .shortcut-list > div {
    display: grid;
    grid-template-columns: minmax(9.5rem, 0.8fr) minmax(0, 1.5fr);
    align-items: center;
    gap: 0.8rem;
  }
  .shortcut-list dt,
  .shortcut-list dd { margin: 0; }
  .shortcut-list dt {
    display: flex;
    align-items: center;
    gap: 0.3rem;
    color: #777;
    font-family: var(--font-tiny);
    font-size: var(--font-size-tiny);
  }
  .shortcut-list dd { font-size: var(--font-size-small); }

  .shortcut-help-dialog kbd {
    min-width: 1.8rem;
    padding: 0.16rem 0.38rem;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    border: 1px solid #c8c8c3;
    border-bottom-width: 2px;
    border-radius: 4px;
    background: #f7f7f5;
    color: #333;
    font-family: var(--font-monospace);
    font-size: var(--font-size-tiny);
    line-height: 1.2;
    white-space: nowrap;
  }

  .shortcut-labels {
    margin-top: 0.75rem;
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 0.45rem 0.8rem;
  }
  .shortcut-labels > div {
    min-width: 0;
    display: grid;
    grid-template-columns: auto 0.55rem minmax(0, 1fr);
    align-items: center;
    gap: 0.4rem;
    font-size: var(--font-size-small);
  }
  .shortcut-label-dot {
    width: 0.55rem;
    height: 0.55rem;
    border-radius: 50%;
  }

  /* ── False-positive label picker ── */
  .sample-picker-backdrop {
    position: fixed;
    inset: 0;
    z-index: 602; /* above diary entries (max z-index 570) and the player panel */
    width: 100%;
    height: 100%;
    border: none;
    background: rgba(0,0,0,0.35);
    cursor: default;
  }

  .sample-picker {
    position: fixed;
    left: 50%;
    top: 50%;
    z-index: 603;
    width: min(92vw, 420px);
    transform: translate(-50%, -50%);
    background: #fff;
    border-radius: 12px;
    box-shadow: 0 12px 40px rgba(0,0,0,0.22);
    padding: 1rem;
  }

  .sample-picker-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 1rem;
    margin-bottom: 0.9rem;
  }
  .sample-picker-header h2 {
    margin: 0;
    font-size: var(--font-size-medium);
  }
  .sample-picker-close {
    border: none;
    border-radius: 4px;
    background: none;
    color: #888;
    cursor: pointer;
    font-size: var(--font-size-medium);
    line-height: 1;
    padding: 0.3rem;
  }
  .sample-picker-close:hover { background: #f0f0ec; color: #333; }

  .sample-labels {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 0.55rem;
  }
  .sample-label-pill {
    min-height: 2.4rem;
    border: none;
    border-radius: 999px;
    color: #fff;
    cursor: pointer;
    font-family: var(--font-monospace);
    font-size: var(--font-size-tiny);
    font-weight: 700;
    padding: 0.45rem 0.75rem;
    text-transform: uppercase;
  }
  .sample-label-pill:hover { filter: brightness(0.9); }
  .sample-label-pill:disabled { cursor: wait; opacity: 0.55; }
  .sample-picker-error {
    margin: 0.8rem 0 0;
    color: #c0392b;
    font-family: var(--font-tiny); font-size: var(--font-size-tiny);
  }

  .keep-in-diary-label {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    margin-top: 0.9rem;
    font-size: var(--font-size-small);
    color: #555;
    cursor: pointer;
    user-select: none;
  }
  .keep-in-diary-label input { cursor: pointer; }

  /* ── Waveform area ── */
  .waveform-area {
    display: flex;
    flex-direction: column;
    gap: 0.3rem;
  }

  .player-waveform-wrap {
    position: relative;
    width: 100%;
    height: 80px;
    border-radius: 4px;
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
  .player-waveform {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    display: block;
    cursor: pointer;
    background: transparent;
  }
  .player-waveform:focus { outline: 2px solid #4a7cdc; }

  .trim-excluded { fill: rgba(20, 24, 32, 0.48); }
  .trim-handle {
    color: #fff;
    cursor: ew-resize;
    touch-action: none;
  }
  .trim-handle line {
    stroke: currentColor;
    stroke-width: 5;
    vector-effect: non-scaling-stroke;
  }
  .trim-handle path {
    fill: #2255bb;
    stroke: #fff;
    stroke-width: 1.5;
    vector-effect: non-scaling-stroke;
  }
  .trim-handle:hover path,
  .trim-handle.dragging path { fill: #153b86; }
  .trim-handle:focus-visible { outline: none; }
  .trim-handle:focus-visible path { stroke: #ffcf5c; stroke-width: 3; }

  .trim-status {
    min-height: 1rem;
    color: #777;
    font-family: var(--font-tiny); font-size: var(--font-size-tiny);
  }
  .trim-status.error { color: #c0392b; }

  .waveform-loading {
    height: 80px;
    display: flex;
    align-items: center;
    justify-content: center;
    font-family: var(--font-tiny); font-size: var(--font-size-tiny);
    color: #aaa;
    background: #f4f6fb;
    border-radius: 4px;
  }

  .waveform-fallback {
    height: 6px;
    background: #e8e8e4;
    border-radius: 3px;
    overflow: hidden;
    margin-top: 2rem;
    margin-bottom: 1rem;
  }
  .progress-bar-fill {
    height: 100%;
    background: #4a7cdc;
    border-radius: 3px;
    transition: width 0.2s linear;
  }

  .time-display {
    display: flex;
    gap: 0.25rem;
    font-family: var(--font-tiny); font-size: var(--font-size-tiny);
    color: #888;
    font-variant-numeric: tabular-nums;
  }
  .time-sep { color: #ccc; }

  /* ── Controls ── */
  .controls {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 0.65rem;
  }

  .play-btn {
    width: 52px;
    height: 52px;
    border-radius: 50%;
    background: #1a1a1a;
    color: #fff;
    border: none;
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
    transition: background 0.15s, transform 0.1s;
  }
  .play-btn:hover   { background: #333; }
  .play-btn:active  { transform: scale(0.94); }
  .play-btn:disabled { background: #ccc; cursor: default; }

  .approver-play-btn {
    width: 32px;
    height: 32px;
    padding: 0;
    border: 1px solid #b8b8b2;
    border-radius: 50%;
    background: transparent;
    color: #777;
    font-family: var(--font-tiny);
    font-size: 9px;
    line-height: 1;
    cursor: pointer;
    opacity: 0.65;
  }
  .approver-play-btn:hover:not(:disabled),
  .approver-play-btn.active { border-color: #666; color: #333; opacity: 1; }
  .approver-play-btn:disabled { cursor: default; opacity: 0.25; }

  /* ── Volume row ── */
  .volume-row {
    display: flex;
    align-items: center;
    gap: 0.6rem;
  }

  .vol-label {
    font-family: var(--font-tiny); font-size: var(--font-size-tiny);
    font-variant-numeric: tabular-nums;
    color: #555;
    min-width: 5.5ch;
    text-align: right;
    flex-shrink: 0;
  }

  .vol-slider {
    flex: 1;
    accent-color: #1a1a1a;
    cursor: pointer;
    height: 4px;
  }

  .auto-label {
    display: flex;
    align-items: center;
    gap: 0.3rem;
    font-family: var(--font-tiny); font-size: var(--font-size-tiny);
    color: #555;
    cursor: pointer;
    flex-shrink: 0;
    user-select: none;
  }
  .auto-label input { cursor: pointer; accent-color: #1a1a1a; }

  .norm-label {
    font-family: var(--font-tiny); font-size: var(--font-size-tiny);
    font-variant-numeric: tabular-nums;
    color: #555;
    min-width: 7.5ch;
    text-align: right;
    flex-shrink: 0;
  }

  .norm-label.cutoff-lbl {
    min-width: 4ch;
    margin-left: 0.4rem;
  }

  .norm-slider {
    flex: 2;
    accent-color: #1a1a1a;
    cursor: pointer;
    height: 4px;
  }

  .norm-slider.cutoff-slider {
    flex: 1;
  }

  .norm-rows {
    display: flex;
    flex-direction: column;
    gap: 0.35rem;
    flex: 1;
  }

  .norm-row {
    display: flex;
    align-items: center;
    gap: 0.4rem;
  }

  .line-under-waveform {
    display: flex;
    justify-content:space-between;
    align-items: end;
  }
  .analysis-parameters {
    margin: 0 0 0;
    color: #888;
    font-family: var(--font-tiny); font-size: var(--font-size-tiny);
    font-variant-numeric: tabular-nums;
    overflow-wrap: anywhere;
  }

  @media (max-width: 560px) {
    .shortcut-help-dialog { padding: 0.9rem; }
    .shortcut-list > div {
      grid-template-columns: 1fr;
      gap: 0.15rem;
    }
    .shortcut-labels { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  }
</style>
