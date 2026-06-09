import { afterEach, describe, expect, it, vi } from 'vitest'
import { runQuitCleanup, wireQuitCleanup, type QuitCleanupStep } from './quit-cleanup'

describe('runQuitCleanup', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('runs steps sequentially in order', async () => {
    const order: string[] = []
    const steps: QuitCleanupStep[] = [
      { name: 'first', run: () => void order.push('first') },
      {
        name: 'second',
        run: async () => {
          await Promise.resolve()
          order.push('second')
        }
      },
      { name: 'third', run: () => void order.push('third') }
    ]

    await runQuitCleanup({ steps, logger: makeLogger() })

    expect(order).toEqual(['first', 'second', 'third'])
  })

  it('continues with later steps when a step throws synchronously', async () => {
    const order: string[] = []
    const logger = makeLogger()
    const steps: QuitCleanupStep[] = [
      {
        name: 'broken',
        run: () => {
          throw new Error('boom')
        }
      },
      { name: 'after', run: () => void order.push('after') }
    ]

    await runQuitCleanup({ steps, logger })

    expect(order).toEqual(['after'])
    expect(logger.error).toHaveBeenCalledTimes(1)
  })

  it('continues with later steps when a step rejects', async () => {
    const order: string[] = []
    const logger = makeLogger()
    const steps: QuitCleanupStep[] = [
      { name: 'broken', run: () => Promise.reject(new Error('boom')) },
      { name: 'after', run: () => void order.push('after') }
    ]

    await runQuitCleanup({ steps, logger })

    expect(order).toEqual(['after'])
    expect(logger.error).toHaveBeenCalledTimes(1)
  })

  it('resolves after the global timeout when a step never settles', async () => {
    vi.useFakeTimers()
    const logger = makeLogger()
    const steps: QuitCleanupStep[] = [
      { name: 'stuck', run: () => new Promise<never>(() => {}) }
    ]

    let resolved = false
    const promise = runQuitCleanup({ steps, timeoutMs: 1_000, logger }).then(() => {
      resolved = true
    })

    await vi.advanceTimersByTimeAsync(999)
    expect(resolved).toBe(false)

    await vi.advanceTimersByTimeAsync(1)
    await promise
    expect(resolved).toBe(true)
    expect(logger.warn).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ stepInFlight: 'stuck' })
    )
  })
})

describe('wireQuitCleanup', () => {
  it('prevents the default quit and exits after cleanup completes', async () => {
    const { app, emitWillQuit } = makeApp()
    const order: string[] = []
    wireQuitCleanup({
      app,
      steps: [{ name: 'step', run: () => void order.push('step') }],
      logger: makeLogger()
    })

    const event = emitWillQuit()
    expect(event.preventDefault).toHaveBeenCalledTimes(1)

    await vi.waitFor(() => {
      expect(app.exit).toHaveBeenCalledWith(0)
    })
    expect(order).toEqual(['step'])
    expect(app.exit).toHaveBeenCalledTimes(1)
  })

  it('does not restart cleanup when will-quit fires again mid-cleanup', async () => {
    const { app, emitWillQuit } = makeApp()
    let runs = 0
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    wireQuitCleanup({
      app,
      steps: [
        {
          name: 'slow',
          run: () => {
            runs++
            return gate
          }
        }
      ],
      logger: makeLogger()
    })

    emitWillQuit()
    const second = emitWillQuit()

    expect(second.preventDefault).toHaveBeenCalledTimes(1)
    release()

    await vi.waitFor(() => {
      expect(app.exit).toHaveBeenCalledWith(0)
    })
    expect(runs).toBe(1)
    expect(app.exit).toHaveBeenCalledTimes(1)
  })
})

const makeLogger = () => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn()
})

const makeApp = () => {
  const listeners: Array<(event: { preventDefault: () => void }) => void> = []
  const app = {
    on: vi.fn((_event: 'will-quit', listener: (event: { preventDefault: () => void }) => void) => {
      listeners.push(listener)
    }),
    exit: vi.fn()
  }
  const emitWillQuit = (): { preventDefault: ReturnType<typeof vi.fn> } => {
    const event = { preventDefault: vi.fn() }
    for (const listener of listeners) listener(event)
    return event
  }
  return { app, emitWillQuit }
}
