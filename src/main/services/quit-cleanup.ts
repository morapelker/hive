import { createLogger } from './logger'

export interface QuitCleanupStep {
  readonly name: string
  readonly run: () => void | Promise<void>
}

interface QuitCleanupLogger {
  info(message: string, data?: Record<string, unknown>): void
  warn(message: string, data?: Record<string, unknown>): void
  error(message: string, error?: Error, data?: Record<string, unknown>): void
}

interface RunQuitCleanupOptions {
  readonly steps: readonly QuitCleanupStep[]
  readonly timeoutMs?: number
  readonly logger?: QuitCleanupLogger
  readonly setTimeout?: typeof setTimeout
  readonly clearTimeout?: typeof clearTimeout
}

const DEFAULT_QUIT_CLEANUP_TIMEOUT_MS = 5_000

/**
 * Runs quit cleanup steps sequentially. A failing step never blocks the
 * remaining steps, and the whole chain is capped by a global timeout so the
 * caller can always proceed to exit. Always resolves, never rejects.
 */
export async function runQuitCleanup({
  steps,
  timeoutMs = DEFAULT_QUIT_CLEANUP_TIMEOUT_MS,
  logger = createLogger({ component: 'QuitCleanup' }),
  setTimeout: setTimeoutFn = setTimeout,
  clearTimeout: clearTimeoutFn = clearTimeout
}: RunQuitCleanupOptions): Promise<void> {
  let stepInFlight = ''
  let timer: ReturnType<typeof setTimeout> | null = null

  const timeout = new Promise<void>((resolve) => {
    timer = setTimeoutFn(() => {
      logger.warn('Quit cleanup timed out, exiting anyway', { stepInFlight, timeoutMs })
      resolve()
    }, timeoutMs)
  })

  const chain = (async () => {
    for (const step of steps) {
      stepInFlight = step.name
      const start = Date.now()
      try {
        await step.run()
        logger.info('Quit cleanup step completed', { step: step.name, ms: Date.now() - start })
      } catch (error) {
        logger.error(
          'Quit cleanup step failed',
          error instanceof Error ? error : new Error(String(error)),
          { step: step.name, ms: Date.now() - start }
        )
      }
    }
  })()

  await Promise.race([chain, timeout])
  if (timer) clearTimeoutFn(timer)
}

interface QuitCleanupApp {
  on(event: 'will-quit', listener: (event: { preventDefault: () => void }) => void): unknown
  exit(code: number): void
}

interface WireQuitCleanupOptions extends RunQuitCleanupOptions {
  readonly app: QuitCleanupApp
}

/**
 * Wires `will-quit` so quit is always prevented while cleanup runs, then the
 * app exits explicitly via `app.exit(0)` (which does not re-emit quit events).
 * Without this, Electron does not await the async cleanup chain and process
 * teardown races against it — see the fsevents finalizer deadlock this fixes.
 */
export function wireQuitCleanup({ app, ...options }: WireQuitCleanupOptions): void {
  let started = false
  app.on('will-quit', (event) => {
    event.preventDefault()
    if (started) return
    started = true
    void runQuitCleanup(options).finally(() => app.exit(0))
  })
}
