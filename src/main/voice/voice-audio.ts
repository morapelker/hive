/**
 * Pure PCM helpers for the dictation controller. Mono Float32 samples in [-1, 1].
 * (The worker's long-clip windowing lives in voice-windows.ts so the worker
 * bundle has no shared chunks.)
 */

/** Digital silence (a muted or missing input) would only make the model hallucinate. */
const SILENCE_RMS = 1e-4
/** Leading/trailing audio quieter than this (−50 dBFS) is trimmed before transcription. */
const TRIM_RMS = 0.00316
const TRIM_FRAME_MS = 20
const TRIM_PADDING_MS = 120

export function rms(samples: Float32Array, from = 0, to = samples.length): number {
  const start = Math.max(0, from)
  const end = Math.min(samples.length, to)
  if (end <= start) return 0
  let energy = 0
  for (let i = start; i < end; i++) energy += samples[i] * samples[i]
  return Math.sqrt(energy / (end - start))
}

export function isDigitalSilence(samples: Float32Array): boolean {
  return rms(samples) < SILENCE_RMS
}

/** Drop the key-press noise and dead air at both ends, keeping a little padding. */
export function trimSilence(samples: Float32Array, sampleRate: number): Float32Array {
  const frame = Math.max(1, Math.round((TRIM_FRAME_MS / 1000) * sampleRate))
  const padding = Math.round((TRIM_PADDING_MS / 1000) * sampleRate)
  let first = 0
  while (first < samples.length && rms(samples, first, first + frame) < TRIM_RMS) first += frame
  if (first >= samples.length) return new Float32Array(0)
  let last = samples.length
  while (last > first && rms(samples, Math.max(first, last - frame), last) < TRIM_RMS) last -= frame
  const start = Math.max(0, first - padding)
  const end = Math.min(samples.length, last + padding)
  return samples.subarray(start, end)
}
