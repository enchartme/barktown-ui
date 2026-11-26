import { ASSET_BASE, downsampleWaveform, waveformNorm } from './utils.js';

export const PLAYER_BARS = 500;
const waveformRequests = new Map();
const audioRequests = new Map();

/** Share pending and loaded waveforms between background fetches and the player. */
export function loadPlayerWaveform(path) {
  if (!waveformRequests.has(path)) {
    const request = fetch(`${ASSET_BASE}/${path}`)
      .then(async (response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const json = await response.json();
        return {
          data: json.data,
          ...downsampleWaveform(json.data, PLAYER_BARS),
          norm: waveformNorm(json.bits ?? 8),
          rawLength: json.length,
        };
      })
      .catch((error) => {
        waveformRequests.delete(path);
        throw error;
      });
    waveformRequests.set(path, request);
  }
  return waveformRequests.get(path);
}

/** Warm the browser's HTTP cache with the complete audio file, without playback. */
function prefetchAudio(path) {
  if (!audioRequests.has(path)) {
    const request = fetch(`${ASSET_BASE}/${path}`)
      .then((response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return response.arrayBuffer();
      })
      .finally(() => audioRequests.delete(path));
    audioRequests.set(path, request);
  }
  return audioRequests.get(path);
}

/** Speculative failures stay silent and can be retried when the entry is opened. */
export function prefetchPlayerAssets(entry) {
  return Promise.allSettled([
    ...(entry?.waveformPath ? [loadPlayerWaveform(entry.waveformPath)] : []),
    ...(entry?.audioPath ? [prefetchAudio(entry.audioPath)] : []),
  ]);
}
