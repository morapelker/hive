import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { toast as sonnerToast } from 'sonner'

import type { BashRunSnapshot, BashStreamEvent } from '@/api/bash-api'
import { resetRendererRpcClientForTests, setRendererRpcClient } from '@/api/rpc-client'
import { useBashRuns } from '../useBashRuns'

vi.mock('sonner', () => ({
  toast: {
    error: vi.fn()
  }
}))

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

describe('useBashRuns', () => {
  beforeEach(() => {
    vi.mocked(sonnerToast.error).mockReset()
  })

  afterEach(() => {
    vi.clearAllMocks()
    resetRendererRpcClientForTests()
  })

  it('seeds runs from getRun success envelopes on mount', async () => {
    const request = vi.fn().mockResolvedValue(snapshot)
    const subscribe = vi.fn().mockReturnValue(vi.fn())
    setRendererRpcClient({ request, subscribe })

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
    expect(request).toHaveBeenCalledWith('bash.getRun', { sessionId: 'session-1' })
  })

  it('surfaces runCommand envelope failures without throwing', async () => {
    const request = vi.fn(async <T,>(method: string): Promise<T> => {
      if (method === 'bash.run') {
        throw new Error('Could not start command')
      }
      return null as T
    })
    const subscribe = vi.fn().mockReturnValue(vi.fn())
    setRendererRpcClient({
      request: request as unknown as <T = unknown>(method: string, params?: unknown) => Promise<T>,
      subscribe
    })

    const { result } = renderHook(() => useBashRuns('session-1'))

    await expect(
      act(async () => {
        await result.current.runCommand('pnpm test', '/repo')
      })
    ).resolves.toBeUndefined()
    expect(request).toHaveBeenCalledWith('bash.run', {
      sessionId: 'session-1',
      command: 'pnpm test',
      cwd: '/repo'
    })
    await waitFor(() => {
      expect(sonnerToast.error).toHaveBeenCalledWith(
        'Could not start command',
        expect.objectContaining({ duration: 5000 })
      )
    })
  })

  it('routes abort through the renderer RPC client', async () => {
    const request = vi.fn().mockResolvedValue(null)
    const subscribe = vi.fn().mockReturnValue(vi.fn())
    setRendererRpcClient({ request, subscribe })

    const { result } = renderHook(() => useBashRuns('session-1'))

    await expect(
      act(async () => {
        await result.current.abort()
      })
    ).resolves.toBeUndefined()
    expect(request).toHaveBeenCalledWith('bash.abort', { sessionId: 'session-1' })
  })

  it('subscribes to bash stream events and unsubscribes on unmount', () => {
    const unsubscribe = vi.fn()
    const subscribe = vi.fn().mockReturnValue(unsubscribe)
    const request = vi.fn().mockResolvedValue(null)
    setRendererRpcClient({ request, subscribe })

    const { unmount } = renderHook(() => useBashRuns('session-1'))

    expect(subscribe).toHaveBeenCalledTimes(1)
    expect(subscribe).toHaveBeenCalledWith('bash:stream', expect.any(Function))

    unmount()

    expect(unsubscribe).toHaveBeenCalledTimes(1)
  })
})
