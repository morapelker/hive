const DEFAULT_HEADLESS_SHUTDOWN_TIMEOUT_MS = 5_000

type SignalName = 'SIGINT' | 'SIGTERM'

interface SignalEmitter {
  on(signal: SignalName, listener: () => void): unknown
  off?(signal: SignalName, listener: () => void): unknown
  removeListener?(signal: SignalName, listener: () => void): unknown
}

interface HeadlessShutdownApp {
  quit(): void
  exit(code: number): void
  once?(event: 'will-quit', listener: () => void): unknown
}

interface HeadlessSignalShutdownOptions {
  readonly app: HeadlessShutdownApp
  readonly isHeadless: boolean
  readonly signals?: SignalEmitter
  readonly setTimeout?: typeof setTimeout
  readonly clearTimeout?: typeof clearTimeout
  readonly timeoutMs?: number
}

export const wireHeadlessSignalShutdown = ({
  app,
  isHeadless,
  signals = process,
  setTimeout: setTimeoutFn = setTimeout,
  clearTimeout: clearTimeoutFn = clearTimeout,
  timeoutMs = DEFAULT_HEADLESS_SHUTDOWN_TIMEOUT_MS
}: HeadlessSignalShutdownOptions): (() => void) => {
  if (!isHeadless) return () => {}

  let shuttingDown = false
  let exited = false
  let forceExitTimer: ReturnType<typeof setTimeout> | null = null

  const clearForceExitTimer = (): void => {
    if (!forceExitTimer) return
    clearTimeoutFn(forceExitTimer)
    forceExitTimer = null
  }

  const forceExit = (): void => {
    if (exited) return
    exited = true
    clearForceExitTimer()
    app.exit(0)
  }

  const shutdown = (): void => {
    if (shuttingDown) {
      forceExit()
      return
    }

    shuttingDown = true
    forceExitTimer = setTimeoutFn(forceExit, timeoutMs)
    app.quit()
  }

  signals.on('SIGINT', shutdown)
  signals.on('SIGTERM', shutdown)
  app.once?.('will-quit', clearForceExitTimer)

  return () => {
    clearForceExitTimer()
    if (signals.off) {
      signals.off('SIGINT', shutdown)
      signals.off('SIGTERM', shutdown)
      return
    }
    signals.removeListener?.('SIGINT', shutdown)
    signals.removeListener?.('SIGTERM', shutdown)
  }
}
