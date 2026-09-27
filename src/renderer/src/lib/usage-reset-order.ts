import type { UsageData } from '@shared/types/usage'

// Sort key for ordering accounts by when they free up. Windows are compared
// in order of how long they take to recover: the 7d window first, then the
// Fable (scoped) window, then the 5h window. An account whose 7d window
// resets sooner always ranks ahead; the later keys only break ties.
//
// A window with no active session (null resets_at) or whose cached reset time
// has already passed is treated as "available now" (0) so it sorts first.
// An account with no usage snapshot at all is unknown and sorts last.

const AVAILABLE_NOW = 0
const UNKNOWN = Number.POSITIVE_INFINITY

function resetAtMs(resetsAt: string | null | undefined, nowMs: number): number {
  if (!resetsAt) return AVAILABLE_NOW
  const time = new Date(resetsAt).getTime()
  if (isNaN(time) || time <= nowMs) return AVAILABLE_NOW
  return time
}

// The Fable window when the API reports one; otherwise the soonest of any
// other scoped (per-model) windows; otherwise "available now".
function scopedResetAtMs(usage: UsageData, nowMs: number): number {
  const scoped = usage.scoped ?? []
  const fable = scoped.find((s) => s.label.toLowerCase() === 'fable')
  if (fable) return resetAtMs(fable.resets_at, nowMs)
  if (scoped.length === 0) return AVAILABLE_NOW
  return Math.min(...scoped.map((s) => resetAtMs(s.resets_at, nowMs)))
}

export function usageResetSortKey(usage: UsageData | null, nowMs: number): number[] {
  if (!usage) return [UNKNOWN, UNKNOWN, UNKNOWN]
  return [
    resetAtMs(usage.seven_day?.resets_at, nowMs),
    scopedResetAtMs(usage, nowMs),
    resetAtMs(usage.five_hour?.resets_at, nowMs)
  ]
}

/** Comparator: accounts that reset soonest (7d, then Fable, then 5h) first. */
export function compareByResetTime(
  a: UsageData | null,
  b: UsageData | null,
  nowMs: number
): number {
  const keyA = usageResetSortKey(a, nowMs)
  const keyB = usageResetSortKey(b, nowMs)
  for (let i = 0; i < keyA.length; i++) {
    if (keyA[i] !== keyB[i]) return keyA[i] - keyB[i]
  }
  return 0
}
