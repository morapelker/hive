import { describe, expect, it } from 'vitest'

import { getMaxUsagePercent, scoreAccountHeadroom } from '../auto-switch-score'
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
