import type { TextSlotValue } from '@lottiefiles/dotlottie-web'
import type { PetManifest } from '@shared/types/pet'

/** Text stays inside the Lottie rig, so it follows the animated cape at every frame. */
export function sessionCounterSlots(
  counter: PetManifest['workingSessionCounter'],
  workingSessionCount: number
): Record<string, TextSlotValue> | undefined {
  if (!counter || !Number.isFinite(workingSessionCount)) return undefined
  const count = Math.max(0, Math.floor(workingSessionCount))
  if (count < counter.minSessions) return undefined

  const text = count.toLocaleString('en-US', { useGrouping: false })
  return {
    [counter.slotId]: {
      t: text,
      s: counter.fontSize * Math.min(1, counter.fullSizeDigits / text.length)
    }
  }
}
