import { ASSET_BASE } from '$lib/utils.js';

const CSV_PATH = 'training-set-projection.csv';

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

export async function loadTrainingProjectionPoints() {
  if (cachedPoints) return cachedPoints;
  if (pointsRequest) return pointsRequest;

  pointsRequest = fetch(`${ASSET_BASE}/${CSV_PATH}`)
    .then((res) => {
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.text();
    })
    .then((text) => {
      const lines = text.split(/\r?\n/);
      const headers = parseCsvLine(lines.shift() ?? '');
      const column = Object.fromEntries(headers.map((name, index) => [name, index]));
      const required = [
        'embedding_id', 'source_fragment', 'original_30s_recording',
        'original_recording_audio', 'window_start_s', 'window_end_s',
        'recording_window_start_s', 'recording_window_end_s', 'label',
        'pca_x', 'pca_y', 'umap_x', 'umap_y',
      ];
      const missing = required.filter((name) => column[name] == null);
      if (missing.length) throw new Error(`Missing CSV column${missing.length > 1 ? 's' : ''}: ${missing.join(', ')}`);

      const points = [];
      for (const line of lines) {
        if (!line) continue;
        const row = parseCsvLine(line);
        const pcaX = Number(row[column.pca_x]);
        const pcaY = Number(row[column.pca_y]);
        const umapX = Number(row[column.umap_x]);
        const umapY = Number(row[column.umap_y]);
        const windowStart = optionalNumber(row[column.window_start_s]);
        const windowEnd = optionalNumber(row[column.window_end_s]);
        if (![pcaX, pcaY, umapX, umapY].every(Number.isFinite)) continue;
        points.push({
          embeddingId: row[column.embedding_id],
          sourceFragment: row[column.source_fragment],
          originalRecording: row[column.original_30s_recording],
          originalAudio: row[column.original_recording_audio],
          annotationId: optionalNumber(row[column.annotation_id]),
          annotationWindowReview: row[column.annotation_window_review] || '',
          fragmentPadding: optionalNumber(row[column.fragment_padding_s]) ?? 0.15,
          windowIndex: optionalNumber(row[column.window_index]),
          windowStart,
          windowEnd,
          windowDuration: Number.isFinite(windowStart) && Number.isFinite(windowEnd)
            ? Math.max(0, windowEnd - windowStart)
            : null,
          recordingStart: optionalNumber(row[column.recording_window_start_s]),
          recordingEnd: optionalNumber(row[column.recording_window_end_s]),
          annotationStart: optionalNumber(row[column.annotation_start_s]),
          annotationEnd: optionalNumber(row[column.annotation_end_s]),
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
          pcaX,
          pcaY,
          umapX,
          umapY,
        });
      }
      if (!points.length) throw new Error('The CSV contains no plottable PCA/UMAP coordinates.');
      cachedPoints = points;
      return points;
    })
    .catch((error) => {
      pointsRequest = null;
      throw error;
    });

  return pointsRequest;
}
