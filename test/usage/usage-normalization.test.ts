import { describe, expect, it } from 'vitest'

import { normalizeUsage } from '@/stores/useUsageStore'

describe('normalizeUsage', () => {
  it('treats malformed Anthropic usage as unavailable', () => {
    const usage = normalizeUsage(
      'anthropic',
      {
        type: 'error',
        message: 'An unexpected error occurred'
      } as never,
      null
    )

    expect(usage).toBeNull()
  })

  it('keeps Anthropic usage whose idle window has a null resets_at (real API shape)', () => {
    // The usage API returns { utilization: 0, resets_at: null } for a window with
    // no active session — e.g. an account that hasn't started a 5h block. The
    // seven_day data is real and must not be discarded.
    const usage = normalizeUsage(
      'anthropic',
      {
        five_hour: { utilization: 0, resets_at: null },
        seven_day: { utilization: 66, resets_at: '2026-07-10T01:59:59.752656+00:00' }
      } as never,
      null
    )

    expect(usage).not.toBeNull()
    expect(usage?.five_hour?.utilization).toBe(0)
    expect(usage?.five_hour?.resets_at).toBeNull()
    expect(usage?.seven_day?.utilization).toBe(66)
  })

  it('keeps Anthropic usage whose window omits resets_at entirely', () => {
    const usage = normalizeUsage(
      'anthropic',
      {
        five_hour: { utilization: 12 },
        seven_day: { utilization: 40, resets_at: '2026-07-10T01:59:59.000Z' }
      } as never,
      null
    )

    expect(usage).not.toBeNull()
    expect(usage?.seven_day?.utilization).toBe(40)
  })

  it('keeps Anthropic usage whose plan has no 5h window (five_hour: null, real API shape)', () => {
    // Anthropic dropped the 5h limit from many plans: `/api/oauth/usage` then
    // sends `five_hour: null` next to a real seven_day window. Null means "no
    // such window", not "unknown" — the snapshot is valid and the null must
    // survive as null so the UI can hide the 5h bar.
    const snapshot = {
      five_hour: null,
      seven_day: { utilization: 6, resets_at: '2026-11-06T15:00:00.000377+00:00' }
    }
    const usage = normalizeUsage('anthropic', snapshot as never, null)

    expect(usage).not.toBeNull()
    expect(usage?.five_hour).toBeNull()
    expect(usage?.seven_day?.utilization).toBe(6)
    expect(usage).toEqual(snapshot)
  })

  it('keeps Anthropic usage whose plan reports no weekly window (seven_day: null)', () => {
    const usage = normalizeUsage(
      'anthropic',
      {
        five_hour: {
          utilization: 12,
          resets_at: '2026-04-29T18:00:00.000Z'
        },
        seven_day: null
      } as never,
      null
    )

    expect(usage).not.toBeNull()
    expect(usage?.five_hour?.utilization).toBe(12)
    expect(usage?.seven_day).toBeNull()
  })

  it('rejects an Anthropic body missing a window key (not the usage shape)', () => {
    // The endpoint always sends both keys (each an object or null); a body
    // without one is something else — an error envelope — not a snapshot
    // with "no window".
    const sevenDay = { utilization: 6, resets_at: '2026-11-06T15:00:00.000Z' }
    expect(normalizeUsage('anthropic', { seven_day: sevenDay } as never, null)).toBeNull()
    expect(
      normalizeUsage('anthropic', { five_hour: { utilization: 1, resets_at: null } } as never, null)
    ).toBeNull()
    expect(
      normalizeUsage('anthropic', { five_hour: undefined, seven_day: sevenDay } as never, null)
    ).toBeNull()
  })

  it('rejects a window slot that is neither null nor a window', () => {
    const sevenDay = { utilization: 6, resets_at: '2026-11-06T15:00:00.000Z' }
    expect(
      normalizeUsage('anthropic', { five_hour: 'nope', seven_day: sevenDay } as never, null)
    ).toBeNull()
    expect(
      normalizeUsage(
        'anthropic',
        { five_hour: { resets_at: null }, seven_day: sevenDay } as never,
        null
      )
    ).toBeNull()
    expect(
      normalizeUsage(
        'anthropic',
        { five_hour: null, seven_day: { utilization: 6, resets_at: 42 } } as never,
        null
      )
    ).toBeNull()
  })
})
