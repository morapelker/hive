import type { SavedUsageStatus, ScopedUsageWindow, UsageData } from '@shared/types/usage'

// How much each window's remaining headroom counts toward an account's score.
// The 5h window dominates when the plan has one: it resets within hours, so
// headroom there is worth the most right now, while weekly and per-model
// (Fable/Opus) windows recover slowly. Anthropic dropped the 5h limit from
// many plans (the usage API then reports `five_hour: null`), and a window the
// account doesn't have is left out of the score: weights are renormalized over
// the windows that exist, as they already are for an account with no scoped
// windows.
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

// The windows the account actually has, as one list. `five_hour` / `seven_day`
// are null on plans without that limit (null means "no window", not
// "unknown"), so a null slot is dropped rather than read as 0% or 100% used.
function accountWindows(usage: UsageData): WindowLike[] {
  const slots: (WindowLike | null)[] = [
    usage.five_hour,
    usage.seven_day,
    ...(usage.scoped ?? []).map((s) => ({ utilization: s.used_percent, resets_at: s.resets_at }))
  ]
  return slots.filter((w): w is WindowLike => w !== null)
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
 * scoped model windows), skipping windows the plan doesn't have (null) and
 * windows whose snapshot predates their own reset. Null when no window has
 * current data.
 */
export function getMaxUsagePercent(usage: UsageData, nowMs: number): number | null {
  const windows = accountWindows(usage).filter((w) => !hasResetSince(w.resets_at, nowMs))
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
  return accountWindows(usage).some((w) => {
    if (w.utilization < thresholdPercent) return false
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
 * component uses the WORST model window for the same reason. Only the windows
 * the plan has take part: a null 5h/7d slot contributes neither headroom nor
 * weight.
 */
export function scoreAccountHeadroom(usage: UsageData, nowMs: number): number {
  const components: { headroom: number; weight: number }[] = []
  if (usage.five_hour) {
    components.push({ headroom: headroom(usage.five_hour, nowMs), weight: FIVE_HOUR_WEIGHT })
  }
  if (usage.seven_day) {
    components.push({ headroom: headroom(usage.seven_day, nowMs), weight: SEVEN_DAY_WEIGHT })
  }

  const scoped = usage.scoped ?? []
  if (scoped.length > 0) {
    const worst = Math.min(
      ...scoped.map((s) => headroom({ utilization: s.used_percent, resets_at: s.resets_at }, nowMs))
    )
    components.push({ headroom: worst, weight: SCOPED_WEIGHT })
  }

  // No window at all (both slots null, nothing scoped): nothing reported can
  // run out, so the account has full headroom — and the renormalization
  // below never divides by a zero total weight.
  if (components.length === 0) return 100

  const totalWeight = components.reduce((sum, c) => sum + c.weight, 0)
  return components.reduce(
    (score, c) => score * Math.pow(c.headroom, c.weight / totalWeight),
    1
  )
}

// A candidate is "comfortable" when every window sits at least this many
// points below the armed threshold (under 80% for a 90% threshold): hopping
// there buys real runway instead of re-triggering a few prompts later.
export const AUTO_SWITCH_TARGET_MARGIN_PERCENT = 10

// When the account's running 7-day window resets; Infinity when none is
// running (the plan reports no weekly window, or the reset time is missing,
// invalid or already passed — the weekly usage is fresh, so nothing there is
// about to expire).
function sevenDayResetMs(usage: UsageData, nowMs: number): number {
  const resetsAt = usage.seven_day?.resets_at
  if (!resetsAt) return Infinity
  const time = new Date(resetsAt).getTime()
  return isNaN(time) || time < nowMs ? Infinity : time
}

/**
 * Picks the auto-switch target among eligible candidates (all already below
 * `thresholdPercent`). Comfortable candidates — every window at least
 * AUTO_SWITCH_TARGET_MARGIN_PERCENT points under the threshold — win, and
 * among them the one whose 7-day window resets soonest: its remaining weekly
 * usage is the first to expire, so it gets burned first, while accounts with
 * no running weekly window are kept in reserve. Ties go to the higher
 * headroom score. With no comfortable candidate the pick falls back to the
 * best headroom score. Null when there are no candidates.
 */
export function pickAutoSwitchTarget<T extends { usage: UsageData }>(
  candidates: T[],
  thresholdPercent: number,
  nowMs: number
): T | null {
  const byHeadroomDesc = (a: T, b: T): number =>
    scoreAccountHeadroom(b.usage, nowMs) - scoreAccountHeadroom(a.usage, nowMs)

  const comfortable = candidates.filter((c) => {
    const maxPercent = getMaxUsagePercent(c.usage, nowMs)
    return maxPercent !== null && maxPercent < thresholdPercent - AUTO_SWITCH_TARGET_MARGIN_PERCENT
  })
  if (comfortable.length > 0) {
    return [...comfortable].sort((a, b) => {
      const resetA = sevenDayResetMs(a.usage, nowMs)
      const resetB = sevenDayResetMs(b.usage, nowMs)
      // Infinity - Infinity is NaN, so equal resets must short-circuit.
      return resetA === resetB ? byHeadroomDesc(a, b) : resetA - resetB
    })[0]
  }
  return [...candidates].sort(byHeadroomDesc)[0] ?? null
}

/** Why an account the user removed from auto-switch can't be its target. */
export const AUTO_SWITCH_EXCLUDED_REASON = 'Removed from auto-switch — never an auto-switch target'

/**
 * Why an account can't be an auto-switch target right now, mirroring the
 * candidate filter in useAccountScheduleStore's sweep: the account must not be
 * removed from auto-switch, the token must be valid and every usage window
 * must sit below the armed threshold. Null when
 * the account is (or may turn out to be, once refreshed) a viable target —
 * unknown usage is not dimmed since the sweep refreshes it before deciding.
 * The active account is never a candidate, but it's the one being left, so
 * it isn't dimmed either.
 */
export function autoSwitchIneligibilityReason(
  row: { usage: UsageData | null; status: SavedUsageStatus; isActive: boolean },
  thresholdPercent: number | undefined,
  nowMs: number,
  ignoreFable = false,
  excludedFromAutoSwitch = false
): string | null {
  if (thresholdPercent === undefined || row.isActive) return null
  if (excludedFromAutoSwitch) return AUTO_SWITCH_EXCLUDED_REASON
  if (row.status === 'stale') return 'Expired — not an auto-switch target'
  if (row.status === 'error') return 'Refresh failed — not an auto-switch target'
  if (!row.usage) return null
  const maxPercent = getMaxUsagePercent(autoSwitchUsage(row.usage, ignoreFable), nowMs)
  if (maxPercent !== null && maxPercent >= thresholdPercent) {
    return `At ${Math.round(maxPercent)}% — auto-switch only targets accounts below ${thresholdPercent}%`
  }
  return null
}
