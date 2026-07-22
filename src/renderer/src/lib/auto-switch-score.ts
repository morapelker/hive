import type { UsageData } from '@shared/types/usage'

// How much each window's remaining headroom counts toward an account's score.
// The 5h window dominates: it resets within hours, so headroom there is worth
// the most right now, while weekly and per-model (Fable/Opus) windows recover
// slowly. Weights are renormalized when an account has no scoped windows.
const FIVE_HOUR_WEIGHT = 0.5
const SEVEN_DAY_WEIGHT = 0.25
const SCOPED_WEIGHT = 0.25

interface WindowLike {
  utilization: number
  resets_at: string | null
}

// A reset time in the past means the cached utilization predates the window's
// reset: the window is empty again. null is NOT stale — it means "no active
// window" (same rule as UsageIndicator / useAccountScheduleStore).
function hasResetSince(resetsAt: string | null | undefined, nowMs: number): boolean {
  if (!resetsAt) return false
  const time = new Date(resetsAt).getTime()
  return !isNaN(time) && time < nowMs
}

function headroom(window: WindowLike, nowMs: number): number {
  if (hasResetSince(window.resets_at, nowMs)) return 100
  return Math.min(100, Math.max(0, 100 - window.utilization))
}

/**
 * Highest current utilization across an account's usage windows (5h, 7d and
 * scoped model windows), skipping windows whose snapshot predates their own
 * reset. Null when no window has current data.
 */
export function getMaxUsagePercent(usage: UsageData, nowMs: number): number | null {
  const windows: WindowLike[] = [
    usage.five_hour,
    usage.seven_day,
    ...(usage.scoped ?? []).map((s) => ({ utilization: s.used_percent, resets_at: s.resets_at }))
  ].filter((w) => w && !hasResetSince(w.resets_at, nowMs))
  if (windows.length === 0) return null
  return Math.max(...windows.map((w) => w.utilization))
}

/**
 * 0-100 "how long will this account last" score used to pick the auto-switch
 * target: a weighted geometric mean of each window's remaining headroom.
 * Geometric (not arithmetic) so a single nearly-exhausted window drags the
 * score toward 0 no matter how empty the others are — an account at 95% Fable
 * usage must not win on the strength of an untouched 5h window. The scoped
 * component uses the WORST model window for the same reason.
 */
export function scoreAccountHeadroom(usage: UsageData, nowMs: number): number {
  const components: { headroom: number; weight: number }[] = [
    { headroom: headroom(usage.five_hour, nowMs), weight: FIVE_HOUR_WEIGHT },
    { headroom: headroom(usage.seven_day, nowMs), weight: SEVEN_DAY_WEIGHT }
  ]

  const scoped = usage.scoped ?? []
  if (scoped.length > 0) {
    const worst = Math.min(
      ...scoped.map((s) => headroom({ utilization: s.used_percent, resets_at: s.resets_at }, nowMs))
    )
    components.push({ headroom: worst, weight: SCOPED_WEIGHT })
  }

  const totalWeight = components.reduce((sum, c) => sum + c.weight, 0)
  return components.reduce(
    (score, c) => score * Math.pow(c.headroom, c.weight / totalWeight),
    1
  )
}
