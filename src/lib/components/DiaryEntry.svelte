<script>
  import { filteredHitMetadataById as hitMetadataById, markedHitMetadataById } from '$lib/settings.js';
  import { formatDiaryEntryTitle } from '$lib/hit-metadata.js';
  import { filteredHitColor } from '$lib/report-barcode.js';
  import { recordingComment } from '$lib/recording-comments.js';
  import { diaryTrimBounds, trimHitMetadata } from '$lib/diary-trim.js';
  import { durationAreaRadius } from '$lib/diary-entry-visual.js';

  /**
   * @type {{
   *   entry: import('$lib/types').Entry;
   *   operatorAccess?: boolean;
   *   height: number;
   *   isSelected: boolean;
   *   onselect: (entry: import('$lib/types').Entry) => void;
   * }}
   */
  let { entry, height, isSelected, onselect, operatorAccess = false } = $props();

  function handleClick() {
    onselect(entry);
  }

  function handleKeydown(e) {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      onselect(entry);
    }
  }

  /**
   * Map a label string to a single base colour.
   * Rules are checked top-to-bottom; first match wins.
   * Add more cases here – just return a CSS colour string.
   *
   * @param {string} label
   * @returns {string}
   */
  function labelBase(label) {
    const l = (label ?? '').toLowerCase();

    if (l.includes('shot')) return '#51211d'; 
    if (l.includes('shooting')) return '#51211d'; 
    if (l.includes('barkattack')) return '#ff4c4c'; 
    if (l.includes('bark bark bark')) return '#ff4c4c'; 
    if (l.includes('yapattack')) return '#420f8d'; 
    if (l.includes('yap yap yap')) return '#420f8d'; 
    if (l.includes('bark bark'))      return '#d9665d'; 
    if (l.includes('yap yap'))      return '#593391'; 
    if (l.includes('bark'))           return '#b0766e'; 
    if (l.includes('yap'))           return '#726389'; 

    // ── default ──────────────────────────────────────────────────────────────
    return '#888888';
  }

  const baseColor = $derived(labelBase(entry.label));

  const displayComment = $derived(recordingComment(entry));

  // Metadata presence controls the radial hit-map. It is populated
  // asynchronously by the page-level bulk loader; resizes only redraw the
  // canvas from this cache and never initiate another request.
  const hitMetadata = $derived($hitMetadataById.get(entry.id) ?? null);
  const trimBounds = $derived(diaryTrimBounds(entry));
  const visibleHitMetadata = $derived(trimHitMetadata(hitMetadata, entry));
  const drawnHitMetadata = $derived(operatorAccess
    ? trimHitMetadata($markedHitMetadataById.get(entry.id) ?? null, entry)
    : visibleHitMetadata);
  const titleLabel = $derived(formatDiaryEntryTitle(
    { ...entry, durationSec: trimBounds.durationSec },
    visibleHitMetadata,
  ));

  // Matches the play-knob svg: left:0, top:0, 16x16, translateX(-50%).
  const KNOB_CENTER_X = 0;
  const KNOB_CENTER_Y = 8;
  const INNER_RADIUS  = 10; // play-knob radius
  const MIN_EXTRA     = 3;
  const MAX_EXTRA     = 30; // configurable — max extra reach beyond inner radius
  const MAX_DURATION  = 570; // seconds; domain end for outer-radius scaling
  const MIN_RADIUS    = INNER_RADIUS + MIN_EXTRA;
  const MAX_RADIUS    = INNER_RADIUS + MAX_EXTRA;

  const outerRadius = $derived(
    durationAreaRadius(trimBounds.durationSec, MIN_RADIUS, MAX_RADIUS, MAX_DURATION)
  );

  // Shorter clips stack on top: 1 at MAX_DURATION down to MAX_DURATION at 0s.
  // Never 0 — z-index:0 paints in the same bucket as unpositioned/z-index:auto
  // elements (e.g. other rows' track-bg), so document order could still win.
  const entryZIndex = $derived(
    Math.max(1, Math.round(MAX_DURATION - Math.max(0, Math.min(MAX_DURATION, trimBounds.durationSec))))
  );

  /** @type {HTMLCanvasElement | undefined} */
  let radialCanvas = $state();

  // Highlights the radial view while the play knob is hovered.
  let knobHovered = $state(false);

  // Above every entry's normal z-index (max MAX_DURATION) but still below popups.
  const displayZIndex = $derived(knobHovered ? MAX_DURATION + 1 : entryZIndex);

  /**
   * Continuous orange → dark-red scale driven by per-hit loudness ratio (La).
   * @param {number} loudness
   * @returns {string}
   */
  function hitColor(loudness) {
    const LO = 1, HI = 4; // typical La range seen in auto-detected clips
    const t = Math.max(0, Math.min(1, (loudness - LO) / (HI - LO)));
    const from = [255, 165, 0];   // orange
    const to   = [139, 0, 0];     // dark red
    const [r, g, b] = from.map((c, i) => Math.round(c + (to[i] - c) * t));
    return `rgb(${r}, ${g}, ${b})`;
  }

  /**
   * Confidence-driven line length, anchored at the outer radius: 1.0 spans
   * the full inner–outer distance, 0.9 (or below) collapses to a point.
   * @param {number} confidence
   * @returns {number} fraction of the inner–outer span to draw, 0..1
   */
  function hitLengthFraction(confidence) {
    const LO = 0.9, HI = 1.0;
    return Math.max(0, Math.min(1, (confidence - LO) / (HI - LO)));
  }

  // Redraw whenever the canvas mounts, hit data arrives, or the radius changes.
  $effect(() => {
    const canvas = radialCanvas;
    const radius = outerRadius;
    if (!canvas) return;

    const dpr = window.devicePixelRatio || 1;
    const MARGIN = 1; // px — keeps 1px-wide strokes from being clipped at the edge
    const size = radius * 2 + MARGIN * 2;
    canvas.width = size * dpr;
    canvas.height = size * dpr;
    canvas.style.width = `${size}px`;
    canvas.style.height = `${size}px`;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, size, size);

    const cx = radius + MARGIN, cy = radius + MARGIN;

    // Neutral fill is always visible; the outer ring only appears on hover.
    ctx.beginPath();
    ctx.arc(cx, cy, radius, 0, Math.PI * 2);
    ctx.fillStyle = knobHovered ? 'rgba(255, 255, 255, 0.9)' : 'rgba(0, 0, 0, 0.1)';
    ctx.fill();
    if (knobHovered) {
      ctx.lineWidth = 1;
      ctx.strokeStyle = '#000';
      ctx.stroke();
    }

    if (!drawnHitMetadata) return;

    const dur = trimBounds.durationSec || 1;
    ctx.lineWidth = 1;
    drawnHitMetadata.timestamps.forEach((ts, i) => {
      // 0 = vertical axis (up), increasing clockwise over the full clip duration.
      const angle = (ts / dur) * Math.PI * 2 - Math.PI / 2;
      const cos = Math.cos(angle), sin = Math.sin(angle);
      const startRadius = radius - hitLengthFraction(drawnHitMetadata.confidences[i]) * (radius - INNER_RADIUS);
      ctx.strokeStyle = drawnHitMetadata.filteredHits?.[i]
        ? filteredHitColor(drawnHitMetadata.loudnesses[i])
        : hitColor(drawnHitMetadata.loudnesses[i]);
      ctx.beginPath();
      ctx.moveTo(cx + startRadius * cos, cy + startRadius * sin);
      ctx.lineTo(cx + radius * cos, cy + radius * sin);
      ctx.stroke();
    });
  });
