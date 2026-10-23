// Entry of the server bundle (out/main/server.js). The same file is also forked as the
// data-projects SQLite worker (TEDOOO_DATA_SQLITE_WORKER=1, see the bottom of this file), so it
// keeps NO static import with side effects: the server graph (database, routers, account
// stores, perf logging) is imported inside `main()` only, and a worker never loads it.
// (`effect` stays static: a side-effect-free external, and one module instance for the bundle.)
import type { EventEmitter } from 'node:events'
import { Effect } from 'effect'
import type { StartedHiveServer } from './server'

const DEFAULT_SHUTDOWN_TIMEOUT_MS = 5_000

export type ProcessGuardLog = (message: string, error: unknown) => void

/** The server child's logger: its stderr, which the desktop process collects. */
const defaultGuardLog: ProcessGuardLog = (message, error) => {
  console.error(`[hive-server] ${message}`, error)
}

/**
 * Defence in depth for the long-lived server child: a throw that escapes a socket listener or
 * a rejected promise nobody awaited is logged and the process stays up. An exit here would end
 * every renderer connection over one bad frame; each subsystem catches its own faults, this is
 * the last net under them.
 */
export const installProcessGuards = (
  target: Pick<EventEmitter, 'on'> = process,
  log: ProcessGuardLog = defaultGuardLog
): void => {
  target.on('uncaughtException', (error: unknown) => {
    log('Uncaught exception (the server keeps running)', error)
  })
  target.on('unhandledRejection', (reason: unknown) => {
    log('Unhandled promise rejection (the server keeps running)', reason)
  })
}

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

export const main = async (): Promise<void> => {
  installProcessGuards()
  const [
    { startHiveServer },
    { startAccountMaintenance },
    { getDatabase },
    { getPerfLogger },
    { APP_SETTINGS_DB_KEY }
  ] = await Promise.all([
    import('./server'),
    import('../main/services/account-maintenance'),
    import('../main/db'),
    import('../main/services/perf-logging/perf-logger'),
    import('../shared/types/settings')
  ])
  return Effect.runPromise(startHiveServer()).then((server) => {
    process.stdout.write(
      JSON.stringify({
        event: 'hive-server-ready',
        httpBaseUrl: server.httpBaseUrl,
        wsBaseUrl: server.wsBaseUrl
      }) + '\n'
    )

    // Account maintenance (ccswitch-store migration, launch mass refresh,
    // expiry watcher) is only ever started here — the real spawned server
    // process — never from `startHiveServer()` itself, so tests that start
    // the HTTP/WS server directly never touch the real Keychain/filesystem
    // account stores or make live network calls.
    const stopAccountMaintenance = startAccountMaintenance()

    // Performance logging (Settings → Advanced) survives a relaunch: resume when the
    // persisted setting is on, so the window before a slowdown is already being recorded.
    const perfLogger = getPerfLogger('server')
    try {
      const raw = getDatabase().getSetting(APP_SETTINGS_DB_KEY)
      const settings = raw ? (JSON.parse(raw) as { perfDiagnosticsEnabled?: boolean }) : null
      if (settings?.perfDiagnosticsEnabled) perfLogger.start()
    } catch {
      // setting absent or unreadable: stay off
    }

    const shutdown = createShutdownHandler({
      close: async () => {
        stopAccountMaintenance()
        perfLogger.mark('server-shutdown')
        perfLogger.flush()
        await server.close()
      }
    })

    process.on('SIGINT', shutdown)
    process.on('SIGTERM', shutdown)
  })
}

const entryArg = process.argv[1] ?? ''

if (
  entryArg.endsWith('src/server/bin.ts') ||
  entryArg.endsWith('server/bin.js') ||
  entryArg.endsWith('server.js')
) {
  if (process.env.TEDOOO_DATA_SQLITE_WORKER === '1') {
    // A data project's SQLite worker (forked by drivers/sqlite.ts with this bundle as its
    // entry): run the IPC loop only — no server, no app database, no account maintenance.
    void import('../main/services/data-projects/drivers/sqlite-worker')
      .then((worker) => worker.runSqliteWorker())
      .catch((error: unknown) => {
        // The parent sees the exit and reports the project as disconnected.
        console.error('[tedooo-data-sqlite-worker] failed to start', error)
        process.exit(1)
      })
  } else {
    void main()
  }
}
