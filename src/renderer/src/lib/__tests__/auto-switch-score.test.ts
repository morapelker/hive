import { describe, expect, it } from 'vitest'

import {
  autoSwitchIneligibilityReason,
  autoSwitchUsage,
  getMaxUsagePercent,
  isProvablyAtOrAbove,
  pickAutoSwitchTarget,
  scoreAccountHeadroom
} from '../auto-switch-score'
import type { UsageData } from '@shared/types/usage'

const NOW = new Date('2026-07-16T10:00:00.000Z').getTime()
const FUTURE = new Date(NOW + 3_600_000).toISOString()
const PAST = new Date(NOW - 3_600_000).toISOString()

function usage(
  fiveHour: number,
  sevenDay: number,
  scoped?: { label: string; used_percent: number; resets_at?: string | null }[]
): UsageData {
  return {
    five_hour: { utilization: fiveHour, resets_at: FUTURE },
    seven_day: { utilization: sevenDay, resets_at: FUTURE },
    ...(scoped
      ? {
          scoped: scoped.map((s) => ({
            label: s.label,
            used_percent: s.used_percent,
            resets_at: s.resets_at === undefined ? FUTURE : s.resets_at
          }))
        }
      : {})
  }
}

describe('scoreAccountHeadroom', () => {
  it('prefers an empty 5h window over better model headroom (ticket example)', () => {
    // A: 5h at 0%, Fable at 70% — B: 5h at 50%, Fable at 30%. The 5h window
    // expires quickly, so A's untouched 5h should outweigh B's fresher Fable.
    const a = scoreAccountHeadroom(usage(0, 0, [{ label: 'Fable', used_percent: 70 }]), NOW)
    const b = scoreAccountHeadroom(usage(50, 0, [{ label: 'Fable', used_percent: 30 }]), NOW)
    expect(a).toBeGreaterThan(b)
  })

  it('punishes a nearly-exhausted window harder than a plain average would', () => {
    // 95% Fable usage with everything else empty should lose to a balanced
    // account, even though its arithmetic average headroom is higher.
    const nearlyExhausted = scoreAccountHeadroom(
      usage(0, 0, [{ label: 'Fable', used_percent: 95 }]),
      NOW
    )
    const balanced = scoreAccountHeadroom(usage(50, 40, [{ label: 'Fable', used_percent: 40 }]), NOW)
    expect(balanced).toBeGreaterThan(nearlyExhausted)
  })

  it('scores zero when any window is fully exhausted', () => {
    expect(scoreAccountHeadroom(usage(100, 0), NOW)).toBe(0)
    expect(scoreAccountHeadroom(usage(0, 0, [{ label: 'Fable', used_percent: 100 }]), NOW)).toBe(0)
  })

  it('treats a window whose reset time already passed as full headroom', () => {
    const stale: UsageData = {
      five_hour: { utilization: 95, resets_at: PAST },
      seven_day: { utilization: 10, resets_at: FUTURE }
    }
    const fresh: UsageData = {
      five_hour: { utilization: 0, resets_at: FUTURE },
      seven_day: { utilization: 10, resets_at: FUTURE }
    }
    expect(scoreAccountHeadroom(stale, NOW)).toBe(scoreAccountHeadroom(fresh, NOW))
  })

  it('uses the WORST scoped window when several models are listed', () => {
    const oneBadModel = scoreAccountHeadroom(
      usage(10, 10, [
        { label: 'Opus', used_percent: 0 },
        { label: 'Fable', used_percent: 90 }
      ]),
      NOW
    )
    const allGoodModels = scoreAccountHeadroom(
      usage(10, 10, [
        { label: 'Opus', used_percent: 0 },
        { label: 'Fable', used_percent: 20 }
      ]),
      NOW
    )
    expect(allGoodModels).toBeGreaterThan(oneBadModel)
  })

  it('ranks identically-used accounts the same with or without scoped data', () => {
    // No scoped windows: score still lands on the 0-100 scale and an untouched
    // account beats a half-used one.
    expect(scoreAccountHeadroom(usage(0, 0), NOW)).toBeCloseTo(100, 9)
    expect(scoreAccountHeadroom(usage(0, 0), NOW)).toBeGreaterThan(
      scoreAccountHeadroom(usage(50, 50), NOW)
    )
  })
})

