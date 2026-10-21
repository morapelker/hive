import { Effect } from 'effect'
import { z } from 'zod'
import {
  isDesktopCommandResult,
  makeDesktopCommandRequest,
  type DesktopCommandRequest
} from '../../../shared/desktop-command'
import type {
  SessionProfilerKillRequest,
  SessionProfilerKillResult,
  SessionProfilerSnapshot
} from '../../../shared/types/session-profiler'
import type { RpcHandler } from '../router'

/**
 * Session profiler (Settings → Advanced, off by default). The agent CLI processes are children
 * of the Electron main process and only main owns their PTY registry, so both methods forward
 * to it as desktop commands (`sessionProfilerSnapshot` / `sessionProfilerKill`). Without a
 * desktop parent (browser / server mode) the feature reports itself unsupported.
 *
 * Desktop only: deliberately absent from the remote-access policy, so paired devices cannot
 * sample or stop this Mac's processes.
 */

export interface SessionProfilerOpsRpcService {
  readonly getSnapshot: () => Effect.Effect<SessionProfilerSnapshot, unknown, never>
  readonly kill: (
    request: SessionProfilerKillRequest
  ) => Effect.Effect<SessionProfilerKillResult, unknown, never>
}

const emptyParamsSchema = z.union([z.object({}).strict(), z.undefined(), z.null()])
const killParamsSchema = z
  .object({
    sessionId: z.string().min(1).max(200).nullable().optional(),
    pid: z.number().int().positive().optional(),
    startedAt: z.string().min(1).max(100).optional()
  })
  .strict()
  .refine((value) => !!value.sessionId || value.pid !== undefined, {
    message: 'sessionId or pid is required'
  })

const DESKTOP_COMMAND_TIMEOUT_MS = 30_000

type SendFn = (message: unknown, callback: (error: Error | null) => void) => unknown
interface MessageSource {
  on(event: 'message', listener: (message: unknown) => void): unknown
  off(event: 'message', listener: (message: unknown) => void): unknown
}

export interface SessionProfilerDesktopTransport {
  /** The IPC channel to the Electron main process; undefined without a desktop parent. */
  readonly getSend: () => SendFn | undefined
  readonly messages: MessageSource
}

const processTransport: SessionProfilerDesktopTransport = {
  getSend: () => {
    const send = process.send
    return typeof send === 'function'
      ? (message, callback) => send.call(process, message, callback)
      : undefined
  },
  messages: process
}

/** Empty sample: unsupported (no desktop parent), or supported with the error that stopped it. */
const emptySnapshot = (supported: boolean, error?: string): SessionProfilerSnapshot => ({
  supported,
  sampledAt: Date.now(),
  cpuWindowMs: null,
  idleThresholdSeconds: 0,
  sessions: [],
  totals: {
    processCount: 0,
    cpuPercent: null,
    agentCpuPercent: null,
    rssBytes: 0,
    agentRssBytes: 0,
    cpuCount: 0
  },
  ...(error !== undefined ? { error } : {})
})

const isSnapshot = (value: unknown): value is SessionProfilerSnapshot =>
  typeof value === 'object' &&
  value !== null &&
  typeof (value as { supported?: unknown }).supported === 'boolean' &&
  Array.isArray((value as { sessions?: unknown }).sessions)

const isKillResult = (value: unknown): value is SessionProfilerKillResult =>
  typeof value === 'object' && value !== null && typeof (value as { ok?: unknown }).ok === 'boolean'

/** Sends one desktop command and resolves with its value; null when there is no desktop parent. */
const requestDesktop = (
  transport: SessionProfilerDesktopTransport,
  command: string,
  makeRequest: (id: string) => DesktopCommandRequest
): Promise<{ value: unknown } | null> => {
  const send = transport.getSend()
  if (!send) return Promise.resolve(null)

  const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
  return new Promise<{ value: unknown }>((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup()
      reject(new Error(`Timed out waiting for desktop command response: ${command}`))
    }, DESKTOP_COMMAND_TIMEOUT_MS)

    const cleanup = (): void => {
      clearTimeout(timeout)
      transport.messages.off('message', onMessage)
    }

    const onMessage = (message: unknown): void => {
      if (!isDesktopCommandResult(message) || message.id !== id) return
      cleanup()
      if (message.ok) {
        resolve({ value: message.value })
        return
      }
      reject(new Error(message.error ?? `Desktop command failed: ${command}`))
    }

    transport.messages.on('message', onMessage)
    send(makeRequest(id), (error) => {
      if (!error) return
      cleanup()
      reject(error)
    })
  })
}

const describeError = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause)

export const makeLiveSessionProfilerOpsRpcService = (
  transport: SessionProfilerDesktopTransport = processTransport
): SessionProfilerOpsRpcService => ({
  getSnapshot: () =>
    Effect.promise(async () => {
      try {
        const response = await requestDesktop(transport, 'sessionProfilerSnapshot', (id) =>
          makeDesktopCommandRequest(id, 'sessionProfilerSnapshot')
        )
        if (!response) return emptySnapshot(false)
        return isSnapshot(response.value)
          ? response.value
          : emptySnapshot(true, 'Malformed session profiler snapshot')
      } catch (cause) {
        return emptySnapshot(true, describeError(cause))
      }
    }),
  kill: (request) =>
    Effect.promise(async (): Promise<SessionProfilerKillResult> => {
      try {
        const response = await requestDesktop(transport, 'sessionProfilerKill', (id) =>
          makeDesktopCommandRequest(id, 'sessionProfilerKill', request)
        )
        if (!response) return { ok: false, error: 'unsupported' }
        return isKillResult(response.value)
          ? response.value
          : { ok: false, error: 'Malformed session profiler kill result' }
      } catch (cause) {
        return { ok: false, error: describeError(cause) }
      }
    })
})

export const makeSessionProfilerOpsRpcHandlers = (
  service: SessionProfilerOpsRpcService = makeLiveSessionProfilerOpsRpcService()
): ReadonlyMap<string, RpcHandler> =>
  new Map<string, RpcHandler>([
    [
      'sessionProfilerOps.getSnapshot',
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
      'sessionProfilerOps.kill',
      (params) =>
        Effect.gen(function* () {
          const request = yield* Effect.try({
            try: () => killParamsSchema.parse(params),
            catch: (cause) => cause
          })
          return yield* service.kill(request)
        })
    ]
  ])
