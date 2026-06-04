import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { wireHeadlessSignalShutdown } from './headless-shutdown'

describe('headless signal shutdown', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('does not wire signal handlers outside headless mode', () => {
    const signals = new EventEmitter()
    const app = makeApp()

    const dispose = wireHeadlessSignalShutdown({
      app,
      isHeadless: false,
      signals
    })

    signals.emit('SIGINT')

    expect(app.quit).not.toHaveBeenCalled()
    expect(app.exit).not.toHaveBeenCalled()
    dispose()
  })

  it('quits on the first interrupt and exits immediately on the second', () => {
    vi.useFakeTimers()
    const signals = new EventEmitter()
    const app = makeApp()

    wireHeadlessSignalShutdown({
      app,
      isHeadless: true,
      signals,
      timeoutMs: 1_000
    })

    signals.emit('SIGINT')
    expect(app.quit).toHaveBeenCalledTimes(1)
    expect(app.exit).not.toHaveBeenCalled()

    signals.emit('SIGINT')
    expect(app.quit).toHaveBeenCalledTimes(1)
    expect(app.exit).toHaveBeenCalledWith(0)
  })

  it('forces exit when graceful headless quit does not complete', async () => {
    vi.useFakeTimers()
    const signals = new EventEmitter()
    const app = makeApp()

    wireHeadlessSignalShutdown({
      app,
      isHeadless: true,
      signals,
      timeoutMs: 100
    })

    signals.emit('SIGTERM')
    await vi.advanceTimersByTimeAsync(99)
    expect(app.exit).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(1)
    expect(app.exit).toHaveBeenCalledWith(0)
  })
})

const makeApp = () => ({
  quit: vi.fn(),
  exit: vi.fn(),
  once: vi.fn()
})