</script>

<!-- Flag/pin marker – visually overflows its slot -->
<!-- svelte-ignore a11y_interactive_supports_focus -->
<div
  class="flag"
  class:selected={isSelected}
  class:flag--audio={entry.kind === 'audio'}
  role="button"
  tabindex="0"
  aria-label="{entry.kind === 'audio' ? 'Audio' : 'Note'} at {entry.time}{displayComment ? `: ${displayComment}` : ''}"
  onclick={handleClick}
  onkeydown={handleKeydown}
  onmouseenter={() => (knobHovered = true)}
  onmouseleave={() => (knobHovered = false)}
  style="height: {height}px; --c-base: {baseColor}; z-index: {displayZIndex};"
  title="{entry.time}{displayComment ? `  ${displayComment}` : ''}{titleLabel ? `  ${titleLabel}` : ''}  ({entry.kind})"
>
  {#if !hitMetadata}
    <span class="flag-stem"></span>
  {/if}

  {#if hitMetadata && entry.kind === 'audio'}
    <!-- Radial hit-map, centred on the play-knob -->
    <canvas
      bind:this={radialCanvas}
      class="flag-radial"
      style="left: {KNOB_CENTER_X - outerRadius - 1}px; top: {KNOB_CENTER_Y - outerRadius - 1}px;"
    ></canvas>
  {/if}
  <span class="flag-tag">
    <span class="flag-time">{entry.time}</span>
    {#if displayComment}
      <span class="flag-label-text">{displayComment}</span>
    {/if}
  </span>
  {#if entry.kind === 'audio'}
    <!-- Play-in-circle knob for audio entries -->
    <svg class="flag-knob" width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
      <circle cx="8" cy="8" r="7.5" stroke="#fff" stroke-width="1"/>
      <polygon points="5.5,4.5 12,8 5.5,11.5" fill="#fff"/>
    </svg>
  {/if}
</div>

<style>
  /* ══ Flag / pin (all entry kinds) ════════════════════════════ */
  .flag {
    position: relative;
    /* slot width is usually 15-min minimum – let visual elements overflow */
    overflow: visible;
    width: 100%;
    cursor: pointer;
    user-select: none;
  }

  /* Vertical stem */
  .flag-stem {
    position: absolute;
    left: 0;
    top: 0;
    width: 2px;
    height: 100%;
    background: var(--c-base);
    border-radius: 1px;
    z-index: 3;
  }

  /* Circle knob – only rendered for audio (SVG play icon) */
  .flag-knob {
    position: absolute;
    left: 0;
    top: 0px;
    transform: translateX(-50%);
    pointer-events: auto; /* part of the flag's hoverable/clickable footprint */
    display: block;
    z-index: 3;
  }
  .flag-knob circle { fill: var(--c-base); }

  /* Label tag hanging to the right of the stem */
  .flag-tag {
    position: absolute;
    left: 0;
    top: 3px;
    display: flex;
    align-items: baseline;
    gap: 3px;
    white-space: nowrap;
    background: color-mix(in srgb, var(--c-base) 12%, white);
    border: 1px solid color-mix(in srgb, var(--c-base) 35%, white);
    border-left: none;
    border-radius: 0 3px 3px 0;
    padding: 1px 4px;
    pointer-events: auto; /* part of the flag's hoverable/clickable footprint */
    box-shadow: 0 1px 2px rgba(0,0,0,0.08);
    z-index: 2;
  }

  .flag-time {
    font-family: var(--font-tiny); font-size: var(--font-size-tiny);
    font-weight: 700;
    color: color-mix(in srgb, var(--c-base) 85%, black);
    line-height: 1.2;
  }

  .flag-label-text {
    font-family: var(--font-tiny); font-size: var(--font-size-tiny);
    color: color-mix(in srgb, var(--c-base) 85%, black);
    line-height: 1.2;
  }

  /* ── Audio: extra left padding so text clears the knob circle ── */
  .flag--audio .flag-tag { padding-left: 8px; }

  /* ── Radial hit-map for clips with hit metadata ── */
  .flag-radial {
    position: absolute;
    pointer-events: auto; /* part of the flag's hoverable/clickable footprint */
    z-index: 1;
  }

  /* ── Hover highlight (applies whichever part of the flag is under the cursor) ── */
  .flag:hover .flag-stem { filter: brightness(1.2); }
  .flag:hover .flag-tag  { outline: 1px solid color-mix(in srgb, var(--c-base) 55%, white); }

  /* ── Selected state ── */
  .flag.selected .flag-stem { filter: brightness(1.3); }
  .flag.selected .flag-knob circle { stroke: #4a7cdc; }
  .flag.selected .flag-tag  { outline: 2px solid #4a7cdc; outline-offset: 1px; }

  /* ── Focus ring ── */
  .flag:focus-visible .flag-knob circle { stroke: #4a7cdc; stroke-width: 2; }
  .flag:focus-visible .flag-tag  { outline: 2px solid #4a7cdc; outline-offset: 1px; }
</style>
