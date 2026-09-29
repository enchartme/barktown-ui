<script module>
  import { TRAINING_COLOR_ENCODINGS } from '$lib/training-color-guides.js';
  import {
    loadTrainingProjectionPoints as loadProjectionPoints,
    projectionPreviewSource as previewSource,
    trainingAssetUrl as assetUrl,
  } from '$lib/training-projection-data.js';

  const GRID_SIZE = 12;
  const HIT_RADIUS = 8;
  const POINT_RADIUS = 2;
  const VIRIDIS_STOPS = [
    [68, 1, 84],
    [59, 82, 139],
    [33, 145, 140],
    [94, 201, 98],
    [253, 231, 37],
  ];
  const VIRIDIS_LUT = Array.from({ length: 256 }, (_, index) => {
    const t = index / 255;
    const scaled = t * (VIRIDIS_STOPS.length - 1);
    const left = Math.min(VIRIDIS_STOPS.length - 2, Math.floor(scaled));
    const mix = scaled - left;
    const a = VIRIDIS_STOPS[left];
    const b = VIRIDIS_STOPS[left + 1];
    const channel = (i) => Math.round(a[i] + (b[i] - a[i]) * mix);
    return `rgb(${channel(0)}, ${channel(1)}, ${channel(2)})`;
  });

</script>

