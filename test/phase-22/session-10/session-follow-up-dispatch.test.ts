import { beforeEach, describe, expect, test, vi } from 'vitest'

import {
  handleSessionIdleFollowUp,
  resetSessionFollowUpDispatchState
} from '../../../src/renderer/src/lib/session-follow-up-dispatch'

describe('session follow-up dispatch', () => {
  beforeEach(() => {
    resetSessionFollowUpDispatchState()
    vi.clearAllMocks()
  })

  test('completes immediately when no follow-up is queued', async () => {
    const onComplete = vi.fn()

    const result = await handleSessionIdleFollowUp({
      sessionId: 'session-1',
      dequeueFollowUp: () => null,
      requeueFollowUp: vi.fn(),
      dispatchFollowUp: vi.fn(),
      onComplete
    })

    expect(result).toBe('completed')
    expect(onComplete).toHaveBeenCalledTimes(1)
  })

  test('requeues when dispatch fails', async () => {
    const dequeueFollowUp = vi.fn().mockReturnValueOnce('follow-up 1')
    const requeueFollowUp = vi.fn()

    const result = await handleSessionIdleFollowUp({
      sessionId: 'session-1',
      dequeueFollowUp,
      requeueFollowUp,
      dispatchFollowUp: vi.fn().mockResolvedValue(false),
      onDispatchFailure: vi.fn(),
      onComplete: vi.fn()
    })

    expect(result).toBe('failed')
    expect(requeueFollowUp).toHaveBeenCalledWith('follow-up 1')
  })

  test('defers duplicate idle while dispatch is in flight, then drains the next follow-up once', async () => {
    const queue = ['follow-up 1', 'follow-up 2']
    const dequeueFollowUp = vi.fn(() => queue.shift() ?? null)
    const requeueFollowUp = vi.fn((message: string) => queue.unshift(message))
    const onBeforeDispatch = vi.fn()
    const onComplete = vi.fn()

    let resolveDispatch: ((value: boolean) => void) | null = null
    const dispatchFollowUp = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<boolean>((resolve) => {
            resolveDispatch = resolve
          })
      )
      .mockResolvedValueOnce(true)

    const firstIdlePromise = handleSessionIdleFollowUp({
      sessionId: 'session-1',
      dequeueFollowUp,
      requeueFollowUp,
      onBeforeDispatch,
      dispatchFollowUp,
      onComplete
    })

    const secondIdleResult = await handleSessionIdleFollowUp({
      sessionId: 'session-1',
      dequeueFollowUp,
      requeueFollowUp,
      onBeforeDispatch,
      dispatchFollowUp,
      onComplete
    })

    expect(secondIdleResult).toBe('deferred')
    expect(dispatchFollowUp).toHaveBeenCalledTimes(1)

    resolveDispatch?.(true)
    const firstIdleResult = await firstIdlePromise

    expect(firstIdleResult).toBe('dispatched')
    expect(dispatchFollowUp).toHaveBeenCalledTimes(2)
    expect(onBeforeDispatch).toHaveBeenNthCalledWith(1, 'follow-up 1')
    expect(onBeforeDispatch).toHaveBeenNthCalledWith(2, 'follow-up 2')
    expect(onComplete).not.toHaveBeenCalled()
  })

  test('respects blocking state without consuming the queue', async () => {
    const dequeueFollowUp = vi.fn()

    const result = await handleSessionIdleFollowUp({
      sessionId: 'session-1',
      isBlocked: () => true,
      dequeueFollowUp,
      requeueFollowUp: vi.fn(),
      dispatchFollowUp: vi.fn(),
      onComplete: vi.fn()
    })

    expect(result).toBe('blocked')
    expect(dequeueFollowUp).not.toHaveBeenCalled()
  })
})
