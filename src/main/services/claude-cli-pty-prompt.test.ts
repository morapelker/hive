import { afterEach, describe, expect, it, vi } from 'vitest'

const { ptyService } = vi.hoisted(() => ({
  ptyService: { has: vi.fn(() => true), write: vi.fn() }
}))
vi.mock('./pty-service', () => ({ ptyService }))

import { reassertClaudeCliPromptSubmit, writeClaudeCliPrompt } from './claude-cli-pty-prompt'

afterEach(() => {
  vi.clearAllMocks()
  ptyService.has.mockReturnValue(true)
})

describe('writeClaudeCliPrompt', () => {
  it('sends a bracketed paste with a submitting CR when the PTY is live', () => {
    const result = writeClaudeCliPrompt('s1', '/goal implement PLAN_x.md')
    expect(result).toEqual({ delivered: true })
    expect(ptyService.write).toHaveBeenCalledWith('s1', '\x1b[200~/goal implement PLAN_x.md\x1b[201~\r')
  })

  it('reports not delivered (and writes nothing) when there is no PTY', () => {
    ptyService.has.mockReturnValue(false)
    expect(writeClaudeCliPrompt('s1', 'hi')).toEqual({ delivered: false })
    expect(ptyService.write).not.toHaveBeenCalled()
  })
})

describe('reassertClaudeCliPromptSubmit', () => {
  // Run the scheduler synchronously so we can assert the CRs without real timers.
  const sync = (fn: () => void): void => fn()

  it('re-sends a bare CR for each scheduled retry while the PTY is live', () => {
    reassertClaudeCliPromptSubmit('s1', { delaysMs: [400, 900, 1600], schedule: sync })
    expect(ptyService.write).toHaveBeenCalledTimes(3)
    expect(ptyService.write.mock.calls.every(([id, data]) => id === 's1' && data === '\r')).toBe(true)
  })

  it('skips the CR once the PTY is gone (no writes to a torn-down terminal)', () => {
    ptyService.has.mockReturnValue(false)
    reassertClaudeCliPromptSubmit('s1', { delaysMs: [400, 900], schedule: sync })
    expect(ptyService.write).not.toHaveBeenCalled()
  })

  it('defaults to setTimeout-based scheduling without firing synchronously', () => {
    vi.useFakeTimers()
    try {
      reassertClaudeCliPromptSubmit('s1')
      expect(ptyService.write).not.toHaveBeenCalled() // nothing fires immediately
      vi.advanceTimersByTime(3000)
      expect(ptyService.write).toHaveBeenCalled()
      expect(ptyService.write).toHaveBeenCalledWith('s1', '\r')
    } finally {
      vi.useRealTimers()
    }
  })
})
