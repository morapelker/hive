import { describe, it, expect, beforeEach, vi } from 'vitest'
import { BruteForceTracker } from '../../src/server/plugins/auth'

describe('BruteForceTracker', () => {
  let tracker: BruteForceTracker

  beforeEach(() => {
    tracker = new BruteForceTracker({
      maxAttempts: 5,
      windowMs: 60_000,
      blockMs: 300_000
    })
  })

  it('allows requests below threshold', () => {
    for (let i = 0; i < 4; i++) {
      tracker.recordFailure('192.168.1.1')
    }
    expect(tracker.isBlocked('192.168.1.1')).toBe(false)
  })

  it('blocks IP after reaching max attempts', () => {
    for (let i = 0; i < 5; i++) {
      tracker.recordFailure('192.168.1.1')
    }
    expect(tracker.isBlocked('192.168.1.1')).toBe(true)
  })

  it('returns true from isBlocked during block period', () => {
    for (let i = 0; i < 5; i++) {
      tracker.recordFailure('10.0.0.1')
    }
    expect(tracker.isBlocked('10.0.0.1')).toBe(true)
  })

  it('unblocks after block period expires', () => {
    const now = Date.now()
    vi.spyOn(Date, 'now').mockReturnValue(now)

    for (let i = 0; i < 5; i++) {
      tracker.recordFailure('10.0.0.2')
    }
    expect(tracker.isBlocked('10.0.0.2')).toBe(true)

    // Advance time past block period
    vi.spyOn(Date, 'now').mockReturnValue(now + 300_001)
    expect(tracker.isBlocked('10.0.0.2')).toBe(false)

    vi.restoreAllMocks()
  })

  it('tracks different IPs independently', () => {
    for (let i = 0; i < 5; i++) {
      tracker.recordFailure('1.1.1.1')
    }
    expect(tracker.isBlocked('1.1.1.1')).toBe(true)
    expect(tracker.isBlocked('2.2.2.2')).toBe(false)
  })

  it('does not track successful auth (recordSuccess clears)', () => {
    for (let i = 0; i < 3; i++) {
      tracker.recordFailure('3.3.3.3')
    }
    tracker.recordSuccess('3.3.3.3')
    // After success, counter should be cleared
    expect(tracker.isBlocked('3.3.3.3')).toBe(false)
  })

  it('cleanup removes stale entries', () => {
    const now = Date.now()
    vi.spyOn(Date, 'now').mockReturnValue(now)

    tracker.recordFailure('old.ip')

    // Advance past window + block period
    vi.spyOn(Date, 'now').mockReturnValue(now + 400_000)
    tracker.cleanup()

    // Entry should be gone, IP should not be blocked
    expect(tracker.isBlocked('old.ip')).toBe(false)
    expect(tracker.size).toBe(0)

    vi.restoreAllMocks()
  })
})