<script>
  import { onMount } from 'svelte';
  import { sampleLabelColor } from '$lib/sample-labels.js';

  /** @type {{ samples?: any[], activeLabel?: string|null, activeSampleId?: string|null, colorEncoding?: string, onopen?: (point: any) => Promise<string | void> | string | void, onwindowsummary?: (summary: { counts: Map<string, number>, durationBins: Map<string, number[]>, colorDomains: Map<string, { min: number, max: number }> }) => void }} */
  let { samples = [], activeLabel = null, activeSampleId = null, colorEncoding = $bindable('label'), onopen = () => {}, onwindowsummary = () => {} } = $props();

  /** @type {HTMLCanvasElement | null} */
  let canvas = $state(null);
  /** @type {HTMLDivElement | null} */
  let plotWrap = $state(null);
  /** @type {any[]} */
  let points = $state([]);
  let loading = $state(true);
  let error = $state('');
  let interactionError = $state('');
  /** @type {any | null} */
  let hovered = $state(null);
  let projection = $state('umap');
  let shortWindowsOnly = $state(false);
  let tooltipX = $state(0);
  let tooltipY = $state(0);
  let plotWidth = 0;
  let plotHeight = 0;

  /** @type {Map<string, any[]>} */
  let hitGrid = new Map();
  /** @type {HTMLAudioElement | null} */
  let previewAudio = null;
  /** @type {ReturnType<typeof setTimeout> | null} */
  let previewDelay = null;
  /** @type {ReturnType<typeof setTimeout> | null} */
  let previewStop = null;
  let previewToken = 0;

  const sampleAudioById = $derived.by(() => new Map(
    samples.map((sample) => [sample.id, sample.audioPath]),
  ));
  const activeSampleAudioPath = $derived(
    activeSampleId ? (sampleAudioById.get(activeSampleId) ?? null) : null
  );
  const numericColorDomain = $derived.by(() => {
    if (colorEncoding === 'label') return null;
    let min = Infinity;
    let max = -Infinity;
    for (const point of points) {
      const value = point[colorEncoding];
      if (!Number.isFinite(value)) continue;
      if (value < min) min = value;
      if (value > max) max = value;
    }
    return Number.isFinite(min) ? { min, max } : null;
  });
  const selectedEncodingLabel = $derived(
    TRAINING_COLOR_ENCODINGS.find((encoding) => encoding.value === colorEncoding)?.label ?? 'Label'
  );
  $effect(() => {
    const node = plotWrap;
    if (!node) return;
    const observer = new ResizeObserver(draw);
    observer.observe(node);
    requestAnimationFrame(draw);
    return () => observer.disconnect();
  });

  $effect(() => {
    // Redraw only when the hovered identity changes; pointer movement within
    // the same dot merely repositions the HTML tooltip. Table-row focus also
    // redraws without changing the projection domain or point positions.
    const hoverId = hovered?.embeddingId;
    const filterLabel = activeLabel;
    const filterSampleId = activeSampleId;
    const selectedProjection = projection;
    const encoding = colorEncoding;
    const colorDomain = numericColorDomain;
    const focusShortWindows = shortWindowsOnly;
    if (!plotWrap || !points.length) return;
    const frame = requestAnimationFrame(() => {
      void hoverId;
      void filterLabel;
      void filterSampleId;
      void selectedProjection;
      void encoding;
      void colorDomain;
      void focusShortWindows;
      draw();
    });
    return () => cancelAnimationFrame(frame);
  });

  function stopPreview() {
    previewToken++;
    if (previewDelay) clearTimeout(previewDelay);
    if (previewStop) clearTimeout(previewStop);
    previewDelay = null;
    previewStop = null;
    if (previewAudio) previewAudio.pause();
  }

  function schedulePreview(point) {
    stopPreview();
    if (!point?.sourceFragment) return;
    const token = previewToken;
    previewDelay = setTimeout(() => playPreview(point, token), 120);
  }

  function playPreview(point, token) {
    if (!previewAudio || token !== previewToken || hovered?.embeddingId !== point.embeddingId) return;
    const audioPath = point.originalAudio || sampleAudioById.get(point.originalRecording);
    const preview = previewSource(point, audioPath);
    if (!preview || !Number.isFinite(preview.start) || !Number.isFinite(preview.end)) return;
    const src = assetUrl(preview.path);

    const seekAndPlay = async () => {
      if (!previewAudio || token !== previewToken || hovered?.embeddingId !== point.embeddingId) return;
      const start = Math.max(0, preview.start);
      const end = Math.max(start, preview.end);
      previewAudio.currentTime = Math.min(start, previewAudio.duration || start);
      try {
        await previewAudio.play();
        previewStop = setTimeout(() => {
          if (token === previewToken) previewAudio?.pause();
        }, Math.max(80, (end - start) * 1000));
      } catch {
        // Browsers can require one click before allowing hover-initiated audio.
      }
    };

    if (previewAudio.src !== src) {
      previewAudio.src = src;
      previewAudio.addEventListener('loadedmetadata', seekAndPlay, { once: true });
      previewAudio.load();
    } else if (previewAudio.readyState >= 1) {
      seekAndPlay();
    } else {
      previewAudio.addEventListener('loadedmetadata', seekAndPlay, { once: true });
    }
  }

  function gridKey(x, y) {
    return `${Math.floor(x / GRID_SIZE)},${Math.floor(y / GRID_SIZE)}`;
  }

  function pointColor(point) {
    if (colorEncoding === 'label') return sampleLabelColor(point.label);
    const value = point[colorEncoding];
    if (!Number.isFinite(value) || !numericColorDomain) return '#c8c8c2';
    const span = numericColorDomain.max - numericColorDomain.min;
    const t = span > 0 ? (value - numericColorDomain.min) / span : 0.5;
    return VIRIDIS_LUT[Math.max(0, Math.min(255, Math.round(t * 255)))];
  }

  function pointMatchesActiveSample(point) {
    if (!activeSampleId) return true;
    return point.originalRecording === activeSampleId
      || Boolean(activeSampleAudioPath && point.originalAudio === activeSampleAudioPath);
  }

  function pointMatchesSelection(point) {
    return (!activeLabel || point.label === activeLabel)
      && (!shortWindowsOnly || (Number.isFinite(point.windowDuration) && point.windowDuration < 0.9))
      && pointMatchesActiveSample(point);
  }

  function pointOpacity(point) {
    let opacity = 1;
    if (activeLabel && point.label !== activeLabel) opacity *= 0.1;
    if (shortWindowsOnly && (!Number.isFinite(point.windowDuration) || point.windowDuration >= 0.9)) opacity *= 0.16;
    if (!pointMatchesActiveSample(point)) opacity *= 0.1;
    return Math.max(0.02, opacity);
  }

  function selectProjection(nextProjection) {
    if (projection === nextProjection) return;
    hovered = null;
    stopPreview();
    projection = nextProjection;
  }

  function draw() {
    if (!canvas || !plotWrap || !points.length) return;
    const rect = plotWrap.getBoundingClientRect();
    plotWidth = Math.max(1, rect.width);
    plotHeight = Math.max(1, rect.height);
    const dpr = Math.max(1, window.devicePixelRatio || 1);
    canvas.width = Math.round(plotWidth * dpr);
    canvas.height = Math.round(plotHeight * dpr);
    canvas.style.width = `${plotWidth}px`;
    canvas.style.height = `${plotHeight}px`;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, plotWidth, plotHeight);

    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    const xField = projection === 'pca' ? 'pcaX' : 'umapX';
    const yField = projection === 'pca' ? 'pcaY' : 'umapY';
    for (const point of points) {
      if (point[xField] < minX) minX = point[xField];
      if (point[xField] > maxX) maxX = point[xField];
      if (point[yField] < minY) minY = point[yField];
      if (point[yField] > maxY) maxY = point[yField];
    }
    const xPad = Math.max((maxX - minX) * 0.025, 0.01);
    const yPad = Math.max((maxY - minY) * 0.025, 0.01);
    minX -= xPad; maxX += xPad; minY -= yPad; maxY += yPad;
    const innerPad = 8;
    const innerW = Math.max(1, plotWidth - innerPad * 2);
    const innerH = Math.max(1, plotHeight - innerPad * 2);

    hitGrid = new Map();
    for (const point of points) {
      const sx = innerPad + ((point[xField] - minX) / (maxX - minX || 1)) * innerW;
      const sy = innerPad + (1 - (point[yField] - minY) / (maxY - minY || 1)) * innerH;
      point.sx = sx;
      point.sy = sy;
      const key = gridKey(sx, sy);
      const bucket = hitGrid.get(key) ?? [];
      bucket.push(point);
      hitGrid.set(key, bucket);

      ctx.beginPath();
      ctx.arc(sx, sy, POINT_RADIUS, 0, Math.PI * 2);
      ctx.fillStyle = pointColor(point);
      ctx.globalAlpha = pointOpacity(point);
      ctx.fill();
    }
    ctx.globalAlpha = 1;

    if (hovered) {
      // Paint the active dot again, last, so it rises above dense neighbours.
      ctx.beginPath();
      ctx.arc(hovered.sx, hovered.sy, 7, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(255, 255, 255, 0.9)';
      ctx.fill();
      ctx.beginPath();
      ctx.arc(hovered.sx, hovered.sy, 5, 0, Math.PI * 2);
      ctx.fillStyle = pointColor(hovered);
      ctx.globalAlpha = pointOpacity(hovered);
      ctx.fill();
      ctx.globalAlpha = 1;
    }
  }

  function metric(value, digits = 3) {
    return Number.isFinite(value) ? value.toFixed(digits) : '—';
  }

  function percentage(value) {
    return Number.isFinite(value) ? `${Math.round(value * 100)}%` : '—';
  }

  function nearestPoint(x, y) {
    const gx = Math.floor(x / GRID_SIZE);
    const gy = Math.floor(y / GRID_SIZE);
    let nearest = null;
    let nearestDistanceSq = HIT_RADIUS * HIT_RADIUS;
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        for (const point of hitGrid.get(`${gx + dx},${gy + dy}`) ?? []) {
          if (!pointMatchesSelection(point)) continue;
          const distanceSq = (point.sx - x) ** 2 + (point.sy - y) ** 2;
          if (distanceSq <= nearestDistanceSq) {
            nearest = point;
            nearestDistanceSq = distanceSq;
          }
        }
      }
    }
    return nearest;
  }

  function pointerPosition(event) {
    const rect = canvas.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  }

  function handlePointerMove(event) {
    if (!canvas) return;
    const { x, y } = pointerPosition(event);
    const next = nearestPoint(x, y);
    tooltipX = Math.min(Math.max(8, x + 12), Math.max(8, plotWidth - 304));
    tooltipY = Math.min(Math.max(8, y + 12), Math.max(8, plotHeight - 180));
    if (next?.embeddingId === hovered?.embeddingId) return;
    hovered = next;
    interactionError = '';
    if (next) schedulePreview(next);
    else stopPreview();
  }

  function handlePointerLeave() {
    hovered = null;
    stopPreview();
  }

  async function handleClick(event) {
    if (!canvas) return;
    const { x, y } = pointerPosition(event);
    const point = nearestPoint(x, y);
    if (!point) return;
    stopPreview();
    const result = await onopen(point);
    if (typeof result === 'string') interactionError = result;
  }

  onMount(() => {
    previewAudio = new Audio();
    previewAudio.preload = 'metadata';

    loadProjectionPoints()
      .then((loaded) => {
        points = loaded;
        const counts = new Map();
        const durationBins = new Map();
        for (const point of loaded) {
          counts.set(point.label, (counts.get(point.label) ?? 0) + 1);
          if (!Number.isFinite(point.windowDuration)) continue;
          const bins = durationBins.get(point.label) ?? new Array(11).fill(0);
          // 0–100ms through 900–1000ms, then an overflow bin for >1000ms.
          const bin = point.windowDuration > 1
            ? 10
            : Math.min(9, Math.max(0, Math.floor(point.windowDuration / 0.1)));
          bins[bin]++;
          durationBins.set(point.label, bins);
        }
        const colorDomains = new Map();
        for (const encoding of TRAINING_COLOR_ENCODINGS) {
          if (encoding.value === 'label') continue;
          let min = Infinity;
          let max = -Infinity;
          for (const point of loaded) {
            const value = point[encoding.value];
            if (!Number.isFinite(value)) continue;
            if (value < min) min = value;
            if (value > max) max = value;
          }
          if (Number.isFinite(min)) colorDomains.set(encoding.value, { min, max });
        }
        onwindowsummary({ counts, durationBins, colorDomains });
        loading = false;
        requestAnimationFrame(draw);
      })
      .catch((cause) => {
        error = cause?.message ?? 'Failed to load projection CSV.';
        loading = false;
      });

    return () => {
      stopPreview();
      if (previewAudio) {
        previewAudio.removeAttribute('src');
        previewAudio.load();
      }
      previewAudio = null;
    };
  });
