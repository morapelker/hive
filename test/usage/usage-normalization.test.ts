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
    expect(usage?.five_hour.utilization).toBe(0)
    expect(usage?.five_hour.resets_at).toBeNull()
    expect(usage?.seven_day.utilization).toBe(66)
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
    expect(usage?.seven_day.utilization).toBe(40)
  })

  it('treats Anthropic usage with a null quota window as unavailable', () => {
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

    expect(usage).toBeNull()
  })
})
