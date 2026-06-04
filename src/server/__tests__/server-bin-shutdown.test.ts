import { afterEach, describe, expect, it, vi } from 'vitest'
import { createShutdownHandler } from '../bin'

describe('server bin shutdown', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('exits after the shutdown timeout when server close hangs', async () => {
    vi.useFakeTimers()
    const close = vi.fn(() => new Promise<void>(() => {}))
    const exit = vi.fn()
    const shutdown = createShutdownHandler(
      { close },
      {
        exit,
        timeoutMs: 100
      }
    )

    shutdown()
    await vi.advanceTimersByTimeAsync(99)
    expect(exit).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(1)

    expect(close).toHaveBeenCalledTimes(1)
    expect(exit).toHaveBeenCalledWith(0)
  })

  it('forces exit immediately on repeated shutdown signals', () => {
    vi.useFakeTimers()
    const close = vi.fn(() => new Promise<void>(() => {}))
    const exit = vi.fn()
    const shutdown = createShutdownHandler(
      { close },
      {
        exit,
        timeoutMs: 1_000
      }
    )

    shutdown()
    shutdown()

    expect(close).toHaveBeenCalledTimes(1)
    expect(exit).toHaveBeenCalledWith(0)
  })
})
