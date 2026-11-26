import { ASSET_BASE, PUBLIC_API_BASE } from '$lib/utils.js';

/** @type {any[] | null} */
let cachedPoints = null;
/** @type {Promise<any[]> | null} */
let pointsRequest = null;

export function trainingAssetUrl(path) {
  return `${ASSET_BASE}/${String(path ?? '').split('/').map(encodeURIComponent).join('/')}`;
}

/** Resolve playback bounds against an exact parent-audio path. */
export function projectionPreviewSource(point, resolvedAudioPath) {
  if (!resolvedAudioPath) return null;

  if (Number.isFinite(point.recordingStart) && Number.isFinite(point.recordingEnd)) {
    return {
      path: resolvedAudioPath,
      start: point.recordingStart,
      end: point.recordingEnd,
    };
  }

  const match = /_(\d+)-(\d+)(\.[^./]+)$/.exec(point.sourceFragment ?? '');
  if (!match) {
    return {
      path: resolvedAudioPath,
      start: point.annotationStart,
      end: point.annotationEnd,
    };
  }
  return {
    path: resolvedAudioPath,
    start: Number(match[1]) / 1000,
    end: Number(match[2]) / 1000,
  };
}

/** Parse one RFC 4180-style row without adding a CSV dependency. */
function parseCsvLine(line) {
  const cells = [];
  let value = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (char === '"') {
      if (quoted && line[i + 1] === '"') {
        value += '"';
        i++;
      } else {
        quoted = !quoted;
      }
    } else if (char === ',' && !quoted) {
      cells.push(value);
      value = '';
    } else {
      value += char;
    }
  }
  cells.push(value);
  return cells;
}

function optionalNumber(value) {
  if (value == null || String(value).trim() === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

/** Decode exact millisecond annotation bounds and window position from the ID. */
function windowIdentity(embeddingId) {
  const match = /^[^/]+\/(.+):(\d+)$/.exec(embeddingId ?? '');
  if (!match) return null;
  const stem = match[1];
  const bounds = /^(.*)_(\d+)-(\d+)$/.exec(stem);
  return {
    // A stable fragment grouping key; playback uses the exact parent audio path.
    sourceFragment: `${embeddingId.slice(0, embeddingId.lastIndexOf(':'))}.wav`,
    originalRecording: bounds ? bounds[1] : stem,
    annotationStart: bounds ? Number(bounds[2]) / 1000 : null,
    annotationEnd: bounds ? Number(bounds[3]) / 1000 : null,
    windowIndex: Number(match[2]),
  };
}

export async function loadTrainingProjectionPoints() {
  if (cachedPoints) return cachedPoints;
  if (pointsRequest) return pointsRequest;

  pointsRequest = fetch(`${PUBLIC_API_BASE}/api/training/projection.csv`)
    .then((res) => {
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.text();
    })
    .then((text) => {
      const lines = text.split(/\r?\n/);
      const headers = parseCsvLine(lines.shift() ?? '');
      const column = Object.fromEntries(headers.map((name, index) => [name, index]));
      const required = [
        'embedding_id', 'original_recording_audio', 'label', 'umap_x', 'umap_y',
      ];
      // Accept the previous export during UI/data rollout as well.
      if (column.window_duration_s == null) required.push('window_start_s', 'window_end_s');
      const missing = required.filter((name) => column[name] == null);
      if (missing.length) throw new Error(`Missing CSV column${missing.length > 1 ? 's' : ''}: ${missing.join(', ')}`);

      const points = [];
      for (const line of lines) {
        if (!line) continue;
        const row = parseCsvLine(line);
        const umapX = optionalNumber(row[column.umap_x]);
        const umapY = optionalNumber(row[column.umap_y]);
        if (![umapX, umapY].every(Number.isFinite)) continue;
        const identity = windowIdentity(row[column.embedding_id]);
        if (!identity && column.source_fragment == null) throw new Error('Invalid embedding_id in projection CSV.');
        const windowIndex = identity?.windowIndex ?? optionalNumber(row[column.window_index]);
        const windowStart = windowIndex != null ? windowIndex * 0.48 : optionalNumber(row[column.window_start_s]);
        const windowDuration = column.window_duration_s != null
          ? optionalNumber(row[column.window_duration_s])
          : Math.max(0, Number(row[column.window_end_s]) - Number(row[column.window_start_s]));
        const fragmentPadding = optionalNumber(row[column.fragment_padding_s]) ?? 0.15;
        const annotationStart = identity?.annotationStart ?? optionalNumber(row[column.annotation_start_s]);
        const recordingStart = identity
          ? Math.max(0, (annotationStart ?? 0) - fragmentPadding) + windowStart
          : optionalNumber(row[column.recording_window_start_s]);
        points.push({
          embeddingId: row[column.embedding_id],
          sourceFragment: identity?.sourceFragment ?? row[column.source_fragment],
          originalRecording: identity?.originalRecording ?? row[column.original_30s_recording],
          originalAudio: row[column.original_recording_audio],
          annotationId: optionalNumber(row[column.annotation_id]),
          fragmentPadding,
          windowIndex,
          windowStart,
          windowEnd: windowStart + windowDuration,
          windowDuration,
          recordingStart,
          recordingEnd: Number.isFinite(recordingStart) && Number.isFinite(windowDuration)
            ? recordingStart + windowDuration : null,
          annotationStart,
          annotationEnd: identity?.annotationEnd ?? optionalNumber(row[column.annotation_end_s]),
          label: row[column.label],
          trainOrValidation: row[column.train_or_validation],
          classifierScore: optionalNumber(row[column.classifier_score]),
          classifierError: optionalNumber(row[column.classifier_error]),
          knnLabelDisagreement: optionalNumber(row[column.knn_label_disagreement]),
          knnBinaryDisagreement: optionalNumber(row[column.knn_binary_disagreement]),
          knnMeanDistance: optionalNumber(row[column.knn_mean_distance]),
          labelCentroidDistance: optionalNumber(row[column.label_centroid_distance]),
          nearestDistance: optionalNumber(row[column.nearest_distance]),
          suspicionScore: optionalNumber(row[column.suspicion_score]),
          suspicionRank: optionalNumber(row[column.suspicion_rank]),
          umapX,
          umapY,
        });
      }
      if (!points.length) throw new Error('The CSV contains no plottable UMAP coordinates.');
      cachedPoints = points;
      return points;
    })
    .catch((error) => {
      pointsRequest = null;
      throw error;
    });

  return pointsRequest;
}
