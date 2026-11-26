/** One amplification level for the clip, followed by optional per-section suppression. */
export function playbackGainCurve(waveData, {
  amplify = true, suppressAmount = 0, suppressCutoff = 0, startFraction = 0, endFraction = 1,
} = {}) {
  if (!waveData?.maxs?.length || !(waveData.norm > 0)) return null;
  const peaks = waveData.maxs.map((maximum, i) => {
    const peak = Math.min(1, Math.max(Math.abs(maximum), Math.abs(waveData.mins?.[i] ?? 0)) / waveData.norm);
    return Number.isFinite(peak) ? peak : 0;
  });
  const start = Math.max(0, Math.floor(startFraction * peaks.length));
  const end = Math.min(peaks.length, Math.ceil(endFraction * peaks.length));
  let clipPeak = 0;
  for (let i = start; i < end; i++) clipPeak = Math.max(clipPeak, peaks[i]);
  // Normalize the visible clip's peak toward 90%, capped at 8x. The same
  // gain applies everywhere, preserving relative loudness within the clip.
  const boost = amplify && clipPeak >= 0.005 ? Math.max(1, Math.min(8, 0.9 / clipPeak)) : 1;
  return Float32Array.from(peaks, peak => {
    let attenuation = 1;
    if (suppressAmount > 0 && peak > suppressCutoff) {
      const target = Math.pow(0.0001, suppressAmount);
      attenuation = 1 + suppressAmount * (Math.min(1, target / peak) - 1);
    }
    return boost * attenuation;
  });
}

/** Web Audio permits gain above 1; create once per media element, on a user gesture. */
export function createPlaybackAudio(audioElement, Context = globalThis.AudioContext) {
  if (!Context) throw new Error('Audio adjustment is unavailable in this browser.');
  const context = new Context();
  const gain = context.createGain();
  // Final peak guard for transients between the waveform's sampled peaks.
  const limiter = context.createWaveShaper();
  limiter.curve = Float32Array.from({ length: 257 }, (_, i) => Math.max(-0.98, Math.min(0.98, i / 128 - 1)));
  limiter.connect(context.destination);
  const source = context.createMediaElementSource(audioElement);
  source.connect(gain);
  gain.connect(context.destination);
  let protectedOutput = false;
  let previousGain = null;

  return {
    resume: () => context.resume(),
    update(value, amplify) {
      if (amplify !== protectedOutput) {
        gain.disconnect();
        gain.connect(amplify ? limiter : context.destination);
        protectedOutput = amplify;
      }
      if (value !== previousGain) {
        gain.gain.cancelScheduledValues(context.currentTime);
        gain.gain.setTargetAtTime(value, context.currentTime, 0.025);
        previousGain = value;
      }
    },
    dispose() {
      source.disconnect();
      gain.disconnect();
      limiter.disconnect();
      void context.close().catch(() => {});
    },
  };
}
