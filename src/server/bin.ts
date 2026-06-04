import { Effect } from 'effect'
import { startHiveServer, type StartedHiveServer } from './server'

const DEFAULT_SHUTDOWN_TIMEOUT_MS = 5_000

interface ShutdownHandlerOptions {
  readonly exit?: (code: number) => void
  readonly setTimeout?: typeof setTimeout
  readonly clearTimeout?: typeof clearTimeout
  readonly timeoutMs?: number
}

export const createShutdownHandler = (
  server: Pick<StartedHiveServer, 'close'>,
  options: ShutdownHandlerOptions = {}
): (() => void) => {
  const exit = options.exit ?? ((code: number) => process.exit(code))
  const setTimeoutFn = options.setTimeout ?? setTimeout
  const clearTimeoutFn = options.clearTimeout ?? clearTimeout
  const timeoutMs = options.timeoutMs ?? DEFAULT_SHUTDOWN_TIMEOUT_MS
  let shuttingDown = false
  let exited = false

  const exitOnce = (): void => {
    if (exited) return
    exited = true
    exit(0)
  }

  return (): void => {
    if (shuttingDown) {
      exitOnce()
      return
    }

    shuttingDown = true
    const timeout = setTimeoutFn(exitOnce, timeoutMs)

    void server.close().finally(() => {
      clearTimeoutFn(timeout)
      exitOnce()
    })
  }
}

export const main = (): Promise<void> =>
  Effect.runPromise(startHiveServer()).then((server) => {
    process.stdout.write(
      JSON.stringify({
        event: 'hive-server-ready',
        httpBaseUrl: server.httpBaseUrl,
        wsBaseUrl: server.wsBaseUrl
      }) + '\n'
    )

    const shutdown = createShutdownHandler(server)

    process.on('SIGINT', shutdown)
    process.on('SIGTERM', shutdown)
  })

const entryArg = process.argv[1] ?? ''

if (
  entryArg.endsWith('src/server/bin.ts') ||
  entryArg.endsWith('server/bin.js') ||
  entryArg.endsWith('server.js')
) {
  void main()
}
