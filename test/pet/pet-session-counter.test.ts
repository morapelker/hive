import { describe, expect, it } from 'vitest'
import { sessionCounterSlots } from '@/pet/sessionCounter'

const counter = { slotId: 'session-count', minSessions: 5, fontSize: 90, fullSizeDigits: 2 }

describe('session counter text', () => {
  it('preserves the exact count and fits longer numbers into the same space', () => {
    for (const count of [5, 6, 7, 8, 9, 10, 20, 100, 1000, Number.MAX_SAFE_INTEGER]) {
      const slot = sessionCounterSlots(counter, count)?.['session-count']
      expect(slot?.t).toBe(String(count))
      expect(slot?.s).toBeGreaterThan(0)
      expect(slot!.t!.length * slot!.s!).toBeLessThanOrEqual(180)
    }
  })

  it('does not override text for pets without counters or below the first numbered style', () => {
    expect(sessionCounterSlots(undefined, 20)).toBeUndefined()
    for (const count of [-1, 0, 1, 4, NaN, Infinity]) {
      expect(sessionCounterSlots(counter, count)).toBeUndefined()
    }
  })

  it('supports other pets with their own slot name, threshold, and typography', () => {
    expect(
      sessionCounterSlots({ slotId: 'badge', minSessions: 1, fontSize: 60, fullSizeDigits: 1 }, 42)
    ).toEqual({ badge: { t: '42', s: 30 } })
  })
})
