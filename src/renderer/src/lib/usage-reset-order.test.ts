import { describe, expect, it } from 'vitest'

import { compareByResetTime, usageResetSortKey } from './usage-reset-order'
import type { UsageData } from '@shared/types/usage'

const now = Date.parse('2026-09-07T12:00:00Z')
const at = (hours: number): string => new Date(now + hours * 60 * 60 * 1000).toISOString()

function usage(
  sevenDay: string | null,
  fiveHour: string | null,
  scoped?: UsageData['scoped']
): UsageData {
  return {
    five_hour: { utilization: 10, resets_at: fiveHour },
    seven_day: { utilization: 10, resets_at: sevenDay },
    ...(scoped ? { scoped } : {})
  }
}

function sorted(accounts: Record<string, UsageData | null>): string[] {
  return Object.entries(accounts)
    .sort(([, a], [, b]) => compareByResetTime(a, b, now))
    .map(([name]) => name)
}

describe('compareByResetTime', () => {
  it('orders by the 7d reset first, soonest at the top', () => {
    expect(
      sorted({
        late: usage(at(100), at(1)),
        soon: usage(at(24), at(4)),
        mid: usage(at(48), at(2))
      })
    ).toEqual(['soon', 'mid', 'late'])
  })

  it('breaks 7d ties on the Fable window, then on the 5h window', () => {
    const sevenDay = at(72)
    expect(
      sorted({
        fableLate: usage(sevenDay, at(1), [
          { label: 'Fable', used_percent: 50, resets_at: at(60) }
        ]),
        fableSoon: usage(sevenDay, at(4), [
          { label: 'Fable', used_percent: 50, resets_at: at(30) }
        ]),
        fiveHourLate: usage(sevenDay, at(3)),
        fiveHourSoon: usage(sevenDay, at(2))
      })
    ).toEqual(['fiveHourSoon', 'fiveHourLate', 'fableSoon', 'fableLate'])
  })

  it('treats null and already-passed reset times as available now', () => {
    expect(
      sorted({
        future: usage(at(24), at(1)),
        idle: usage(null, null),
        alreadyReset: usage(at(-1), at(-1))
      })
    ).toEqual(['idle', 'alreadyReset', 'future'])
  })

  it('puts accounts with no usage snapshot last', () => {
    expect(sorted({ unknown: null, known: usage(at(150), at(4)) })).toEqual(['known', 'unknown'])
    expect(usageResetSortKey(null, now).every((k) => k === Number.POSITIVE_INFINITY)).toBe(true)
  })

  it('falls back to the soonest other scoped window when there is no Fable window', () => {
    const key = usageResetSortKey(
      usage(at(72), at(1), [
        { label: 'Opus', used_percent: 50, resets_at: at(40) },
        { label: 'Sonnet', used_percent: 50, resets_at: at(20) }
      ]),
      now
    )
    expect(key[1]).toBe(Date.parse(at(20)))
  })
})
