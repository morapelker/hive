import { Effect } from 'effect'
import { z } from 'zod'
import { isDesktopCommandResult, makeDesktopCommandRequest } from '../../../shared/desktop-command'
import type { RpcHandler } from '../router'

export interface LoggingOpsRpcService {
  readonly createResponseLog: (sessionId: string) => Effect.Effect<string, unknown, never>
  readonly appendResponseLog: (
    filePath: string,
    data: unknown
  ) => Effect.Effect<void, unknown, never>
}

const createResponseLogParamsSchema = z.object({ sessionId: z.string().min(1) }).strict()
const appendResponseLogParamsSchema = z
  .object({
    filePath: z.string().min(1),
    data: z.unknown()
  })
  .strict()

export const makeLiveLoggingOpsRpcService = (): LoggingOpsRpcService => ({
  createResponseLog: (sessionId) =>
    Effect.tryPromise({
      try: () => requestCreateResponseLogCommand(sessionId),
      catch: (cause) => cause
    }),
  appendResponseLog: (filePath, data) =>
    Effect.tryPromise({
      try: () => requestAppendResponseLogCommand(filePath, data),
      catch: (cause) => cause
    })
})

export const makeLoggingOpsRpcHandlers = (
  service: LoggingOpsRpcService = makeLiveLoggingOpsRpcService()
): ReadonlyMap<string, RpcHandler> =>
  new Map<string, RpcHandler>([
    [
      'loggingOps.createResponseLog',
      (params) =>
        Effect.gen(function* () {
          const { sessionId } = yield* Effect.try({
            try: () => createResponseLogParamsSchema.parse(params),
            catch: (cause) => cause
          })
          return yield* service.createResponseLog(sessionId)
        })
    ],
    [
      'loggingOps.appendResponseLog',
      (params) =>
        Effect.gen(function* () {
          const { filePath, data } = yield* Effect.try({
            try: () => appendResponseLogParamsSchema.parse(params),
            catch: (cause) => cause
          })
          return yield* service.appendResponseLog(filePath, data)
        })
    ]
  ])

const requestCreateResponseLogCommand = (sessionId: string): Promise<string> => {
  const send = process.send
  if (typeof send !== 'function') {
    return import('../../../main/services/response-logger').then(({ createResponseLog }) =>
      createResponseLog(sessionId)
    )
  }

  const command = 'createResponseLog'
  const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
  return new Promise<string>((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup()
      reject(new Error(`Timed out waiting for desktop command response: ${command}`))
    }, 5_000)

    const cleanup = (): void => {
      clearTimeout(timeout)
      process.off('message', onMessage)
    }

    const onMessage = (message: unknown): void => {
      if (!isDesktopCommandResult(message) || message.id !== id) return
      cleanup()
      if (message.ok) {
        if (typeof message.value === 'string') {
          resolve(message.value)
          return
        }
        reject(new Error(`Desktop command returned invalid response: ${command}`))
        return
      }
      reject(new Error(message.error ?? `Desktop command failed: ${command}`))
    }

    process.on('message', onMessage)
    send.call(process, makeDesktopCommandRequest(id, command, { sessionId }), (error) => {
      if (!error) return
      cleanup()
      reject(error)
    })
  })
}

const requestAppendResponseLogCommand = (filePath: string, data: unknown): Promise<void> => {
  const send = process.send
  if (typeof send !== 'function') {
    return import('../../../main/services/response-logger').then(({ appendResponseLog }) => {
      appendResponseLog(filePath, data)
    })
  }

  const command = 'appendResponseLog'
  const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
  return new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup()
      reject(new Error(`Timed out waiting for desktop command response: ${command}`))
    }, 5_000)

    const cleanup = (): void => {
      clearTimeout(timeout)
      process.off('message', onMessage)
    }

    const onMessage = (message: unknown): void => {
      if (!isDesktopCommandResult(message) || message.id !== id) return
      cleanup()
      if (message.ok) {
        resolve()
        return
      }
      reject(new Error(message.error ?? `Desktop command failed: ${command}`))
    }

    process.on('message', onMessage)
    send.call(process, makeDesktopCommandRequest(id, command, { filePath, data }), (error) => {
      if (!error) return
      cleanup()
      reject(error)
    })
  })
}
