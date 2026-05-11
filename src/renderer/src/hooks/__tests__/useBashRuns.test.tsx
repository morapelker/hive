import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { toast as sonnerToast } from 'sonner'

import { useBashRuns } from '../useBashRuns'

vi.mock('sonner', () => ({
  toast: {
    error: vi.fn()
  }
}))

type BashApi = typeof window.bash

const snapshot: BashRunSnapshot = {
  sessionId: 'session-1',
  id: 'run-1',
  command: 'pnpm test',
  cwd: '/repo',
  startedAt: 123,
  status: 'running',
  outputBuffer: 'seeded output',
  outputBytes: 13
}

const installBashMock = (overrides: Partial<BashApi> = {}): BashApi => {
  const bash = {
    getRun: vi.fn().mockResolvedValue({ success: true, value: null }),
    run: vi.fn().mockResolvedValue({ success: true, value: { runId: 'run-2' } }),
    abort: vi.fn().mockResolvedValue({ success: true, value: true }),
    onStream: vi.fn().mockReturnValue(vi.fn()),
    ...overrides
  } as unknown as BashApi

  Object.defineProperty(window, 'bash', {
    configurable: true,
    writable: true,
    value: bash
  })

  return bash
}

describe('useBashRuns', () => {
  beforeEach(() => {
    vi.mocked(sonnerToast.error).mockReset()
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  it('seeds runs from getRun success envelopes on mount', async () => {
    installBashMock({
      getRun: vi.fn().mockResolvedValue({ success: true, value: snapshot })
    })

    const { result } = renderHook(() => useBashRuns('session-1'))

    await waitFor(() => {
      expect(result.current.runs).toEqual([
        {
          id: 'run-1',
          command: 'pnpm test',
          output: 'seeded output',
          status: 'running',
          startedAt: 123
        }
      ])
    })
  })

  it('surfaces runCommand envelope failures without throwing', async () => {
    installBashMock({
      run: vi.fn().mockResolvedValue({
        success: false,
        errorCode: 'BashRunFailed',
        error: 'Could not start command'
      })
    })

    const { result } = renderHook(() => useBashRuns('session-1'))

    await expect(
      act(async () => {
        await result.current.runCommand('pnpm test', '/repo')
      })
    ).resolves.toBeUndefined()
    expect(window.bash.run).toHaveBeenCalledWith('session-1', 'pnpm test', '/repo')
    await waitFor(() => {
      expect(sonnerToast.error).toHaveBeenCalledWith(
        'Could not start command',
        expect.objectContaining({ duration: 5000 })
      )
    })
  })

  it('subscribes to bash stream events and unsubscribes on unmount', () => {
    const unsubscribe = vi.fn()
    const onStream = vi.fn().mockReturnValue(unsubscribe)
    installBashMock({ onStream })

    const { unmount } = renderHook(() => useBashRuns('session-1'))

    expect(onStream).toHaveBeenCalledTimes(1)
    expect(onStream).toHaveBeenCalledWith(expect.any(Function))

    unmount()

    expect(unsubscribe).toHaveBeenCalledTimes(1)
  })
})