describe('pickAutoSwitchTarget', () => {
  const HOUR = 3_600_000
  const candidate = (
    id: string,
    data: UsageData,
    sevenDayResetsAt?: string | null
  ): { id: string; usage: UsageData } => ({
    id,
    usage:
      sevenDayResetsAt === undefined
        ? data
        : {
            ...data,
            seven_day: {
              utilization: data.seven_day?.utilization ?? 0,
              resets_at: sevenDayResetsAt
            }
          }
  })
  const inHours = (hours: number): string => new Date(NOW + hours * HOUR).toISOString()
  const pick = (candidates: { id: string; usage: UsageData }[], threshold = 90): string | null =>
    pickAutoSwitchTarget(candidates, threshold, NOW)?.id ?? null

  it('returns null without candidates', () => {
    expect(pick([])).toBeNull()
  })

  it('picks the comfortable account whose 7-day window resets soonest, not the emptiest', () => {
    expect(
      pick([
        candidate('emptiest', usage(0, 0), inHours(100)),
        candidate('soonest', usage(60, 70), inHours(5)),
        candidate('middle', usage(20, 20), inHours(40))
      ])
    ).toBe('soonest')
  })

  it('requires the margin on every window: 5h, 7d and scoped', () => {
    const comfortable = candidate('comfortable', usage(10, 10), inHours(100))
    // Each resets sooner, but sits within 10 points of the 90% threshold on one window.
    expect(pick([candidate('hot-5h', usage(80, 10), inHours(1)), comfortable])).toBe('comfortable')
    expect(pick([candidate('hot-7d', usage(10, 85), inHours(1)), comfortable])).toBe('comfortable')
    expect(
      pick([
        candidate('hot-fable', usage(10, 10, [{ label: 'Fable', used_percent: 80 }]), inHours(1)),
        comfortable
      ])
    ).toBe('comfortable')
    // Just inside the margin on all three wins on its sooner reset.
    expect(
      pick([
        candidate('just-inside', usage(79, 79, [{ label: 'Fable', used_percent: 79 }]), inHours(1)),
        comfortable
      ])
    ).toBe('just-inside')
  })

  it('scales the margin with the threshold', () => {
    const candidates = [
      candidate('at-65', usage(65, 10), inHours(1)),
      candidate('at-10', usage(10, 10), inHours(100))
    ]
    expect(pick(candidates, 90)).toBe('at-65')
    expect(pick(candidates, 70)).toBe('at-10')
  })

  it('ranks accounts without a running 7-day window last', () => {
    expect(
      pick([
        candidate('idle', usage(0, 0), null),
        candidate('already-reset', usage(0, 50), PAST),
        candidate('running', usage(50, 50), inHours(150))
      ])
    ).toBe('running')
  })

  it('breaks ties on the 7-day reset by headroom', () => {
    expect(
      pick([candidate('fuller', usage(50, 50), null), candidate('emptier', usage(5, 5), null)])
    ).toBe('emptier')
    expect(
      pick([
        candidate('fuller', usage(50, 50), inHours(10)),
        candidate('emptier', usage(5, 5), inHours(10))
      ])
    ).toBe('emptier')
  })

  it('falls back to the best headroom score when no account has the margin', () => {
    expect(
      pick([
        candidate('soonest-but-fuller', usage(88, 85), inHours(1)),
        candidate('most-headroom', usage(20, 82), inHours(100))
      ])
    ).toBe('most-headroom')
  })
})

describe('getMaxUsagePercent', () => {
  it('returns the highest utilization across 5h, 7d and scoped windows', () => {
    expect(getMaxUsagePercent(usage(10, 40, [{ label: 'Fable', used_percent: 65 }]), NOW)).toBe(65)
    expect(getMaxUsagePercent(usage(80, 40), NOW)).toBe(80)
  })

  it('ignores windows whose reset time already passed', () => {
    const data = usage(10, 20, [{ label: 'Fable', used_percent: 95, resets_at: PAST }])
    expect(getMaxUsagePercent(data, NOW)).toBe(20)
  })

  it('returns null when every window is stale', () => {
    const data: UsageData = {
      five_hour: { utilization: 50, resets_at: PAST },
      seven_day: { utilization: 60, resets_at: PAST }
    }
    expect(getMaxUsagePercent(data, NOW)).toBeNull()
  })
})

