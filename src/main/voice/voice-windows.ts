/**
 * Long-clip windowing for the speech engine worker. Kept in its own module
 * (only the worker imports it) so the worker bundle stays self-contained: it
 * is unpacked from the asar in packaged builds and must not depend on shared
 * chunks that stay inside the archive.
 *
 * Encoder memory grows super-linearly with utterance length (about 2.5 GB at
 * one minute, 5 GB at five), so long recordings are decoded in windows of
 * roughly 15 s — the same size FluidAudio uses — cut at the quietest point
 * near each boundary so words are not split.
 */
const TARGET_WINDOW_SECONDS = 15
const BOUNDARY_SEARCH_SECONDS = 2.5
const ENERGY_FRAME_MS = 20

function frameEnergy(samples: Float32Array, from: number, to: number): number {
  let energy = 0
  for (let i = from; i < to; i++) energy += samples[i] * samples[i]
  return energy
}

function quietestIndex(samples: Float32Array, from: number, to: number, frame: number): number {
  let best = from
  let bestEnergy = Number.POSITIVE_INFINITY
  for (let start = from; start + frame <= to; start += frame) {
    const energy = frameEnergy(samples, start, start + frame)
    if (energy < bestEnergy) {
      bestEnergy = energy
      best = start + Math.floor(frame / 2)
    }
  }
  return best
}

/** Split a long clip into ~15 s windows at the quietest point near each boundary. */
export function splitIntoWindows(samples: Float32Array, sampleRate: number): Float32Array[] {
  const target = Math.round(TARGET_WINDOW_SECONDS * sampleRate)
  if (samples.length <= target * 1.25) return [samples]
  const search = Math.round(BOUNDARY_SEARCH_SECONDS * sampleRate)
  const frame = Math.max(1, Math.round((ENERGY_FRAME_MS / 1000) * sampleRate))
  const windows: Float32Array[] = []
  let start = 0
  while (samples.length - start > target * 1.25) {
    const nominal = start + target
    const cut = quietestIndex(
      samples,
      Math.max(start + frame, nominal - search),
      Math.min(samples.length - frame, nominal + search),
      frame
    )
    windows.push(samples.subarray(start, cut))
    start = cut
  }
  windows.push(samples.subarray(start))
  return windows
}
