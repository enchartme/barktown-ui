<script>
  import { env } from '$env/dynamic/public';
  import { onMount, onDestroy } from 'svelte';
  import { goblinHostLabel, resolveGoblinBaseUrl } from '$lib/goblin-config.js';
  import { PRIVATE_API_BASE, PUBLIC_API_BASE, formatDuration, formatSampleDatetime } from '$lib/utils.js';
  import { SAMPLE_LABELS as LABELS, sampleLabelColor } from '$lib/sample-labels.js';
  import {
    fetchMonitorParams,
    monitorParamValuesMatch,
    parseMonitorParamInput,
    saveMonitorParamAndRefresh,
  } from '$lib/monitor-params.js';

  const BASE_URL       = resolveGoblinBaseUrl(env.PUBLIC_GOBLIN_BASE_URL);
  const HOSTNAME       = new URL(BASE_URL).hostname;
  const HOST_LABEL     = goblinHostLabel(BASE_URL);
  const STATUS_URL     = `${BASE_URL}/status`;
  const SAMPLES_URL    = `${PUBLIC_API_BASE}/api/samples`;
  const POLL_OPEN_MS   = 1_000;
  const POLL_CLOSED_MS = 10_000;
  const RECENT_SAMPLES_COUNT = 5;

  /** @type {any} */
  let status      = $state(null);
  let fetchFailed = $state(false);
  let showPopup   = $state(false);
  let activeTab   = $state('monitor');
  let intervalId;

  // ── Manual tab state ──────────────────────────────────────────────────────
  let recordDuration  = $state(15);
  /** @type {any} */
  let recordStatus    = $state(null);
  let selectedLabel   = $state('');
  let recordMessage   = $state('');
  let confirmAction   = $state(/** @type {'reboot'|'halt'|null} */ (null));
  let showShutdownControl = $state(false);
  let controlMessage  = $state('');
  let recordPollId;
  let controlBusy     = $state(false);

  // ── Monitor control state ─────────────────────────────────────────────────
  // bark-monitor.service and the on-demand recorder above both need
  // exclusive access to the same USB mic, so only one can run at a time.
  let monitorBusy     = $state(false);
  let monitorMessage  = $state('');
  const monitorActive = $derived(status?.monitor?.service_active ?? null);

  // SQLite is authoritative; status.monitor.params.values is the monitor's
  // independently reported in-memory state, used here to verify application.
  /** @type {any[]} */
  let dbMonitorParams       = $state([]);
  /** @type {Record<string, string>} */
  let monitorParamDrafts    = $state({});
  /** @type {Record<string, boolean>} */
  let monitorParamSaving    = $state({});
  /** @type {Record<string, {kind: 'success'|'error', text: string}>} */
  let monitorParamMessages  = $state({});
  let monitorParamsLoading  = $state(false);
  let monitorParamsError    = $state('');
  const appliedMonitorParamValues = $derived(status?.monitor?.params?.values ?? {});
  const pipelineStatus = $derived(status?.pipeline ?? {});
  const assemblerState = $derived(pipelineStatus?.assembler_state ?? 'UNKNOWN');
  const detectionStatus = $derived(pipelineStatus?.detection ?? {});
  const assemblyStatus = $derived(pipelineStatus?.assembly ?? {});
  const uploadStatus = $derived(pipelineStatus?.upload ?? {});
  const maxScore10s = $derived(
    detectionStatus?.max_score_10s ?? pipelineStatus?.max_score_10s ?? null
  );
  const detectionActive = $derived(
    assemblerState === 'IDLE' || assemblerState === 'ACTIVE_CANDIDATE'
  );
  const detectionEngaged = $derived(
    pipelineStatus?.state === 'monitoring' && detectionActive
  );
  const confirmedHits = $derived(detectionStatus?.confirmed_hits ?? 0);
  const confirmationHits = $derived(
    detectionStatus?.confirmation_hits ?? appliedMonitorParamValues?.confirmation_hits ?? 0
  );
  const confirmationWindow = $derived(
    detectionStatus?.confirmation_window_s ?? appliedMonitorParamValues?.confirmation_window_s ?? 0
  );
  const confirmationRemaining = $derived(
    detectionStatus?.confirmation_window_remaining_s ?? 0
  );
  const assemblyActive = $derived(assemblerState === 'ACTIVE_CONFIRMED');
  const assemblyEngaged = $derived(
    pipelineStatus?.state === 'monitoring' && assemblyActive
  );
  const clipElapsed = $derived(assemblyStatus?.clip_elapsed_s ?? 0);
  const maxClip = $derived(
    assemblyStatus?.max_clip_s ?? appliedMonitorParamValues?.max_clip_s ?? 0
  );
  const silenceElapsed = $derived(assemblyStatus?.silence_elapsed_s ?? 0);
  const silenceGap = $derived(
    assemblyStatus?.silence_gap_s ?? appliedMonitorParamValues?.silence_gap_s ?? 0
  );
  const audioUploadStatus = $derived(uploadStatus?.audio_clip ?? {});
  const metadataUploadStatus = $derived(uploadStatus?.hit_metadata ?? {});
  const uploadEngaged = $derived(
    ['queued', 'encoding', 'uploading', 'retrying', 'pending', 'waiting'].includes(
      audioUploadStatus?.state
    ) || ['uploading', 'pending', 'waiting'].includes(metadataUploadStatus?.state)
  );
  const uploadsFailed24h = $derived(
    uploadStatus?.uploads_failed_24h ?? status?.counts_24h?.uploads_failed ?? 0
  );
  const uploadsRetried24h = $derived(
    uploadStatus?.uploads_retried_24h ?? status?.counts_24h?.uploads_retried ?? 0
  );

  // ── Recent recordings (shown at the end of the Manual tab's record section) ─
  /** @type {any[]} */
  let samples         = $state([]);
  let samplesLoading  = $state(false);
  let samplesError    = $state('');

  const recentSamples = $derived(samples.slice(0, RECENT_SAMPLES_COUNT));

  async function fetchSamples() {
    samplesLoading = true;
    samplesError   = '';
    try {
      const res = await fetch(SAMPLES_URL, { signal: AbortSignal.timeout(8000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      // Sort newest first
      samples = [...data].sort((a, b) => b.datetimeLocal.localeCompare(a.datetimeLocal));
    } catch (e) {
      samplesError = e?.message ?? 'Failed to load';
    } finally {
      samplesLoading = false;
    }
  }

  async function fetchStatus() {
    try {
      const res = await fetch(STATUS_URL, { signal: AbortSignal.timeout(5000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      status      = await res.json();
      fetchFailed = false;
    } catch (_e) {
      fetchFailed = true;
      status      = null;
    }
  }

  async function loadMonitorParams() {
    monitorParamsLoading = true;
    monitorParamsError = '';
    try {
      const rows = await fetchMonitorParams(PRIVATE_API_BASE, {
        signal: AbortSignal.timeout(8000),
      });
      dbMonitorParams = rows;
      monitorParamDrafts = Object.fromEntries(
        rows.map((row) => [row.paramId, String(row.currentValue)])
      );
    } catch (e) {
      monitorParamsError = e?.message ?? 'Failed to load monitor parameters';
    } finally {
      monitorParamsLoading = false;
    }
  }

  function replaceMonitorParamRow(updatedRow) {
    dbMonitorParams = dbMonitorParams.map((row) =>
      row.paramId === updatedRow.paramId ? updatedRow : row
    );
    monitorParamDrafts = {
      ...monitorParamDrafts,
      [updatedRow.paramId]: String(updatedRow.currentValue),
    };
  }

  function setMonitorParamMessage(paramId, kind, text) {
    monitorParamMessages = {
      ...monitorParamMessages,
      [paramId]: { kind, text },
    };
  }

  function setAppliedMonitorParams(params) {
    if (!status) return;
    status = {
      ...status,
      monitor: {
        ...status.monitor,
        params,
      },
    };
  }

  function monitorParamHasChanged(row) {
    const draft = monitorParamDrafts[row.paramId];
    if (draft == null) return false;
    const parsed = parseMonitorParamInput(row, draft);
    if (parsed.error) return String(draft).trim() !== String(row.currentValue);
    return !monitorParamValuesMatch(row.currentValue, parsed.value);
  }

  async function saveMonitorParam(row) {
    const paramId = row.paramId;
    if (monitorParamSaving[paramId] || !monitorParamHasChanged(row)) return;

    const parsed = parseMonitorParamInput(row, monitorParamDrafts[paramId]);
    if (parsed.error) {
      setMonitorParamMessage(paramId, 'error', parsed.error);
      return;
    }

    monitorParamSaving = { ...monitorParamSaving, [paramId]: true };
    const { [paramId]: _oldMessage, ...otherMessages } = monitorParamMessages;
    monitorParamMessages = otherMessages;

    try {
      const { updatedRow, goblinParams } = await saveMonitorParamAndRefresh({
        apiBase: PRIVATE_API_BASE,
        goblinBase: BASE_URL,
        paramId,
        value: parsed.value,
        patchSignal: AbortSignal.timeout(8000),
        refreshSignal: AbortSignal.timeout(12000),
      });
      replaceMonitorParamRow(updatedRow);
      setAppliedMonitorParams(goblinParams);
      setMonitorParamMessage(paramId, 'success', 'Saved and applied');
    } catch (e) {
      // The PATCH can succeed while the monitor refresh fails. Preserve the
      // new DB row so the UI immediately exposes that mismatch.
      if (e?.updatedRow) replaceMonitorParamRow(e.updatedRow);
      setMonitorParamMessage(
        paramId,
        'error',
        e?.updatedRow
          ? `Saved in DB; Goblin did not apply it: ${e?.message ?? 'refresh failed'}`
          : (e?.message ?? 'Save failed')
      );
      await Promise.allSettled([loadMonitorParams(), fetchStatus()]);
    } finally {
      monitorParamSaving = { ...monitorParamSaving, [paramId]: false };
    }
  }

  function handleMonitorParamKeydown(e, row) {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    saveMonitorParam(row);
  }

  function restartInterval(ms) {
    clearInterval(intervalId);
    intervalId = setInterval(fetchStatus, ms);
  }

  onMount(() => {
    fetchStatus();
    intervalId = setInterval(fetchStatus, POLL_CLOSED_MS);
  });
  onDestroy(() => {
    clearInterval(intervalId);
    clearInterval(recordPollId);
  });

  $effect(() => {
    restartInterval(showPopup ? POLL_OPEN_MS : POLL_CLOSED_MS);
  });

  $effect(() => {
    if (showPopup && activeTab === 'monitor') loadMonitorParams();
  });

  $effect(() => {
    clearInterval(recordPollId);
    if (showPopup && activeTab === 'manual') {
      fetchRecordStatus();
      recordPollId = setInterval(fetchRecordStatus, 1500);
      if (samples.length === 0 && !samplesLoading) fetchSamples();
    }
  });

  // ── Dot state ──────────────────────────────────────────────────────────────

  function isRecentInference(s) {
    if (!s?.pipeline?.last_inference_ts) return false;
    return (Date.now() - new Date(s.pipeline.last_inference_ts).getTime()) < 10_000;
  }

  // vcgencmd get_throttled bitmask decoder
  const THROTTLE_BITS = [
    [0x1,     'Under-voltage now'],
    [0x2,     'Freq capped now'],
    [0x4,     'Throttled now'],
    [0x8,     'Soft temp limit now'],
    [0x10000, 'Under-voltage since boot'],
    [0x20000, 'Freq capped since boot'],
    [0x40000, 'Throttled since boot'],
    [0x80000, 'Soft temp limit since boot'],
  ];
  const THROTTLE_NOW_MASK = 0xf; // any of bits 0–3 = active problem right now

  function fmtThrottled(v) {
    if (v == null) return '—';
    const n = typeof v === 'string' ? parseInt(v, 16) : Number(v);
    if (isNaN(n) || n === 0) return 'none';
    return THROTTLE_BITS.filter(([bit]) => n & bit).map(([, label]) => label).join('\n');
  }

  function hasDanger(s) {
    if (!s) return false;
    return (
      (s.cpu?.percent_1s > 80) ||
      (s.cpu?.temp_c > 75) ||
      (s.disk?.sd_free_mb != null && s.disk.sd_free_mb < 500) ||
      (s.ram?.used_mb > 800)
    );
  }

  const dotState = $derived(
    (fetchFailed || !status)                    ? 'unavailable' :
    (!status.alive || !status.audio?.streaming) ? 'inactive'    :
    isRecentInference(status)                   ? 'red'         :
    hasDanger(status)                           ? 'orange'      :
                                                  'green'
  );

  const DOT_TITLES = {
    unavailable: `${HOST_LABEL} — unreachable (not on tailnet?)`,
    inactive:    `${HOST_LABEL} — alive but audio stream is off`,
    red:         `${HOST_LABEL} — inference active right now`,
    orange:      `${HOST_LABEL} — hardware warning (CPU / RAM / disk)`,
    green:       `${HOST_LABEL} — all good`,
  };

  // ── Threshold helpers ──────────────────────────────────────────────────────

  function levelBg(level) {
    return {
      ok:       '#c8f7c5',
      low:      '#fff9c4',
      high:     '#ffe0b2',
      way_high: '#ffcdd2',
      way_low:  '#e8daef',
    }[level] ?? '';
  }

  function levelLabel(level) {
    return { ok: '', low: 'low', high: 'high', way_high: 'danger', way_low: 'very low' }[level] ?? '';
  }

  function boolLevel(v)  { return v ? 'ok' : 'way_high'; }

  function rangeLevel(v, ranges) {
    for (const r of ranges) if (v < r.max) return r.level;
    return ranges.at(-1).level;
  }

  function getLevel(path, value) {
    if (value == null) return 'neutral';
    switch (path) {
      case 'alive':
      case 'audio.streaming':
      case 'audio.usb_mic_present':
      case 'net.online':
      case 'net.masmopi_ok':
        return boolLevel(value);

      case 'audio.rms_now':
        return rangeLevel(value, [
          {max:0.003,level:'way_low'},{max:0.01,level:'low'},{max:0.08,level:'ok'},
          {max:0.2,level:'high'},{max:Infinity,level:'way_high'}]);
      case 'audio.rms_mean_10s':
        return rangeLevel(value, [
          {max:0.002,level:'way_low'},{max:0.008,level:'low'},{max:0.05,level:'ok'},
          {max:0.12,level:'high'},{max:Infinity,level:'way_high'}]);
      case 'audio.rms_dbfs_now':
        return rangeLevel(value, [
          {max:-50,level:'way_low'},{max:-35,level:'low'},{max:-18,level:'ok'},
          {max:-10,level:'high'},{max:Infinity,level:'way_high'}]);
      case 'audio.rms_dbfs_mean_10s':
        return rangeLevel(value, [
          {max:-55,level:'way_low'},{max:-40,level:'low'},{max:-22,level:'ok'},
          {max:-14,level:'high'},{max:Infinity,level:'way_high'}]);
      case 'audio.peak_now':
        return rangeLevel(value, [
          {max:0.02,level:'way_low'},{max:0.08,level:'low'},{max:0.5,level:'ok'},
          {max:0.85,level:'high'},{max:Infinity,level:'way_high'}]);
      case 'audio.clip_rate_10s':
        return rangeLevel(value, [
          {max:0.00001,level:'ok'},{max:0.001,level:'high'},{max:Infinity,level:'way_high'}]);
      case 'audio.xruns_last_hour':
        return value === 0 ? 'ok' : value <= 5 ? 'high' : 'way_high';
      case 'audio.connection_state':
        return value === 'open' ? 'ok'
          : value === 'connecting' || value === 'reconnecting' ? 'high'
          : 'way_high';
      case 'audio.sample_rate':
        return rangeLevel(value, [
          {max:8001,level:'way_low'},{max:16000,level:'low'},{max:48001,level:'ok'},
          {max:96001,level:'high'},{max:Infinity,level:'way_high'}]);

      case 'cpu.percent_1s':
        return rangeLevel(value, [{max:50,level:'ok'},{max:80,level:'high'},{max:Infinity,level:'way_high'}]);
      case 'cpu.percent_peak_60s':
        return rangeLevel(value, [{max:70,level:'ok'},{max:90,level:'high'},{max:Infinity,level:'way_high'}]);
      case 'cpu.throttled_bits': {
        const n = typeof value === 'string' ? parseInt(value, 16) : Number(value);
        if (isNaN(n) || n === 0) return 'ok';
        return (n & THROTTLE_NOW_MASK) ? 'way_high' : 'high';
      }

      case 'cpu.temp_c':
        return rangeLevel(value, [{max:60,level:'ok'},{max:75,level:'high'},{max:Infinity,level:'way_high'}]);

      case 'ram.used_mb':
      case 'ram.peak_60s_mb':
        return rangeLevel(value, [{max:500,level:'ok'},{max:800,level:'high'},{max:Infinity,level:'way_high'}]);

      case 'disk.sd_free_mb':
        return value > 2000 ? 'ok' : value > 500 ? 'low' : value > 200 ? 'high' : 'way_high';

      case 'pipeline.assembler_state': {
        const s = value;
        if (s === 'ACTIVE_CONFIRMED') return 'way_high';
        if (s === 'ACTIVE_CANDIDATE') return 'high';
        return 'neutral';
      }
      case 'pipeline.max_score_10s':
        if (value == null) return 'neutral';
        return value >= 0.9 ? 'high' : value >= 0.4 ? 'ok' : 'neutral';

      case 'pipeline.last_inference_ts': {
        const ageMs = Date.now() - new Date(value).getTime();
        return ageMs < 15_000 ? 'ok' : ageMs < 60_000 ? 'high' : 'way_high';
      }

      case 'counts_24h.uploads_failed':
        return value === 0 ? 'ok' : value < 5 ? 'high' : 'way_high';
      case 'counts_24h.uploads_retried':
        return value === 0 ? 'ok' : 'high';

      default:
        return 'neutral';
    }
  }

  const HINT = {
    'audio.rms_now':              '< 0.003 very low · 0.003–0.01 low · 0.01–0.08 ✓ · 0.08–0.2 high · > 0.2 danger',
    'audio.rms_mean_10s':         '< 0.002 very low · 0.002–0.008 low · 0.008–0.05 ✓ · 0.05–0.12 high · > 0.12 danger',
    'audio.rms_dbfs_now':         '< −50 very low · −50 to −35 low · −35 to −18 ✓ · −18 to −10 high · > −10 danger',
    'audio.rms_dbfs_mean_10s':    '< −55 very low · −55 to −40 low · −40 to −22 ✓ · −22 to −14 high · > −14 danger',
    'audio.peak_now':             '< 0.02 very low · 0.02–0.08 low · 0.08–0.5 ✓ · 0.5–0.85 high · > 0.85 danger',
    'audio.clip_rate_10s':        '0 – 0.00001 ✓ · 0.00001–0.001 high · > 0.001 danger',
    'audio.xruns_last_hour':      '0 ✓ · 1–5 high · > 5 danger',
    'audio.xruns_total':          'capture interruptions since bark-monitor started',
    'audio.connection_state':     'open ✓ · connecting/reconnecting notable · failed/closed danger',
    'audio.last_error':           'most recent PortAudio/ALSA capture error',
    'audio.sample_rate':          '< 8 kHz very low · 16–48 kHz ✓ · > 96 kHz danger',
    'audio.streaming':            'false = stream dead · true ✓',
    'audio.usb_mic_present':      'false = mic missing · true ✓',
    'cpu.percent_1s':             '< 50% ✓ · 50–80% high · > 80% danger',
    'cpu.percent_peak_60s':       '< 70% ✓ · 70–90% high · > 90% danger',
    'cpu.temp_c':                 '< 60°C ✓ · 60–75°C high · > 75°C danger',
    'ram.used_mb':                '< 500 MB ✓ · 500–800 MB high · > 800 MB danger',
    'ram.peak_60s_mb':            '< 500 MB ✓ · 500–800 MB high · > 800 MB danger',
    'disk.sd_free_mb':            '> 2 GB ✓ · 0.5–2 GB low · 0.2–0.5 GB high · < 200 MB danger',
    'net.online':                 'false = offline · true ✓',
    'net.masmopi_ok':             'false = upstream unreachable · true ✓',
    'alive':                      'false = process not alive · true ✓',
    'cpu.throttled_bits':          'none ✓ · bits 0–3 active now (red) · bits 16–19 since boot (amber)',
    'pipeline.last_inference_ts': '< 15 s ✓ · 15–60 s notable · > 60 s stalled',
    'pipeline.assembler_state':   'IDLE · ACTIVE_CANDIDATE · ACTIVE_CONFIRMED · COOLDOWN',
    'pipeline.max_score_10s':     'max classifier output in the last 10 s — above candidate_threshold = recent bark activity',
    'counts_24h.uploads_failed':  '0 ✓ · any > 0 is notable',
    'counts_24h.uploads_retried': '0 ✓ · any > 0 is notable',
  };

  const HARDWARE_SECTIONS = [
    { title: 'System', rows: [
      { path: 'alive',         label: 'Alive',       fmt: v => v ? 'yes' : 'no' },
      { path: 'now',           label: 'Server time', fmt: v => new Date(v).toLocaleTimeString() },
      { path: 'boot_time',     label: 'Boot time',   fmt: v => new Date(v).toLocaleString() },
      { path: 'uptime_s',      label: 'Uptime',      fmt: v => `${Math.floor(v/3600)}h ${Math.floor((v%3600)/60)}m ${(v%60)|0}s` },
      { path: 'heartbeat_seq', label: 'Heartbeat',   fmt: v => String(v) },
    ]},
    { title: 'Audio', rows: [
      { path: 'audio.usb_mic_present',   label: 'USB mic',       fmt: v => v ? 'yes' : 'no' },
      { path: 'audio.streaming',         label: 'Streaming',     fmt: v => v ? 'yes' : 'no' },
      { path: 'audio.connection_state',  label: 'Connection',    fmt: v => String(v) },
      { path: 'audio.device_name',       label: 'Device',        fmt: v => String(v) },
      { path: 'audio.sample_rate',       label: 'Sample rate',   fmt: v => `${(v/1000).toFixed(0)} kHz` },
      { path: 'audio.rms_now',           label: 'RMS now',       fmt: v => v.toFixed(4) },
      { path: 'audio.rms_mean_10s',      label: 'RMS mean 10s',  fmt: v => v.toFixed(4) },
      { path: 'audio.rms_dbfs_now',      label: 'RMS dBFS now',  fmt: v => `${v.toFixed(1)} dBFS` },
      { path: 'audio.rms_dbfs_mean_10s', label: 'RMS dBFS 10s',  fmt: v => `${v.toFixed(1)} dBFS` },
      { path: 'audio.peak_now',          label: 'Peak now',      fmt: v => v.toFixed(4) },
      { path: 'audio.clip_rate_10s',     label: 'Clip rate 10s', fmt: v => v.toFixed(6) },
      { path: 'audio.xruns_last_hour',   label: 'XRuns/hour',    fmt: v => String(v) },
      { path: 'audio.xruns_total',       label: 'XRuns/session', fmt: v => String(v) },
      { path: 'audio.last_error',        label: 'Last error',    fmt: v => String(v) },
    ]},
    { title: 'CPU', rows: [
      { path: 'cpu.percent_1s',       label: 'CPU % now',      fmt: v => `${v.toFixed(1)} %` },
      { path: 'cpu.percent_peak_60s', label: 'CPU % peak 60s', fmt: v => `${v.toFixed(1)} %` },
      { path: 'cpu.temp_c',           label: 'Temp',           fmt: v => `${v.toFixed(1)} °C` },
      { path: 'cpu.throttled_bits',   label: 'Throttled',      fmt: fmtThrottled },
    ]},
    { title: 'RAM', rows: [
      { path: 'ram.used_mb',     label: 'RAM used',     fmt: v => `${v.toFixed(0)} MB` },
      { path: 'ram.peak_60s_mb', label: 'RAM peak 60s', fmt: v => `${v.toFixed(0)} MB` },
    ]},
    { title: 'Disk', rows: [
      { path: 'disk.sd_free_mb', label: 'SD free', fmt: v => `${v.toFixed(0)} MB` },
    ]},
    { title: 'Network', rows: [
      { path: 'net.online',            label: 'Online',       fmt: v => v ? 'yes' : 'no' },
      { path: 'net.masmopi_ok',        label: 'Upstream OK',  fmt: v => v ? 'yes' : 'no' },
      { path: 'net.local_ip',          label: 'Local IP',     fmt: v => String(v) },
      { path: 'net.tailscale_ip',      label: 'Tailscale IP', fmt: v => String(v) },
      { path: 'net.last_upload_probe', label: 'Last upload',  fmt: v => v ? new Date(v).toLocaleTimeString() : '—' },
    ]},
  ];

  const PIPELINE_SUMMARY_ROWS = [
    { path: 'pipeline.state',             label: 'Service state', fmt: v => v ?? '—' },
    { path: 'pipeline.model_version',     label: 'Model version', fmt: v => v ?? '—' },
    { path: 'pipeline.bark_events_today', label: 'Barks today',   fmt: v => String(v) },
  ];

  function progressPercent(value, max) {
    const current = Number(value);
    const limit = Number(max);
    if (!Number.isFinite(current) || !Number.isFinite(limit) || limit <= 0) return 0;
    return Math.max(0, Math.min(100, (current / limit) * 100));
  }

  function fmtScadaSeconds(value) {
    const seconds = Number(value);
    if (!Number.isFinite(seconds)) return '—';
    return `${seconds < 10 ? seconds.toFixed(1) : Math.round(seconds)}s`;
  }

  function uploadStateLabel(channel) {
    const state = channel?.state;
    if (!state) return 'Unavailable';
    return state.replaceAll('_', ' ').replace(/\b\w/g, c => c.toUpperCase());
  }

  function uploadTone(channel) {
    const state = channel?.state;
    if (state === 'uploaded') return 'ok';
    if (state === 'failed') return 'error';
    if (state === 'retrying') return 'warn';
    if (['queued', 'encoding', 'uploading', 'pending', 'waiting'].includes(state)) return 'active';
    return 'idle';
  }

  function uploadDetail(channel) {
    if (!channel) return '';
    if (channel.state === 'retrying' && channel.retry_in_s != null) {
      return `retry in ${fmtScadaSeconds(channel.retry_in_s)}`;
    }
    if (channel.attempt != null && channel.max_attempts != null) {
      return `attempt ${channel.attempt}/${channel.max_attempts}`;
    }
    if (channel.hit_count != null) return `${channel.hit_count} hits`;
    return channel.detail ?? '';
  }

  function getVal(obj, path) {
    return path.split('.').reduce((o, k) => o?.[k], obj);
  }

  // ── Manual tab helpers ─────────────────────────────────────────────────────

  async function fetchRecordStatus() {
    try {
      const res = await fetch(`${BASE_URL}/record/status`, { signal: AbortSignal.timeout(3000) });
      if (res.ok) {
        recordStatus = await res.json();
        // Background recording worker failed after /record/start already
        // returned ok:true (e.g. an audio device error) -- surface it here
        // since it wasn't known at request time.
        if (recordStatus?.state === 'IDLE' && recordStatus?.error) {
          recordMessage = recordStatus.error;
        }
      }
    } catch (_e) { /* silently ignore — status shown via status tab */ }
  }

  async function startRecording() {
    recordMessage = '';
    selectedLabel = '';
    try {
      const res = await fetch(`${BASE_URL}/record/start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ duration: recordDuration }),
        signal: AbortSignal.timeout(5000),
      });
      const data = await res.json();
      if (!data.ok) recordMessage = data.error ?? 'Failed to start';
      else await fetchRecordStatus();
    } catch (_e) { recordMessage = `Could not reach ${HOST_LABEL}`; }
  }

  async function stopRecording() {
    try {
      await fetch(`${BASE_URL}/record/stop`, { method: 'POST', signal: AbortSignal.timeout(5000) });
      await fetchRecordStatus();
    } catch (_e) { recordMessage = `Could not reach ${HOST_LABEL}`; }
  }

  async function labelRecording() {
    if (!selectedLabel) return;
    try {
      const res = await fetch(`${BASE_URL}/record/label`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ label: selectedLabel }),
        signal: AbortSignal.timeout(10000),
      });
      let data;
      try { data = await res.json(); } catch (_e) { data = null; }
      if (!res.ok || !data) {
        recordMessage = data?.error ?? `Server error ${res.status}`;
      } else {
        if (data.ok) {
          recordMessage = data.destination === 'local'
            ? `Saved locally: ${data.label}`
            : `Uploaded to Masmopi: ${data.filename ?? data.label}`;
        } else {
          recordMessage = data.error ?? 'Save failed';
        }
        selectedLabel = '';
        await fetchRecordStatus();
      }
    } catch (err) {
      recordMessage = err?.name === 'TimeoutError' ? 'Request timed out' : `Could not reach ${HOST_LABEL}`;
    }
  }

  async function discardRecording() {
    try {
      await fetch(`${BASE_URL}/record/discard`, { method: 'POST', signal: AbortSignal.timeout(5000) });
      recordMessage = '';
      selectedLabel = '';
      await fetchRecordStatus();
    } catch (_e) { recordMessage = `Could not reach ${HOST_LABEL}`; }
  }

  async function executeControl() {
    if (!confirmAction || controlBusy) return;
    controlBusy = true;
    controlMessage = '';
    const action = confirmAction;
    confirmAction = null;
    try {
      const res = await fetch(`${BASE_URL}/control/${action}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ confirmed: true }),
        signal: AbortSignal.timeout(8000),
      });
      const data = await res.json();
      controlMessage = data.ok
        ? (action === 'reboot' ? 'Rebooting… (back in ~30 s)' : 'Shutting down…')
        : (data.error ?? 'Failed');
    } catch (_e) { controlMessage = `Could not reach ${HOST_LABEL}`; }
    controlBusy = false;
  }

  async function setMonitorRunning(running) {
    if (monitorBusy) return;
    monitorBusy = true;
    monitorMessage = '';
    try {
      const res = await fetch(`${BASE_URL}/monitor/${running ? 'start' : 'stop'}`, {
        method: 'POST',
        signal: AbortSignal.timeout(8000),
      });
      const data = await res.json();
      if (!data.ok) monitorMessage = data.error ?? 'Failed';
      await fetchStatus();
    } catch (_e) {
      monitorMessage = `Could not reach ${HOST_LABEL}`;
    }
    monitorBusy = false;
  }

  function closePopup() {
    showPopup = false;
    confirmAction = null;
    showShutdownControl = false;
  }

  function handleKeydown(/** @type {KeyboardEvent} */ e) {
    if (e.key === 'Escape' && showPopup) closePopup();
  }
</script>

<svelte:window onkeydown={handleKeydown} />

<button
  class="status-dot dot-{dotState}"
  onclick={() => (showPopup = !showPopup)}
  title={DOT_TITLES[dotState]}
  aria-label={`${HOST_LABEL} status`}
></button>

{#if showPopup}
  <button
    class="status-backdrop"
    aria-label="Close Goblin status"
    onclick={closePopup}
  ></button>

  <div class="status-popup" role="dialog" aria-modal="true" aria-label={`${HOST_LABEL} status`}>
    <div class="popup-header">
      <span class="popup-title">{HOST_LABEL}</span>
      {#if status}
        <span class="popup-time">as of {new Date(status.now).toLocaleTimeString()}</span>
      {:else}
        <span class="popup-time popup-error">unreachable — not on tailnet?</span>
      {/if}
      <button class="popup-close" onclick={closePopup}>✕</button>
    </div>

    <div class="tab-bar">
      <button class="tab-btn" class:active={activeTab === 'hardware'} onclick={() => (activeTab = 'hardware')}>Hardware</button>
      <button class="tab-btn" class:active={activeTab === 'monitor'}  onclick={() => (activeTab = 'monitor')}>Monitor</button>
      <button class="tab-btn" class:active={activeTab === 'manual'}   onclick={() => (activeTab = 'manual')}>Manual</button>
    </div>

    {#if activeTab === 'hardware'}
      {#if status}
        <div class="popup-body">
          <table class="status-table">
            {#each HARDWARE_SECTIONS as section}
              <tbody>
                <tr class="section-hdr"><td colspan="3">{section.title}</td></tr>
                {#each section.rows as row}
                  {@const val = getVal(status, row.path)}
                  {@const level = getLevel(row.path, val)}
                  <tr>
                    <td class="td-label">{row.label}</td>
                    <td class="td-value" style:background={levelBg(level)}>
                      {val != null ? row.fmt(val) : '—'}
                      {#if level !== 'neutral' && levelLabel(level)}
                        <span class="level-tag">{levelLabel(level)}</span>
                      {/if}
                    </td>
                    <td class="td-hint">{HINT[row.path] ?? ''}</td>
                  </tr>
                {/each}
              </tbody>
            {/each}
          </table>
        </div>
      {:else}
        <div class="popup-body empty-body">
          <p>Could not reach <code>{HOSTNAME}</code>.</p>
          <p>Are you connected to Tailscale?</p>
          <button class="retry-btn" onclick={fetchStatus}>Retry now</button>
        </div>
      {/if}

    {:else if activeTab === 'monitor'}
      <div class="popup-body">
        {#if status}
          <table class="status-table pipeline-summary">
            <tbody>
              <tr class="section-hdr"><td colspan="3">Pipeline</td></tr>
              {#each PIPELINE_SUMMARY_ROWS as row}
                {@const val = getVal(status, row.path)}
                <tr>
                  <td class="td-label">{row.label}</td>
                  <td class="td-value">{val != null ? row.fmt(val) : '—'}</td>
                  <td class="td-hint"></td>
                </tr>
              {/each}
            </tbody>
          </table>

          <section class="scada-panel" aria-label="Live bark pipeline stages">
            <div class="scada-grid">
              <article class="scada-stage" class:stage-engaged={detectionEngaged}>
                <header class="stage-header">
                  <span class="stage-number">01</span>
                  <span class="stage-title">Detection</span>
                  <span class="stage-lamp" class:lamp-on={detectionEngaged}></span>
                </header>

                <div class="stage-state">{assemblerState}</div>
                <div class="score-readout">
                  <span>Max score · 10s</span>
                  <strong>{maxScore10s != null ? Number(maxScore10s).toFixed(3) : '—'}</strong>
                </div>
                <div class="score-track" aria-hidden="true">
                  <span style:width={`${progressPercent(maxScore10s, 1)}%`}></span>
                </div>

                {#if detectionActive}
                  <div class="instrument">
                    <div class="instrument-label">
                      <span>Confirmed hits</span>
                      <strong>{confirmedHits} / {confirmationHits || '—'}</strong>
                    </div>
                    <div
                      class="instrument-track hits-track"
                      role="progressbar"
                      aria-label="Confirmed hits"
                      aria-valuenow={confirmedHits}
                      aria-valuemin="0"
                      aria-valuemax={confirmationHits || 0}
                    >
                      <span style:width={`${progressPercent(confirmedHits, confirmationHits)}%`}></span>
                    </div>
                  </div>

                  <div class="instrument">
                    <div class="instrument-label">
                      <span>Window remaining</span>
                      <strong>{fmtScadaSeconds(confirmationRemaining)} / {fmtScadaSeconds(confirmationWindow)}</strong>
                    </div>
                    <div
                      class="instrument-track countdown-track"
                      role="progressbar"
                      aria-label="Confirmation window remaining"
                      aria-valuenow={confirmationRemaining}
                      aria-valuemin="0"
                      aria-valuemax={confirmationWindow || 0}
                    >
                      <span style:width={`${progressPercent(confirmationRemaining, confirmationWindow)}%`}></span>
                    </div>
                  </div>
                {:else}
                  <div class="stage-standby">Detection latched · assembly owns event</div>
                {/if}
              </article>

              <article class="scada-stage" class:stage-engaged={assemblyEngaged}>
                <header class="stage-header">
                  <span class="stage-number">02</span>
                  <span class="stage-title">Assembly</span>
                  <span class="stage-lamp" class:lamp-on={assemblyEngaged}></span>
                </header>

                <div class="stage-state">{assemblyActive ? 'ACTIVE_CONFIRMED' : 'STANDBY'}</div>
                {#if assemblyActive}
                  <div class="instrument stage-first-instrument">
                    <div class="instrument-label">
                      <span>Clip length</span>
                      <strong>{fmtScadaSeconds(clipElapsed)} / {fmtScadaSeconds(maxClip)}</strong>
                    </div>
                    <div
                      class="instrument-track clip-track"
                      role="progressbar"
                      aria-label="Clip length"
                      aria-valuenow={clipElapsed}
                      aria-valuemin="0"
                      aria-valuemax={maxClip || 0}
                    >
                      <span style:width={`${progressPercent(clipElapsed, maxClip)}%`}></span>
                    </div>
                  </div>

                  <div class="instrument">
                    <div class="instrument-label">
                      <span>Silence timer</span>
                      <strong>{fmtScadaSeconds(silenceElapsed)} / {fmtScadaSeconds(silenceGap)}</strong>
                    </div>
                    <div
                      class="instrument-track silence-track"
                      role="progressbar"
                      aria-label="Silence timer"
                      aria-valuenow={silenceElapsed}
                      aria-valuemin="0"
                      aria-valuemax={silenceGap || 0}
                    >
                      <span style:width={`${progressPercent(silenceElapsed, silenceGap)}%`}></span>
                    </div>
                  </div>
                {:else}
                  <div class="stage-standby stage-standby-tall">
                    {assemblerState === 'COOLDOWN' ? 'Finalising confirmed clip' : 'Waiting for confirmed detection'}
                  </div>
                {/if}
              </article>

              <article class="scada-stage upload-stage" class:stage-engaged={uploadEngaged}>
                <header class="stage-header">
                  <span class="stage-number">03</span>
                  <span class="stage-title">Upload</span>
                  <span class="queue-depth">Q {uploadStatus?.queue_depth ?? 0}</span>
                </header>

                <div class="upload-channel" title={audioUploadStatus?.detail ?? ''}>
                  <span class="channel-lamp tone-{uploadTone(audioUploadStatus)}"></span>
                  <span class="channel-copy">
                    <small>Audio clip</small>
                    <strong>{uploadStateLabel(audioUploadStatus)}</strong>
                  </span>
                  <span class="channel-detail">{uploadDetail(audioUploadStatus)}</span>
                </div>

                <div class="upload-channel" title={metadataUploadStatus?.detail ?? ''}>
                  <span class="channel-lamp tone-{uploadTone(metadataUploadStatus)}"></span>
                  <span class="channel-copy">
                    <small>Hit metadata</small>
                    <strong>{uploadStateLabel(metadataUploadStatus)}</strong>
                  </span>
                  <span class="channel-detail">{uploadDetail(metadataUploadStatus)}</span>
                </div>

                <div class="upload-counters">
                  <div class:counter-alert={uploadsFailed24h > 0}>
                    <strong>{uploadsFailed24h}</strong>
                    <span>Failed · 24h</span>
                  </div>
                  <div class:counter-warn={uploadsRetried24h > 0}>
                    <strong>{uploadsRetried24h}</strong>
                    <span>Retried · 24h</span>
                  </div>
                </div>
              </article>
            </div>
          </section>
        {:else}
          <table class="status-table">
            <tbody>
              <tr class="monitor-unreachable-row">
                <td colspan="3">
                  Goblin status is unavailable. DB values remain editable; applied values cannot be verified.
                  <button class="inline-retry-btn" onclick={fetchStatus}>Retry Goblin</button>
                </td>
              </tr>
            </tbody>
          </table>
        {/if}

        <table class="status-table">
          <tbody>
            <tr class="section-hdr">
              <td colspan="3">
                <span>Monitor parameters · DB ↔ Goblin memory</span>
                <button
                  class="section-action-btn"
                  disabled={monitorParamsLoading}
                  onclick={loadMonitorParams}
                >{monitorParamsLoading ? 'Loading…' : 'Reload DB'}</button>
              </td>
            </tr>
            <tr class="monitor-params-note">
              <td colspan="3">Edit a database value, then press Enter or tap Apply. It is saved and applied to Goblin automatically.</td>
            </tr>
            {#if monitorParamsError}
              <tr class="monitor-params-error">
                <td colspan="3">Could not load DB values: {monitorParamsError}</td>
              </tr>
            {/if}
            {#if monitorParamsLoading && dbMonitorParams.length === 0}
              <tr class="monitor-params-loading"><td colspan="3">Loading monitor parameters…</td></tr>
            {:else if !monitorParamsLoading && dbMonitorParams.length === 0 && !monitorParamsError}
              <tr class="monitor-params-loading"><td colspan="3">No monitor parameters found.</td></tr>
            {/if}
            {#each dbMonitorParams as row (row.paramId)}
              {@const goblinValue = appliedMonitorParamValues[row.paramId]}
              {@const matches = monitorParamValuesMatch(row.currentValue, goblinValue)}
              <tr class:param-mismatch={!matches}>
                <td class="td-label param-label">
                  <span>{row.name}</span>
                  <code>{row.paramId}</code>
                </td>
                <td class="td-value param-value-cell">
                  <div class="param-edit-row">
                    <input
                      class="param-input"
                      class:input-error={monitorParamMessages[row.paramId]?.kind === 'error'}
                      type="number"
                      min={row.minValue ?? undefined}
                      max={row.maxValue ?? undefined}
                      step={row.paramId === 'confirmation_hits' ? '1' : 'any'}
                      value={monitorParamDrafts[row.paramId] ?? row.currentValue}
                      disabled={monitorParamSaving[row.paramId]}
                      aria-label={`${row.name} value`}
                      oninput={(e) => {
                        monitorParamDrafts = {
                          ...monitorParamDrafts,
                          [row.paramId]: e.currentTarget.value,
                        };
                      }}
                      onkeydown={(e) => handleMonitorParamKeydown(e, row)}
                    />
                    {#if monitorParamHasChanged(row)}
                      <button
                        class="param-apply-btn"
                        type="button"
                        disabled={monitorParamSaving[row.paramId]}
                        aria-label={`Apply ${row.name}`}
                        onclick={() => saveMonitorParam(row)}
                      >{monitorParamSaving[row.paramId] ? 'Applying…' : 'Apply'}</button>
                    {/if}
                  </div>
                  <div class="param-sync" class:match={matches} class:mismatch={!matches}>
                    {#if matches}
                      <span title="Database and Goblin memory match">✅ DB and Goblin: {row.currentValue}</span>
                    {:else}
                      <span title="Database and Goblin memory do not match">
                        ❓ DB: {row.currentValue} · Goblin: {goblinValue ?? 'unavailable'}
                      </span>
                    {/if}
                  </div>
                  {#if monitorParamSaving[row.paramId]}
                    <div class="param-message">Saving DB, then refreshing Goblin…</div>
                  {:else if monitorParamMessages[row.paramId]}
                    <div
                      class="param-message"
                      class:param-success={monitorParamMessages[row.paramId].kind === 'success'}
                      class:param-error={monitorParamMessages[row.paramId].kind === 'error'}
                    >{monitorParamMessages[row.paramId].text}</div>
                  {/if}
                </td>
                <td class="td-hint param-hint">
                  <span>{row.description}</span>
                  <span class="param-range">
                    Default {row.defaultValue} · allowed {row.minValue}–{row.maxValue}
                  </span>
                </td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>

    {:else if activeTab === 'manual'}
      <!-- Manual tab -->
      <div class="popup-body manual-body">

        <!-- Bark monitor section -->
        <div class="manual-section">
          <div class="manual-section-title">BARK MONITOR</div>

          <div class="monitor-row">
            <span class="monitor-state">
              {#if monitorActive === null}
                Unknown
              {:else if monitorActive}
                <span class="monitor-dot"></span> Running
              {:else}
                Stopped
              {/if}
            </span>
            {#if monitorActive}
              <button class="action-btn danger-btn" disabled={monitorBusy} onclick={() => setMonitorRunning(false)}>
                {monitorBusy ? 'Stopping…' : 'Stop monitor'}
              </button>
            {:else}
              <button class="action-btn" disabled={monitorBusy} onclick={() => setMonitorRunning(true)}>
                {monitorBusy ? 'Starting…' : 'Start monitor'}
              </button>
            {/if}
          </div>

          {#if monitorMessage}
            <div class="feedback-msg">{monitorMessage}</div>
          {/if}
        </div>

        <!-- Record section -->
        <div class="manual-section">
          <div class="manual-section-title">RECORD A SAMPLE</div>

          {#if monitorActive}
            <div class="feedback-msg">Stop the bark monitor above first — it holds the microphone.</div>
          {/if}

          {#if !recordStatus || recordStatus.state === 'IDLE' || recordStatus.state === 'LABELLED'}
            <div class="record-row">
              <select class="duration-select" bind:value={recordDuration}>
                <option value={5}>5 s</option>
                <option value={10}>10 s</option>
                <option value={15}>15 s</option>
                <option value={20}>20 s</option>
                <option value={30}>30 s</option>
              </select>
              <button class="action-btn" disabled={monitorActive === true} onclick={startRecording}>Start recording</button>
            </div>

          {:else if recordStatus.state === 'RECORDING'}
            <div class="recording-live">
              <span class="rec-dot"></span>
              <span class="rec-label">REC</span>
              <span class="rec-countdown">{recordStatus.seconds_remaining}s</span>
            </div>
            <button class="action-btn stop-btn" onclick={stopRecording}>Stop</button>

          {:else if recordStatus.state === 'DONE_UNLABELLED'}
            <p class="label-prompt">Recording done — pick a label:</p>
            <div class="label-grid">
              {#each LABELS as lbl}
                <button
                  class="label-btn"
                  class:selected={selectedLabel === lbl}
                  onclick={() => (selectedLabel = lbl)}
                >{lbl}</button>
              {/each}
            </div>
            <div class="save-row">
              <button class="action-btn" disabled={!selectedLabel} onclick={labelRecording}>Save</button>
              <button class="action-btn discard-btn" onclick={discardRecording}>Discard</button>
            </div>
          {/if}

          {#if recordMessage}
            <div class="feedback-msg">{recordMessage}</div>
          {/if}

          <!-- Recent recordings history (read-only -- use the Training page to play/annotate) -->
          <div class="recent-recordings">
            <div class="recent-recordings-title">Recent recordings</div>
            {#if samplesError}
              <div class="recent-recordings-msg recent-recordings-err">{samplesError}</div>
            {:else if samplesLoading && samples.length === 0}
              <div class="recent-recordings-msg">Loading…</div>
            {:else if recentSamples.length === 0}
              <div class="recent-recordings-msg">No recordings yet.</div>
            {:else}
              {#each recentSamples as sample (sample.id)}
                <div class="recent-recording-row">
                  <span class="sample-label-pill" style:background={sampleLabelColor(sample.label)}>{sample.label}</span>
                  <span class="recent-recording-time">{formatSampleDatetime(sample.datetimeLocal)}</span>
                  <span class="recent-recording-dur">{formatDuration(sample.durationSec)}</span>
                </div>
              {/each}
            {/if}
          </div>
        </div>

        <!-- System control section -->
        <div class="manual-section">
          <div class="manual-section-title">SYSTEM</div>

          {#if !confirmAction}
            <div class="control-row">
              <button class="action-btn" onclick={() => { confirmAction = 'reboot'; controlMessage = ''; }}>
                Restart Goblin
              </button>
            </div>
            {#if showShutdownControl}
              <div class="shutdown-command" id="shutdown-command">
                <button class="action-btn danger-btn" onclick={() => { confirmAction = 'halt'; controlMessage = ''; showShutdownControl = false; }}>
                  Shut down
                </button>
                <button
                  class="shutdown-disclosure"
                  aria-expanded="true"
                  aria-controls="shutdown-command"
                  onclick={() => (showShutdownControl = false)}
                >Hide shutdown command</button>
              </div>
            {:else}
              <button
                class="shutdown-disclosure"
                aria-expanded="false"
                aria-controls="shutdown-command"
                onclick={() => (showShutdownControl = true)}
              >Show shutdown command</button>
            {/if}
          {:else}
            <div class="confirm-prompt">
              {confirmAction === 'reboot' ? 'Reboot the Pi?' : 'Shut down the Pi?'}
            </div>
            <div class="control-row">
              <button class="action-btn danger-btn" disabled={controlBusy} onclick={executeControl}>
                {controlBusy ? 'Sending…' : 'Confirm'}
              </button>
              <button class="action-btn" onclick={() => (confirmAction = null)}>Cancel</button>
            </div>
          {/if}

          {#if controlMessage}
            <div class="feedback-msg">{controlMessage}</div>
          {/if}
        </div>

      </div>
    {/if}

  </div>
{/if}

<style>
  /* ── Dot ── */
  .status-dot {
    width: 11px;
    height: 11px;
    border-radius: 50%;
    border: 1.5px solid transparent;
    cursor: pointer;
    padding: 0;
    flex-shrink: 0;
    transition: opacity 0.15s;
  }
  .status-dot:hover { opacity: 0.7; }

  .dot-unavailable { background: #fff;     border-color: #333; }
  .dot-inactive    { background: #aaa;     border-color: #888; }
  .dot-red         { background: #e74c3c;  border-color: #c0392b; }
  .dot-orange      { background: #f39c12;  border-color: #d68910; }
  .dot-green       { background: #27ae60;  border-color: #1e8449; }

  /* ── Backdrop ── */
  .status-backdrop {
    position: fixed;
    inset: 0;
    z-index: 900;
    padding: 0;
    border: 0;
    background: transparent;
    cursor: default;
  }

  /* ── Popup ── */
  .status-popup {
    position: fixed;
    top: 3rem;
    right: 1rem;
    width: min(680px, calc(100vw - 2rem));
    max-height: calc(100dvh - 4rem);
    background: #fff;
    border: 1px solid #e0e0dc;
    border-radius: 8px;
    box-shadow: 0 8px 32px rgba(0, 0, 0, 0.15);
    z-index: 901;
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }

  .popup-header {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.5rem 0.8rem;
    border-bottom: 1px solid #e0e0dc;
    background: #f7f7f5;
    flex-shrink: 0;
  }

  .popup-title {
    font-size: var(--font-size-small);
    font-weight: 700;
  }

  .popup-time {
    font-family: var(--font-tiny); font-size: var(--font-size-tiny);
    color: #999;
    flex: 1;
  }
  .popup-error { color: #c0392b; }

  .popup-close {
    background: none;
    border: none;
    cursor: pointer;
    font-family: var(--font-tiny); font-size: var(--font-size-tiny);
    color: #aaa;
    padding: 0.1rem 0.35rem;
    border-radius: 3px;
    line-height: 1;
  }
  .popup-close:hover { background: #eee; color: #333; }

  .popup-body {
    overflow-y: auto;
    flex: 1;
  }

  .empty-body {
    padding: 1.5rem;
    text-align: center;
    color: #888;
    font-size: var(--font-size-small);
  }
  .empty-body code { font-family: var(--font-monospace); font-size: var(--font-size-tiny); }

  .retry-btn {
    margin-top: 0.5rem;
    background: #1a1a1a;
    color: #fff;
    border: none;
    border-radius: 4px;
    padding: 0.35rem 0.9rem;
    font-family: var(--font-tiny); font-size: var(--font-size-tiny);
    cursor: pointer;
  }
  .retry-btn:hover { background: #333; }

  /* ── Table ── */
  .status-table {
    width: 100%;
    border-collapse: collapse;
    font-family: var(--font-tiny); font-size: var(--font-size-tiny);
    table-layout: fixed;
  }

  .section-hdr td {
    background: #1a1a1a;
    color: #fff;
    font-family: var(--font-tiny); font-size: var(--font-size-tiny);
    font-weight: 700;
    text-transform: uppercase;
    padding: 0.3rem 0.9rem;
  }

  .td-label {
    padding: 0.27rem 0.5rem 0.27rem 0.9rem;
    color: #555;
    white-space: nowrap;
    width: 10%;
    border-bottom: 1px solid #f0f0ec;
  }

  .td-value {
    padding: 0.27rem 0.5rem;
    font-weight: 600;
    font-variant-numeric: tabular-nums;
    white-space: pre-line;
    width: 40%;
    border-bottom: 1px solid #f0f0ec;
  }

  .level-tag {
    margin-left: 0.4rem;
    font-family: var(--font-tiny); font-size: var(--font-size-tiny);
    font-weight: 400;
    color: #666;
    text-transform: uppercase;
    opacity: 0.8;
  }

  .td-hint {
    padding: 0.27rem 0.9rem 0.27rem 0.4rem;
    color: #bbb;
    font-family: var(--font-tiny); font-size: var(--font-size-tiny);
    line-height: 1.4;
    width: 50%;
    border-bottom: 1px solid #f0f0ec;
  }

  /* ── Pipeline SCADA ── */
  .pipeline-summary .td-label { width: 35%; }
  .pipeline-summary .td-value { width: 65%; }
  .pipeline-summary .td-hint { display: none; }

  .scada-panel {
    padding: 0.65rem;
    border-bottom: 1px solid #deded9;
    background:
      linear-gradient(rgba(86, 110, 106, 0.055) 1px, transparent 1px),
      linear-gradient(90deg, rgba(86, 110, 106, 0.055) 1px, transparent 1px),
      #f3f4f1;
    background-size: 16px 16px;
    color: #26312f;
    font-variant-numeric: tabular-nums;
  }

  .scada-grid {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 0.55rem;
  }

  .scada-stage {
    position: relative;
    min-width: 0;
    min-height: 12.5rem;
    padding: 0.62rem;
    border: 1px solid #cbd2cf;
    border-top: 2px solid #aeb9b6;
    border-radius: 3px;
    background: rgba(255, 255, 255, 0.96);
    box-shadow: 0 1px 2px rgba(30, 45, 42, 0.06);
  }

  .scada-stage.stage-engaged {
    border-top-color: #59d6c9;
    box-shadow: 0 1px 2px rgba(30, 45, 42, 0.06), 0 0 0 1px rgba(89, 214, 201, 0.08);
  }

  .scada-stage:not(:last-child)::after {
    content: '›';
    position: absolute;
    z-index: 2;
    top: 50%;
    right: -0.48rem;
    width: 0.4rem;
    color: #8da09d;
    font-size: var(--font-size-medium);
    line-height: 1;
    text-align: center;
    transform: translateY(-50%);
  }

  .stage-header {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    padding-bottom: 0.48rem;
    border-bottom: 1px solid #e2e6e4;
  }

  .stage-number {
    display: grid;
    place-items: center;
    width: 1.25rem;
    height: 1.25rem;
    border: 1px solid #b8c4c1;
    border-radius: 2px;
    color: #667b77;
    font-family: var(--font-monospace);
    font-size: var(--font-size-tiny);
    font-weight: 700;
  }

  .stage-title {
    flex: 1;
    color: #26312f;
    font-family: var(--font-tiny); font-size: var(--font-size-tiny);
    font-weight: 750;
    text-transform: uppercase;
  }

  .stage-lamp,
  .channel-lamp {
    width: 0.48rem;
    height: 0.48rem;
    flex: 0 0 auto;
    border: 1px solid #aeb8b6;
    border-radius: 50%;
    background: #e2e6e4;
    box-shadow: inset 0 0 1px rgba(0, 0, 0, 0.16);
  }

  .stage-lamp.lamp-on {
    border-color: #7df2e6;
    background: #56d8c9;
    box-shadow: 0 0 7px rgba(86, 216, 201, 0.7);
  }

  .stage-state {
    margin-top: 0.5rem;
    overflow: hidden;
    color: #718480;
    font-family: var(--font-monospace);
    font-size: var(--font-size-tiny);
    font-weight: 700;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .score-readout {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 0.4rem;
    margin-top: 0.55rem;
  }

  .score-readout span,
  .instrument-label span {
    color: #6f7f7c;
    font-family: var(--font-tiny); font-size: var(--font-size-tiny);
  }

  .score-readout strong {
    color: #177f77;
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: var(--font-size-small);
  }

  .score-track,
  .instrument-track {
    position: relative;
    overflow: hidden;
    border: 1px solid #c7cfcd;
    border-radius: 2px;
    background: #e8ecea;
  }

  .score-track {
    height: 0.28rem;
    margin-top: 0.2rem;
  }

  .score-track > span,
  .instrument-track > span {
    display: block;
    height: 100%;
    transition: width 0.35s ease;
  }

  .score-track > span { background: #65cfc5; }

  .instrument { margin-top: 0.72rem; }
  .stage-first-instrument { margin-top: 1.65rem; }

  .instrument-label {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 0.35rem;
    margin-bottom: 0.25rem;
  }

  .instrument-label strong {
    color: #34413f;
    font-family: var(--font-monospace);
    font-size: var(--font-size-tiny);
    font-weight: 650;
    white-space: nowrap;
  }

  .instrument-track { height: 0.62rem; }
  .instrument-track::after {
    content: '';
    position: absolute;
    inset: 0;
    background: repeating-linear-gradient(
      90deg,
      transparent 0,
      transparent calc(20% - 1px),
      rgba(255, 255, 255, 0.65) calc(20% - 1px),
      rgba(255, 255, 255, 0.65) 20%
    );
  }

  .hits-track > span { background: #45c9bd; }
  .countdown-track > span { background: #d7a34b; }
  .clip-track > span { background: #4a9fd1; }
  .silence-track > span { background: #e17a4f; }

  .stage-standby {
    display: grid;
    min-height: 3.5rem;
    margin-top: 0.75rem;
    place-items: center;
    border: 1px dashed #cbd3d0;
    background: #fafbf9;
    color: #899794;
    font-family: var(--font-tiny); font-size: var(--font-size-tiny);
    line-height: 1.5;
    text-align: center;
  }
  .stage-standby-tall { min-height: 7.2rem; margin-top: 1.35rem; }

  .queue-depth {
    color: #667b77;
    font-family: var(--font-monospace);
    font-size: var(--font-size-tiny);
  }

  .upload-channel {
    display: flex;
    align-items: center;
    gap: 0.42rem;
    min-width: 0;
    margin-top: 0.6rem;
    padding: 0.42rem;
    border: 1px solid #d3d9d7;
    border-radius: 2px;
    background: #f8f9f7;
  }

  .channel-lamp.tone-ok { border-color: #76df91; background: #4ec46d; box-shadow: 0 0 6px rgba(78, 196, 109, 0.6); }
  .channel-lamp.tone-error { border-color: #ff8e83; background: #db5549; box-shadow: 0 0 6px rgba(219, 85, 73, 0.6); }
  .channel-lamp.tone-warn { border-color: #f1c36c; background: #d99b33; box-shadow: 0 0 6px rgba(217, 155, 51, 0.55); }
  .channel-lamp.tone-active { border-color: #78d9ee; background: #4baec4; box-shadow: 0 0 6px rgba(75, 174, 196, 0.55); }

  .channel-copy { min-width: 0; flex: 1; }
  .channel-copy small,
  .channel-copy strong { display: block; }
  .channel-copy small {
    color: #7c8c89;
    font-family: var(--font-tiny); font-size: var(--font-size-tiny);
    text-transform: uppercase;
  }
  .channel-copy strong {
    overflow: hidden;
    margin-top: 0.06rem;
    color: #34413f;
    font-family: var(--font-tiny); font-size: var(--font-size-tiny);
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .channel-detail {
    max-width: 42%;
    overflow: hidden;
    color: #7a8b88;
    font-family: var(--font-tiny); font-size: var(--font-size-tiny);
    text-align: right;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .upload-counters {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 0.4rem;
    margin-top: 0.65rem;
  }
  .upload-counters > div {
    padding: 0.35rem 0.4rem;
    border: 1px solid #d0d7d4;
    border-radius: 2px;
    background: #fafbf9;
  }
  .upload-counters strong,
  .upload-counters span { display: block; }
  .upload-counters strong {
    color: #34413f;
    font-family: var(--font-monospace);
    font-size: var(--font-size-tiny);
  }
  .upload-counters span { margin-top: 0.05rem; color: #7a8b88; font-family: var(--font-tiny); font-size: var(--font-size-tiny); text-transform: uppercase; }
  .upload-counters .counter-alert { border-color: #e2aaa5; background: #fff7f6; }
  .upload-counters .counter-alert strong { color: #b63f35; }
  .upload-counters .counter-warn { border-color: #dfc58e; background: #fffaf0; }
  .upload-counters .counter-warn strong { color: #966412; }

  @media (max-width: 620px) {
    .scada-grid { grid-template-columns: 1fr; }
    .scada-stage { min-height: auto; }
    .scada-stage:not(:last-child)::after {
      top: auto;
      right: 50%;
      bottom: -0.52rem;
      transform: translateX(50%) rotate(90deg);
    }
    .stage-first-instrument { margin-top: 0.8rem; }
    .stage-standby-tall { min-height: 3.5rem; margin-top: 0.75rem; }
  }

  /* ── Monitor parameter editor ── */
  .section-action-btn {
    float: right;
    margin: -0.12rem 0;
    padding: 0.12rem 0.4rem;
    border: 1px solid #555;
    border-radius: 3px;
    background: transparent;
    color: #ddd;
    font: inherit;
    text-transform: uppercase;
    cursor: pointer;
  }
  .section-action-btn:hover:not(:disabled) { border-color: #aaa; color: #fff; }
  .section-action-btn:disabled { cursor: default; opacity: 0.55; }

  .monitor-unreachable-row td,
  .monitor-params-note td,
  .monitor-params-error td,
  .monitor-params-loading td {
    padding: 0.45rem 0.9rem;
    border-bottom: 1px solid #eee;
    font-family: var(--font-tiny); font-size: var(--font-size-tiny);
    line-height: 1.45;
  }
  .monitor-unreachable-row td {
    color: #8a5a00;
    background: #fff8e6;
  }
  .monitor-params-note td,
  .monitor-params-loading td { color: #888; background: #fafaf8; }
  .monitor-params-error td { color: #a93226; background: #fff1f0; }

  .inline-retry-btn {
    margin-left: 0.4rem;
    padding: 0;
    border: 0;
    border-bottom: 1px solid currentColor;
    background: transparent;
    color: inherit;
    font: inherit;
    cursor: pointer;
  }

  .param-mismatch { background: #fffcf3; }

  .param-label {
    width: 27%;
    white-space: normal;
    vertical-align: top;
    padding-top: 0.5rem;
  }
  .param-label span {
    display: block;
    color: #333;
    font-weight: 600;
    line-height: 1.3;
  }
  .param-label code {
    display: block;
    margin-top: 0.16rem;
    color: #aaa;
    font-family: var(--font-monospace); font-size: var(--font-size-tiny);
    line-height: 1.2;
    overflow-wrap: anywhere;
  }

  .param-value-cell {
    width: 31%;
    vertical-align: top;
    padding-top: 0.42rem;
    padding-bottom: 0.42rem;
    white-space: normal;
  }

  .param-input {
    width: 100%;
    min-width: 0;
    box-sizing: border-box;
    border: 1px solid #cfcfca;
    border-radius: 4px;
    background: #fff;
    color: #222;
    padding: 0.3rem 0.42rem;
    font-family: var(--font-tiny); font-size: var(--font-size-tiny);
    font-weight: 600;
    line-height: 1.2;
    font-variant-numeric: tabular-nums;
    outline: none;
  }
  .param-input:focus {
    border-color: #555;
    box-shadow: 0 0 0 2px rgba(20, 20, 20, 0.1);
  }
  .param-input:disabled { background: #f4f4f1; color: #777; }
  .param-input.input-error { border-color: #c0392b; }

  .param-edit-row {
    display: flex;
    align-items: stretch;
    gap: 0.3rem;
  }

  .param-apply-btn {
    flex-shrink: 0;
    border: 0;
    border-radius: 4px;
    background: #1a1a1a;
    color: #fff;
    padding: 0.3rem 0.45rem;
    font-family: var(--font-tiny); font-size: var(--font-size-tiny);
    font-weight: 600;
    cursor: pointer;
  }
  .param-apply-btn:hover:not(:disabled) { background: #333; }
  .param-apply-btn:disabled { cursor: default; opacity: 0.5; }

  .param-sync,
  .param-message {
    margin-top: 0.25rem;
    font-family: var(--font-tiny); font-size: var(--font-size-tiny);
    font-weight: 500;
    line-height: 1.35;
  }
  .param-sync.match { color: #277342; }
  .param-sync.mismatch { color: #93640c; }
  .param-message { color: #777; }
  .param-message.param-success { color: #277342; }
  .param-message.param-error { color: #a93226; }

  .param-hint {
    width: 42%;
    vertical-align: top;
    padding-top: 0.5rem;
    color: #8e8e88;
  }
  .param-range {
    display: block;
    margin-top: 0.2rem;
    color: #b2b2ac;
    font-family: var(--font-tiny); font-size: var(--font-size-tiny);
    font-variant-numeric: tabular-nums;
  }

  @media (max-width: 560px) {
    .param-label { width: 28%; }
    .param-value-cell { width: 38%; }
    .param-hint { width: 34%; }
    .param-hint > span:first-child { display: none; }
  }

  /* ── Tab bar ── */
  .tab-bar {
    display: flex;
    border-bottom: 1px solid #e0e0dc;
    background: #fafaf8;
    flex-shrink: 0;
  }

  .tab-btn {
    flex: 1;
    background: none;
    border: none;
    border-bottom: 2px solid transparent;
    padding: 0.45rem 0.8rem;
    font-family: var(--font-tiny); font-size: var(--font-size-tiny);
    font-weight: 600;
    cursor: pointer;
    color: #aaa;
    transition: color 0.1s;
  }
  .tab-btn:hover { color: #555; }
  .tab-btn.active {
    color: #1a1a1a;
    border-bottom-color: #1a1a1a;
  }

  /* ── Manual body ── */
  .manual-body {
    padding: 0.6rem 0.9rem 1rem;
    display: flex;
    flex-direction: column;
    gap: 0.6rem;
  }

  .manual-section {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    margin-top: 0;
  }

  .manual-section:not(:first-child) {
    margin-top: 1.4rem;
    padding-top: 0.2rem;
  }

  .manual-section-title {
    font-family: var(--font-tiny); font-size: var(--font-size-tiny);
    font-weight: 700;
    text-transform: uppercase;
    color: #999;
    border-bottom: 1px solid #e8e8e4;
    padding-bottom: 0.3rem;
    margin-bottom: 0.1rem;
  }

  /* ── Record controls ── */
  .record-row,
  .control-row,
  .save-row {
    display: flex;
    gap: 0.5rem;
    align-items: center;
    flex-wrap: wrap;
  }

  .monitor-row {
    display: flex;
    gap: 0.75rem;
    align-items: center;
    justify-content: space-between;
    flex-wrap: wrap;
  }

  .monitor-state {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    font-family: var(--font-tiny); font-size: var(--font-size-tiny);
    font-weight: 600;
    color: #555;
  }

  .monitor-dot {
    width: 10px;
    height: 10px;
    border-radius: 50%;
    background: #2ecc71;
    flex-shrink: 0;
  }

  .duration-select {
    font-family: inherit;
    font-family: var(--font-tiny); font-size: var(--font-size-tiny);
    padding: 0.3rem 0.5rem;
    border: 1px solid #d0d0cc;
    border-radius: 4px;
    background: #fff;
    cursor: pointer;
  }

  .action-btn {
    background: #1a1a1a;
    color: #fff;
    border: none;
    border-radius: 4px;
    padding: 0.35rem 0.85rem;
    font-family: var(--font-tiny); font-size: var(--font-size-tiny);
    cursor: pointer;
    font-weight: 500;
    transition: opacity 0.15s;
  }
  .action-btn:hover:not(:disabled) { opacity: 0.75; }
  .action-btn:disabled { opacity: 0.4; cursor: default; }

  .stop-btn    { background: #e74c3c; }
  .danger-btn  { background: #c0392b; }
  .discard-btn { background: #888; }

  .shutdown-command {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    margin-top: 0.35rem;
  }

  .shutdown-disclosure {
    display: block;
    width: max-content;
    margin-top: 0.3rem;
    padding: 0.05rem 0.1rem;
    border: 0;
    background: transparent;
    color: #aaa;
    font-family: var(--font-tiny);
    font-size: 0.625rem;
    line-height: 1.2;
    text-decoration: underline;
    text-underline-offset: 2px;
    cursor: pointer;
  }
  .shutdown-command .shutdown-disclosure { margin-top: 0; }
  .shutdown-disclosure:hover { color: #777; }

  /* ── Recording live indicator ── */
  .recording-live {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    font-family: var(--font-tiny); font-size: var(--font-size-tiny);
    font-weight: 600;
    margin-bottom: 0.25rem;
  }

  .rec-dot {
    width: 10px;
    height: 10px;
    border-radius: 50%;
    background: #e74c3c;
    flex-shrink: 0;
    animation: rec-blink 1s step-end infinite;
  }

  .rec-label { color: #e74c3c; }
  .rec-countdown { color: #555; font-variant-numeric: tabular-nums; }

  @keyframes rec-blink {
    0%, 49% { opacity: 1; }
    50%, 100% { opacity: 0; }
  }

  /* ── Label grid ── */
  .label-prompt {
    font-family: var(--font-tiny); font-size: var(--font-size-tiny);
    color: #555;
    margin: 0;
  }

  .label-grid {
    display: flex;
    flex-wrap: wrap;
    gap: 0.35rem;
  }

  .label-btn {
    background: #f0f0ec;
    border: 1.5px solid transparent;
    border-radius: 4px;
    padding: 0.3rem 0.65rem;
    font-family: var(--font-monospace); font-size: var(--font-size-tiny);
    cursor: pointer;
    color: #444;
    transition: background 0.1s, border-color 0.1s;
  }
  .label-btn:hover { background: #e0e0dc; }
  .label-btn.selected {
    background: #1a1a1a;
    color: #fff;
    border-color: #1a1a1a;
  }

  /* ── Confirm prompt ── */
  .confirm-prompt {
    font-family: var(--font-tiny); font-size: var(--font-size-tiny);
    color: #c0392b;
    font-weight: 600;
  }

  /* ── Feedback ── */
  .feedback-msg {
    font-family: var(--font-tiny); font-size: var(--font-size-tiny);
    color: #555;
    padding: 0.25rem 0.5rem;
    background: #f7f7f5;
    border-radius: 3px;
    border-left: 3px solid #ccc;
  }

  /* ── Recent recordings (end of RECORD A SAMPLE section) ── */
  .recent-recordings {
    margin-top: 0.5rem;
    padding-top: 0.5rem;
    border-top: 1px solid #f0f0ec;
  }

  .recent-recordings-title {
    font-family: var(--font-tiny); font-size: var(--font-size-tiny);
    text-transform: uppercase;
    color: #999;
    margin-bottom: 0.35rem;
  }

  .recent-recordings-msg {
    font-family: var(--font-tiny); font-size: var(--font-size-tiny);
    color: #999;
  }
  .recent-recordings-err { color: #c0392b; }

  .recent-recording-row {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.22rem 0;
    border-bottom: 1px solid #f4f4f0;
  }
  .recent-recording-row:last-child { border-bottom: none; }

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
  .recent-recording-time {
    flex: 1;
    font-family: var(--font-tiny); font-size: var(--font-size-tiny);
    color: #333;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    font-variant-numeric: tabular-nums;
  }

  .recent-recording-dur {
    font-family: var(--font-tiny); font-size: var(--font-size-tiny);
    color: #aaa;
    flex-shrink: 0;
    font-variant-numeric: tabular-nums;
  }
</style>
