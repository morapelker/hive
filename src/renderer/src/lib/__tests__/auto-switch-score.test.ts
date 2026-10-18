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
        : { ...data, seven_day: { ...data.seven_day, resets_at: sevenDayResetsAt } }
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