</script>

<section class="projection" aria-label={`${projection.toUpperCase()} embedding projection`}>
  <div class="projection-heading">
    <div class="projection-copy">
      <div class="projection-switch" role="group" aria-label="Projection">
        <button class:active={projection === 'pca'} aria-pressed={projection === 'pca'} onclick={() => selectProjection('pca')}>PCA</button>
        <button class:active={projection === 'umap'} aria-pressed={projection === 'umap'} onclick={() => selectProjection('umap')}>UMAP</button>
      </div>
      <p>projection of the training data. Each dot is one window of audio (explanation below). Hover a dot to hear the sound; click to open the recorded sample.</p>
    </div>
    {#if points.length}<span class="point-count">{points.length.toLocaleString()} windows</span>{/if}
  </div>

  {#if loading}
    <div class="plot-message">Loading projection…</div>
  {:else if error}
    <div class="plot-message plot-error">Could not load the projection: {error}</div>
  {:else}
    <div class="plot-wrap" bind:this={plotWrap}>
      <!-- svelte-ignore a11y_no_interactive_element_to_noninteractive_role -->
      <canvas
        bind:this={canvas}
        onpointermove={handlePointerMove}
        onpointerleave={handlePointerLeave}
        onclick={handleClick}
        role="img"
        aria-label={`${projection.toUpperCase()} scatterplot with ${points.length} embedding windows, coloured by ${selectedEncodingLabel.toLowerCase()}`}
      ></canvas>
      <div class="plot-controls-overlay">
        <label class="duration-control">
          <input type="checkbox" bind:checked={shortWindowsOnly} />
          <span>Short windows only</span>
        </label>
      </div>
      {#if hovered}
        <div class="plot-tooltip" style:left={`${tooltipX}px`} style:top={`${tooltipY}px`}>
          <span class="tooltip-label" style:background={sampleLabelColor(hovered.label)}>{hovered.label}</span>
          <strong>{hovered.originalRecording}</strong>
          <span>{metric(hovered.recordingStart, 2)}–{metric(hovered.recordingEnd, 2)} s in parent</span>
          <span>{metric(hovered.windowDuration, 2)} s window</span>
          <div class="quality-grid">
            <span class="quality-title">Quality criteria</span>
            <span><small>Split</small><b>{hovered.trainOrValidation || '—'}</b></span>
            <span><small>Classifier score</small><b>{metric(hovered.classifierScore)}</b></span>
            <span><small>Classifier error</small><b>{metric(hovered.classifierError)}</b></span>
            <span><small>KNN label mismatch</small><b>{percentage(hovered.knnLabelDisagreement)}</b></span>
            <span><small>KNN binary mismatch</small><b>{percentage(hovered.knnBinaryDisagreement)}</b></span>
            <span><small>KNN mean distance</small><b>{metric(hovered.knnMeanDistance, 4)}</b></span>
            <span><small>Centroid distance</small><b>{metric(hovered.labelCentroidDistance, 4)}</b></span>
            <span><small>Nearest distance</small><b>{metric(hovered.nearestDistance, 4)}</b></span>
            <span><small>Suspicion score</small><b>{metric(hovered.suspicionScore)}</b></span>
            <span><small>Suspicion rank</small><b>{Number.isFinite(hovered.suspicionRank) ? `#${hovered.suspicionRank}` : '—'}</b></span>
          </div>
        </div>
      {/if}
    </div>

    {#if interactionError}<div class="plot-message plot-error">{interactionError}</div>{/if}
  {/if}
</section>

<style>
  .projection {
    margin-top: 0.75rem;
  }
  .projection-heading {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 1rem;
    margin-bottom: 0.7rem;
  }
  .projection-heading p { margin: 0; color: #777; font-family: var(--font-tiny); font-size: var(--font-size-tiny); line-height: 1.45; }
  .projection-copy { display: flex; align-items: center; gap: 0.45rem; min-width: 0; }
  .projection-switch {
    display: inline-flex;
    flex-shrink: 0;
    padding: 2px;
    border: 1px solid #d0d0ca;
    border-radius: 5px;
    background: #efefeb;
  }
  .projection-switch button {
    padding: 0.18rem 0.42rem;
    border: 0;
    border-radius: 3px;
    background: transparent;
    color: #777;
    font: inherit;
    font-family: var(--font-tiny); font-size: var(--font-size-tiny);
    font-weight: 700;
    cursor: pointer;
  }
  .projection-switch button:hover { color: #222; }
  .projection-switch button.active { background: #fff; color: #1a1a1a; box-shadow: 0 1px 3px rgba(0, 0, 0, 0.12); }
  .projection-switch button:focus-visible { outline: 2px solid rgba(74, 124, 220, 0.35); outline-offset: 1px; }
  .point-count { color: #999; font-family: var(--font-tiny); font-size: var(--font-size-tiny); white-space: nowrap; padding-top: 0.15rem; }
  .plot-controls-overlay {
    position: absolute;
    z-index: 3;
    top: 8px;
    right: 8px;
    display: flex;
    align-items: center;
    justify-content: flex-end;
    flex-wrap: wrap;
    gap: 0.55rem;
    max-width: calc(100% - 16px);
    padding: 0.35rem 0.45rem;
    border: 1px solid rgba(0, 0, 0, 0.13);
    border-radius: 5px;
    background: rgba(255, 255, 255, 0.92);
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.08);
  }
  .duration-control {
    display: inline-flex;
    align-items: center;
    gap: 0.35rem;
    color: #666;
    font-family: var(--font-tiny); font-size: var(--font-size-tiny);
    white-space: nowrap;
    cursor: pointer;
  }
  .duration-control input { margin: 0; accent-color: #555; cursor: pointer; }
  .plot-wrap {
    position: relative;
    width: 100%;
    height: clamp(360px, 58vh, 620px);
    overflow: hidden;
    border: 1px solid #deded8;
    border-radius: 6px;
    background: #fff;
  }
  canvas {
    display: block;
    cursor: crosshair;
    touch-action: manipulation;
  }
  .plot-tooltip {
    position: absolute;
    z-index: 2;
    width: 292px;
    display: flex;
    flex-direction: column;
    gap: 0.22rem;
    padding: 0.5rem 0.6rem;
    border: 1px solid rgba(0, 0, 0, 0.16);
    border-radius: 5px;
    background: rgba(255, 255, 255, 0.96);
    box-shadow: 0 4px 16px rgba(0, 0, 0, 0.12);
    pointer-events: none;
    font-family: var(--font-tiny); font-size: var(--font-size-tiny);
  }
  .plot-tooltip strong { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-family: var(--font-tiny); font-size: var(--font-size-tiny); }
  .tooltip-label {
    align-self: flex-start;
    padding: 0.08rem 0.38rem;
    border-radius: 8px;
    color: #fff;
    font-family: var(--font-monospace);
    font-weight: 700;
    text-transform: uppercase;
    font-size: var(--font-size-tiny);
  }
  .quality-grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 0.3rem 0.65rem;
    margin-top: 0.25rem;
    padding-top: 0.4rem;
    border-top: 1px solid #e8e8e3;
  }
  .quality-grid span { display: flex; align-items: baseline; justify-content: space-between; gap: 0.35rem; min-width: 0; }
  .quality-grid .quality-title {
    grid-column: 1 / -1;
    display: block;
    color: #777;
    font-family: var(--font-tiny); font-size: var(--font-size-tiny);
    font-weight: 700;
    text-transform: uppercase;
  }
  .quality-grid small { color: #888; font-family: var(--font-tiny); font-size: var(--font-size-tiny); white-space: nowrap; }
  .quality-grid b { font-family: var(--font-tiny); font-size: var(--font-size-tiny); font-variant-numeric: tabular-nums; white-space: nowrap; }
  .plot-message {
    min-height: 180px;
    display: grid;
    place-items: center;
    border: 1px solid #e0e0dc;
    border-radius: 6px;
    color: #999;
    background: #fff;
    font-family: var(--font-tiny); font-size: var(--font-size-tiny);
  }
  .plot-error { color: #c0392b; min-height: auto; padding: 0.8rem; margin-top: 0.6rem; }

  @media (max-width: 760px) {
    .projection-heading { flex-direction: column; gap: 0.25rem; }
    .projection-copy { align-items: flex-start; }
    .plot-wrap { height: 420px; }
  }
</style>
