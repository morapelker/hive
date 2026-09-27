import type { SavedUsageStatus, ScopedUsageWindow, UsageData } from '@shared/types/usage'

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

export function isFableWindow(window: ScopedUsageWindow): boolean {
  return window.label.toLowerCase() === 'fable'
}

/**
 * The usage auto-switch should reason about: with Settings › "Ignore Fable
 * usage for auto-switch" on, the Fable window is dropped so it neither
 * triggers a switch, disqualifies a candidate, nor drags its score down.
 */
export function autoSwitchUsage(usage: UsageData, ignoreFable: boolean): UsageData {
  if (!ignoreFable || !usage.scoped?.some(isFableWindow)) return usage
  return { ...usage, scoped: usage.scoped.filter((s) => !isFableWindow(s)) }
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
 * True when the account provably sits at/over `thresholdPercent` right now:
 * some window's cached utilization is at/over it AND that window's reset time
 * is known to still be in the future — utilization only accrues until a
 * window resets, so a refresh cannot reveal a viable account. A window whose
 * reset time is null, invalid, or already passed offers no such guarantee and
 * never qualifies. Used to skip pointless refreshes in the auto-switch sweep.
 */
export function isProvablyAtOrAbove(
  usage: UsageData,
  thresholdPercent: number,
  nowMs: number
): boolean {
  const windows: WindowLike[] = [
    usage.five_hour,
    usage.seven_day,
    ...(usage.scoped ?? []).map((s) => ({ utilization: s.used_percent, resets_at: s.resets_at }))
  ]
  return windows.some((w) => {
    if (!w || w.utilization < thresholdPercent) return false
    if (!w.resets_at) return false
    const resetTime = new Date(w.resets_at).getTime()
    return !isNaN(resetTime) && resetTime > nowMs
  })
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

/**
 * Why an account can't be an auto-switch target right now, mirroring the
 * candidate filter in useAccountScheduleStore's sweep: the token must be
 * valid and every usage window must sit below the armed threshold. Null when
 * the account is (or may turn out to be, once refreshed) a viable target —
 * unknown usage is not dimmed since the sweep refreshes it before deciding.
 * The active account is never a candidate, but it's the one being left, so
 * it isn't dimmed either.
 */
export function autoSwitchIneligibilityReason(
  row: { usage: UsageData | null; status: SavedUsageStatus; isActive: boolean },
  thresholdPercent: number | undefined,
  nowMs: number,
  ignoreFable = false
): string | null {
  if (thresholdPercent === undefined || row.isActive) return null
  if (row.status === 'stale') return 'Expired — not an auto-switch target'
  if (row.status === 'error') return 'Refresh failed — not an auto-switch target'
  if (!row.usage) return null
  const maxPercent = getMaxUsagePercent(autoSwitchUsage(row.usage, ignoreFable), nowMs)
  if (maxPercent !== null && maxPercent >= thresholdPercent) {
    return `At ${Math.round(maxPercent)}% — auto-switch only targets accounts below ${thresholdPercent}%`
  }
  return null
}