describe('isProvablyAtOrAbove', () => {
  it('is true when a window is at/over the threshold with a known future reset', () => {
    expect(isProvablyAtOrAbove(usage(95, 20), 90, NOW)).toBe(true)
    expect(isProvablyAtOrAbove(usage(10, 20, [{ label: 'Fable', used_percent: 100 }]), 90, NOW)).toBe(
      true
    )
  })

  it('is false when every window sits below the threshold', () => {
    expect(isProvablyAtOrAbove(usage(10, 20, [{ label: 'Fable', used_percent: 50 }]), 90, NOW)).toBe(
      false
    )
  })

  it('is false when the over-threshold window already reset', () => {
    const data: UsageData = {
      five_hour: { utilization: 100, resets_at: PAST },
      seven_day: { utilization: 10, resets_at: FUTURE }
    }
    expect(isProvablyAtOrAbove(data, 90, NOW)).toBe(false)
  })

  it('is false when the over-threshold window has no known reset horizon', () => {
    // Without a reset time there is no guarantee the number still holds — a
    // cached over-threshold reading must not exclude the account forever.
    const noHorizon: UsageData = {
      five_hour: { utilization: 95, resets_at: null },
      seven_day: { utilization: 10, resets_at: FUTURE }
    }
    expect(isProvablyAtOrAbove(noHorizon, 90, NOW)).toBe(false)

    const invalidHorizon: UsageData = {
      five_hour: { utilization: 95, resets_at: 'not-a-date' },
      seven_day: { utilization: 10, resets_at: FUTURE }
    }
    expect(isProvablyAtOrAbove(invalidHorizon, 90, NOW)).toBe(false)
  })
})

describe('ignoring Fable', () => {
  const fableMaxed = usage(10, 20, [
    { label: 'Fable', used_percent: 100 },
    { label: 'Opus', used_percent: 30 }
  ])

  it('drops only the Fable window when ignoreFable is on', () => {
    expect(autoSwitchUsage(fableMaxed, false)).toBe(fableMaxed)
    expect(autoSwitchUsage(fableMaxed, true).scoped?.map((s) => s.label)).toEqual(['Opus'])
    expect(getMaxUsagePercent(autoSwitchUsage(fableMaxed, true), NOW)).toBe(30)
    expect(isProvablyAtOrAbove(autoSwitchUsage(fableMaxed, true), 90, NOW)).toBe(false)
    expect(scoreAccountHeadroom(autoSwitchUsage(fableMaxed, true), NOW)).toBeGreaterThan(0)
  })

  it('no longer marks a Fable-exhausted account as "Not a switch target"', () => {
    const row = { usage: fableMaxed, status: 'ok' as const, isActive: false }
    expect(autoSwitchIneligibilityReason(row, 90, NOW)).toMatch(/At 100%/)
    expect(autoSwitchIneligibilityReason(row, 90, NOW, true)).toBeNull()
  })
})

describe('autoSwitchIneligibilityReason for accounts removed from auto-switch', () => {
  const row = { usage: usage(10, 10), status: 'ok' as const, isActive: false }

  it('names the removal once auto-switch is armed, even with plenty of headroom', () => {
    expect(autoSwitchIneligibilityReason(row, 90, NOW, false, true)).toMatch(
      /removed from auto-switch/i
    )
    expect(autoSwitchIneligibilityReason(row, 90, NOW, false, false)).toBeNull()
  })

  it('stays silent while auto-switch is off or for the active account', () => {
    expect(autoSwitchIneligibilityReason(row, undefined, NOW, false, true)).toBeNull()
    expect(
      autoSwitchIneligibilityReason({ ...row, isActive: true }, 90, NOW, false, true)
    ).toBeNull()
  })
})

