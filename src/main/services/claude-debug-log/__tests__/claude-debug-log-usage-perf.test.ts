// @vitest-environment node
/**
 * The counters themselves (Code Mode T20). What the usage source tells them,
 * and when, is in `claude-debug-log-usage-source.test.ts`; what reaches the
 * performance log in the app is in `claude-debug-log-usage.test.ts`.
 */
import { beforeEach, describe, expect, it } from 'vitest'
import {
  CLAUDE_DEBUG_LOG_PERF_GAUGE,
  CLAUDE_DEBUG_LOG_PERF_KIND,
  ClaudeDebugLogUsagePerfCounters,
  type ClaudeDebugLogPerfEvent,
  type ClaudeDebugLogPerfWindow
} from '../claude-debug-log-usage-perf'

const EMPTY: ClaudeDebugLogPerfWindow = {
  sessions: 0,
  passes: 0,
  checks: 0,
  bytesRead: 0,
  entriesParsed: 0,
  parseFailures: 0,
  checkTotalMs: 0,
  checkMaxMs: 0,
  passTotalMs: 0,
  passMaxMs: 0,
  rotations: 0,
  degraded: 0
}

describe('ClaudeDebugLogUsagePerfCounters', () => {
  let enabled: boolean
  let asked: number
  let records: Array<{ kind: string; data: ClaudeDebugLogPerfEvent }>
  let counters: ClaudeDebugLogUsagePerfCounters

  beforeEach(() => {
    enabled = true
    asked = 0
    records = []
    counters = new ClaudeDebugLogUsagePerfCounters({
      isEnabled: () => {
        asked += 1
        return enabled
      },
      record: (kind, data) => records.push({ kind, data })
    })
  })

  it('names its gauge and its record kind the way the performance log documents them', () => {
    expect(CLAUDE_DEBUG_LOG_PERF_GAUGE).toBe('claudeDebugLog')
    expect(CLAUDE_DEBUG_LOG_PERF_KIND).toBe('claude-debug-log')
  })

  it('adds up what the checks and the passes found and took, and keeps the longest of each', () => {
    counters.check(0.4, 4_400, 1, 0)
    counters.check(1.25, 900, 2, 1)
    counters.check(0.05, 0, 0, 0)
    counters.pass(1.5)
    counters.pass(0.25)

    expect(counters.takeWindow(3)).toEqual({
      sessions: 3,
      passes: 2,
      checks: 3,
      bytesRead: 5_300,
      entriesParsed: 3,
      parseFailures: 1,
      checkTotalMs: 1.7,
      checkMaxMs: 1.25,
      passTotalMs: 1.75,
      passMaxMs: 1.5,
      rotations: 0,
      degraded: 0
    })
  })

  it('gives durations to the microsecond', () => {
    counters.check(0.1, 0, 0, 0)
    counters.check(0.2, 0, 0, 0)
    counters.pass(1 / 3)

    expect(counters.takeWindow(1)).toMatchObject({
      checkTotalMs: 0.3,
      checkMaxMs: 0.2,
      passTotalMs: 0.333,
      passMaxMs: 0.333
    })
  })

  it('starts again from nothing each time the gauge is read, and reports the sessions it is given', () => {
    counters.check(0.5, 100, 1, 1)
    counters.pass(1)
    counters.rotated('own')
    counters.degraded('hard-cap', null)
    expect(counters.takeWindow(2)).toMatchObject({
      checks: 1,
      passes: 1,
      rotations: 1,
      degraded: 1
    })

    expect(counters.takeWindow(2)).toEqual({ ...EMPTY, sessions: 2 })
    expect(counters.takeWindow(0)).toEqual(EMPTY)
  })

  it('answers with the state of performance logging every time it is asked', () => {
    expect(counters.isEnabled()).toBe(true)
    enabled = false
    expect(counters.isEnabled()).toBe(false)
    enabled = true
    expect(counters.isEnabled()).toBe(true)
    expect(asked).toBe(3)
  })

  it('drops what no sample took when it finds performance logging off', () => {
    counters.check(0.5, 100, 1, 1)
    counters.pass(1)
    counters.rotated('truncated')
    counters.degraded('log-empty', null)

    enabled = false
    expect(counters.isEnabled()).toBe(false)
    enabled = true

    expect(counters.takeWindow(1)).toEqual({ ...EMPTY, sessions: 1 })
    // The records were written while it was on, and stay written.
    expect(records.length).toBe(2)
  })

  it('writes one record per rotation, with nothing but its cause', () => {
    for (const cause of ['own', 'replaced', 'removed', 'truncated'] as const)
      counters.rotated(cause)

    expect(records).toEqual([
      { kind: 'claude-debug-log', data: { event: 'rotated', cause: 'own' } },
      { kind: 'claude-debug-log', data: { event: 'rotated', cause: 'replaced' } },
      { kind: 'claude-debug-log', data: { event: 'rotated', cause: 'removed' } },
      { kind: 'claude-debug-log', data: { event: 'rotated', cause: 'truncated' } }
    ])
    expect(counters.takeWindow(1)).toMatchObject({ rotations: 4, degraded: 0 })
  })

  it('writes one record per degraded event, with its reason, and what was wrong with an unsafe file', () => {
    counters.degraded('log-empty', null)
    counters.degraded('unparsed-responses', null)
    counters.degraded('hard-cap', null)
    counters.degraded('unsafe-file', 'symlink')
    counters.degraded('unsafe-file', 'foreign-owner')

    expect(records).toEqual([
      { kind: 'claude-debug-log', data: { event: 'degraded', reason: 'log-empty' } },
      { kind: 'claude-debug-log', data: { event: 'degraded', reason: 'unparsed-responses' } },
      { kind: 'claude-debug-log', data: { event: 'degraded', reason: 'hard-cap' } },
      {
        kind: 'claude-debug-log',
        data: { event: 'degraded', reason: 'unsafe-file', detail: 'symlink' }
      },
      {
        kind: 'claude-debug-log',
        data: { event: 'degraded', reason: 'unsafe-file', detail: 'foreign-owner' }
      }
    ])
    expect(counters.takeWindow(1)).toMatchObject({ rotations: 0, degraded: 5 })
  })

  it('measures with a clock that never goes back unless it is given another', () => {
    const first = counters.now()
    const second = counters.now()
    expect(Number.isFinite(first)).toBe(true)
    expect(second).toBeGreaterThanOrEqual(first)

    const scripted = new ClaudeDebugLogUsagePerfCounters({
      isEnabled: () => true,
      record: () => undefined,
      now: () => 42
    })
    expect(scripted.now()).toBe(42)
  })
})
