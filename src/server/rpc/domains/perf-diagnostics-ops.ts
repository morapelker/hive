import { Effect } from 'effect'
import { z } from 'zod'
import {
  isDesktopCommandResult,
  makeDesktopCommandRequest,
  type PerfLoggingPayload,
  type PerfLoggingResult
} from '../../../shared/desktop-command'
import {
  getPerfLogger,
  type PerfLoggerStatus,
  type PerfProcessRole
} from '../../../main/services/perf-logging/perf-logger'
import type { RpcHandler } from '../router'

/**
 * Performance logging (Settings → Advanced). The RPC domain keeps its historical name
 * (`perfDiagnosticsOps`) so the persisted setting and the renderer API stay compatible.
 *
 * The server child samples itself, persists the renderer's records (`appendRecords`), and
 * forwards enable/capture to the Electron main process through the `perfLogging` desktop
 * command so all three processes log into `~/.hive/logs/perf/`.
 */

export interface PerfLoggingStatus {
  readonly server: PerfLoggerStatus
  readonly logDir: string
  readonly files: Array<{ name: string; bytes: number; modifiedAt: string }>
}

export interface PerfDiagnosticsOpsRpcService {
  readonly enable: (enabled: boolean) => Effect.Effect<void, unknown, never>
  /** Alias of `getStatus` kept for older callers. */
  readonly getSnapshot: () => Effect.Effect<PerfLoggingStatus, unknown, never>
  readonly getStatus: () => Effect.Effect<PerfLoggingStatus, unknown, never>
  readonly appendRecords: (
    role: PerfProcessRole,
    records: Array<Record<string, unknown>>
  ) => Effect.Effect<void, unknown, never>
  readonly captureNow: (reason: string) => Effect.Effect<PerfLoggingResult, unknown, never>
}

const emptyParamsSchema = z.union([z.object({}).strict(), z.undefined(), z.null()])
const enableParamsSchema = z.object({ enabled: z.boolean() }).strict()
const appendRecordsParamsSchema = z
  .object({
    role: z.enum(['renderer']),
    records: z.array(z.record(z.string(), z.unknown())).max(500)
  })
  .strict()
const captureNowParamsSchema = z.object({ reason: z.string().min(1).max(200) }).strict()

const status = (): PerfLoggingStatus => {
  const logger = getPerfLogger('server')
  return { server: logger.getStatus(), logDir: logger.getLogDir(), files: logger.listLogFiles() }
}

export const makeLivePerfDiagnosticsOpsRpcService = (): PerfDiagnosticsOpsRpcService => ({
  enable: (enabled) =>
    Effect.tryPromise({
      try: async () => {
        const logger = getPerfLogger('server')
        if (enabled) logger.start()
        else logger.stop()
        // The Electron main process samples itself; a missing desktop (browser/server mode)
        // is not an error.
        await requestPerfLoggingDesktopCommand({ action: 'configure', enabled }).catch(() => null)
      },
      catch: (cause) => cause
    }),
  getSnapshot: () => Effect.try({ try: status, catch: (cause) => cause }),
  getStatus: () => Effect.try({ try: status, catch: (cause) => cause }),
  appendRecords: (role, records) =>
    Effect.try({
      try: () => {
        getPerfLogger('server').writeExternal(role, records)
      },
      catch: (cause) => cause
    }),
  captureNow: (reason) =>
    Effect.tryPromise({
      try: async () => {
        const own = getPerfLogger('server').captureNow(reason)
        const desktop = await requestPerfLoggingDesktopCommand({ action: 'capture', reason }).catch(
          () => null
        )
        return { files: [...own.files, ...(desktop?.files ?? [])] }
      },
      catch: (cause) => cause
    })
})

export const makePerfDiagnosticsOpsRpcHandlers = (
  service: PerfDiagnosticsOpsRpcService = makeLivePerfDiagnosticsOpsRpcService()
): ReadonlyMap<string, RpcHandler> =>
  new Map<string, RpcHandler>([
    [
      'perfDiagnosticsOps.enable',
      (params) =>
        Effect.gen(function* () {
          const { enabled } = yield* Effect.try({
            try: () => enableParamsSchema.parse(params),
            catch: (cause) => cause
          })
          return yield* service.enable(enabled)
        })
    ],
    [
      'perfDiagnosticsOps.getSnapshot',
      (params) =>
        Effect.gen(function* () {
          yield* Effect.try({
            try: () => emptyParamsSchema.parse(params),
            catch: (cause) => cause
          })
          return yield* service.getSnapshot()
        })
    ],
    [
      'perfDiagnosticsOps.getStatus',
      (params) =>
        Effect.gen(function* () {
          yield* Effect.try({
            try: () => emptyParamsSchema.parse(params),
            catch: (cause) => cause
          })
          return yield* service.getStatus()
        })
    ],
    [
      'perfDiagnosticsOps.appendRecords',
      (params) =>
        Effect.gen(function* () {
          const { role, records } = yield* Effect.try({
            try: () => appendRecordsParamsSchema.parse(params),
            catch: (cause) => cause
          })
          return yield* service.appendRecords(role, records)
        })
    ],
    [
      'perfDiagnosticsOps.captureNow',
      (params) =>
        Effect.gen(function* () {
          const { reason } = yield* Effect.try({
            try: () => captureNowParamsSchema.parse(params),
            catch: (cause) => cause
          })
          return yield* service.captureNow(reason)
        })
    ]
  ])

const DESKTOP_COMMAND_TIMEOUT_MS = 60_000

/** Forwards to the Electron main process; resolves to null when there is no desktop parent. */
const requestPerfLoggingDesktopCommand = (
  payload: PerfLoggingPayload
): Promise<PerfLoggingResult | null> => {
  const send = process.send
  if (typeof send !== 'function') return Promise.resolve(null)

  const command = 'perfLogging'
  const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
  return new Promise<PerfLoggingResult | null>((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup()
      reject(new Error(`Timed out waiting for desktop command response: ${command}`))
    }, DESKTOP_COMMAND_TIMEOUT_MS)

    const cleanup = (): void => {
      clearTimeout(timeout)
      process.off('message', onMessage)
    }

    const onMessage = (message: unknown): void => {
      if (!isDesktopCommandResult(message) || message.id !== id) return
      cleanup()
      if (message.ok) {
        resolve(isPerfLoggingResult(message.value) ? message.value : { files: [] })
        return
      }
      reject(new Error(message.error ?? `Desktop command failed: ${command}`))
    }

    process.on('message', onMessage)
    send.call(process, makeDesktopCommandRequest(id, command, payload), (error) => {
      if (!error) return
      cleanup()
      reject(error)
    })
  })
}

const isPerfLoggingResult = (value: unknown): value is PerfLoggingResult =>
  typeof value === 'object' &&
  value !== null &&
  Array.isArray((value as { files?: unknown }).files)