describe('plans without a 5h window (five_hour: null)', () => {
  // Anthropic dropped the 5h limit from many plans: the usage API then reports
  // `five_hour: null` (and `seven_day: null` is the same shape for the weekly
  // window). Null means "no such window", not "unknown" — it must neither
  // crash the scoring nor read as an empty or exhausted window.
  const window = (
    utilization: number,
    resetsAt: string | null = FUTURE
  ): UsageData['five_hour'] => ({
    utilization,
    resets_at: resetsAt
  })

  it('scores only the windows the plan has, renormalizing the weights', () => {
    // 7d and Fable carry equal weight once the 5h share is gone: the score is
    // the geometric mean of their headrooms (100 and 50).
    const noFiveHour: UsageData = {
      five_hour: null,
      seven_day: window(0),
      scoped: [{ label: 'Fable', used_percent: 50, resets_at: FUTURE }]
    }
    expect(scoreAccountHeadroom(noFiveHour, NOW)).toBeCloseTo(Math.sqrt(100 * 50), 6)
    // Only a weekly window: its headroom IS the score.
    expect(scoreAccountHeadroom({ five_hour: null, seven_day: window(30) }, NOW)).toBeCloseTo(70, 9)
    // The null slot is not a free untouched window: an exhausted 7d still zeroes it.
    expect(scoreAccountHeadroom({ five_hour: null, seven_day: window(100) }, NOW)).toBe(0)
  })

  it('scores an account with no window at all as full headroom, never NaN', () => {
    const score = scoreAccountHeadroom({ five_hour: null, seven_day: null }, NOW)
    expect(Number.isNaN(score)).toBe(false)
    expect(score).toBe(100)
  })

  it('getMaxUsagePercent ignores null windows', () => {
    expect(
      getMaxUsagePercent(
        {
          five_hour: null,
          seven_day: window(40),
          scoped: [{ label: 'Fable', used_percent: 65, resets_at: FUTURE }]
        },
        NOW
      )
    ).toBe(65)
    expect(getMaxUsagePercent({ five_hour: null, seven_day: window(40) }, NOW)).toBe(40)
    expect(getMaxUsagePercent({ five_hour: window(40), seven_day: null }, NOW)).toBe(40)
    expect(getMaxUsagePercent({ five_hour: null, seven_day: null }, NOW)).toBeNull()
  })

  it('isProvablyAtOrAbove ignores null windows', () => {
    expect(isProvablyAtOrAbove({ five_hour: null, seven_day: window(95) }, 90, NOW)).toBe(true)
    expect(isProvablyAtOrAbove({ five_hour: null, seven_day: window(10) }, 90, NOW)).toBe(false)
    expect(isProvablyAtOrAbove({ five_hour: null, seven_day: null }, 90, NOW)).toBe(false)
  })

  it('pickAutoSwitchTarget treats a null 7d window as no running weekly window', () => {
    const HOUR = 3_600_000
    const inHours = (hours: number): string => new Date(NOW + hours * HOUR).toISOString()
    const pick = (candidates: { id: string; usage: UsageData }[]): string | null =>
      pickAutoSwitchTarget(candidates, 90, NOW)?.id ?? null

    // Like an idle weekly window, a plan without one is kept in reserve.
    expect(
      pick([
        { id: 'no-weekly', usage: { five_hour: window(0), seven_day: null } },
        { id: 'running', usage: usage(50, 50) }
      ])
    ).toBe('running')
    // A no-5h account competes on its weekly reset like any other.
    expect(
      pick([
        { id: 'no-5h', usage: { five_hour: null, seven_day: window(10, inHours(5)) } },
        { id: 'has-5h', usage: { five_hour: window(10), seven_day: window(10, inHours(100)) } }
      ])
    ).toBe('no-5h')
  })

  it('autoSwitchIneligibilityReason reads the remaining windows', () => {
    const hot = {
      usage: { five_hour: null, seven_day: window(95) },
      status: 'ok' as const,
      isActive: false
    }
    expect(autoSwitchIneligibilityReason(hot, 90, NOW)).toMatch(/At 95%/)
    const cool = { ...hot, usage: { five_hour: null, seven_day: window(10) } }
    expect(autoSwitchIneligibilityReason(cool, 90, NOW)).toBeNull()
  })
})
