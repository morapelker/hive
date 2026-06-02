import { Effect } from 'effect'
import { z } from 'zod'
import {
  isDesktopCommandResult,
  makeDesktopCommandRequest,
  type UpdaterChannel,
  type UpdaterCheckForUpdatePayload
} from '../../../shared/desktop-command'
import type { RpcHandler } from '../router'

export interface UpdaterOpsRpcService {
  readonly checkForUpdate: (options?: UpdaterCheckForUpdatePayload) => Effect.Effect<void, unknown>
  readonly downloadUpdate: () => Effect.Effect<void, unknown>
  readonly installUpdate: () => Effect.Effect<void, unknown>
  readonly setChannel: (channel: UpdaterChannel) => Effect.Effect<void, unknown>
  readonly getVersion: () => Effect.Effect<string, unknown>
}

const emptyParamsSchema = z.union([z.object({}).strict(), z.undefined(), z.null()])
const checkForUpdateParamsSchema = z
  .union([z.object({ manual: z.boolean().optional() }).strict(), z.undefined(), z.null()])
  .transform((value) => value ?? {})
const setChannelParamsSchema = z
  .object({
    channel: z.enum(['stable', 'canary'])
  })
  .strict()

export const makeLiveUpdaterOpsRpcService = (): UpdaterOpsRpcService => ({
  checkForUpdate: (options) =>
    Effect.tryPromise({
      try: () => requestUpdaterCheckForUpdate(options),
      catch: (cause) => cause
    }),
  downloadUpdate: () =>
    Effect.tryPromise({
      try: () => requestUpdaterDownloadUpdate(),
      catch: (cause) => cause
    }),
  installUpdate: () =>
    Effect.tryPromise({
      try: () => requestUpdaterInstallUpdate(),
      catch: (cause) => cause
    }),
  setChannel: (channel) =>
    Effect.tryPromise({
      try: () => requestUpdaterSetChannel(channel),
      catch: (cause) => cause
    }),
  getVersion: () =>
    Effect.tryPromise({
      try: () => requestUpdaterGetVersion(),
      catch: (cause) => cause
    })
})

export const makeUpdaterOpsRpcHandlers = (
  service: UpdaterOpsRpcService = makeLiveUpdaterOpsRpcService()
): ReadonlyMap<string, RpcHandler> =>
  new Map<string, RpcHandler>([
    [
      'updaterOps.checkForUpdate',
      (params) =>
        Effect.gen(function* () {
          const options = yield* Effect.try({
            try: () => checkForUpdateParamsSchema.parse(params),
            catch: (cause) => cause
          })
          return yield* service.checkForUpdate(options)
        })
    ],
    [
      'updaterOps.downloadUpdate',
      (params) =>
        Effect.gen(function* () {
          yield* Effect.try({
            try: () => emptyParamsSchema.parse(params),
            catch: (cause) => cause
          })
          return yield* service.downloadUpdate()
        })
    ],
    [
      'updaterOps.installUpdate',
      (params) =>
        Effect.gen(function* () {
          yield* Effect.try({
            try: () => emptyParamsSchema.parse(params),
            catch: (cause) => cause
          })
          return yield* service.installUpdate()
        })
    ],
    [
      'updaterOps.setChannel',
      (params) =>
        Effect.gen(function* () {
          const { channel } = yield* Effect.try({
            try: () => setChannelParamsSchema.parse(params),
            catch: (cause) => cause
          })
          return yield* service.setChannel(channel)
        })
    ],
    [
      'updaterOps.getVersion',
      (params) =>
        Effect.gen(function* () {
          yield* Effect.try({
            try: () => emptyParamsSchema.parse(params),
            catch: (cause) => cause
          })
          return yield* service.getVersion()
        })
    ]
  ])

const requestUpdaterCheckForUpdate = (options?: UpdaterCheckForUpdatePayload): Promise<void> => {
  const payload = options ?? {}
  const send = process.send
  if (typeof send !== 'function') {
    return Promise.resolve()
  }

  const id = `updater-check-for-update-${Date.now()}-${Math.random().toString(36).slice(2)}`
  const command = 'updaterCheckForUpdate'

  return new Promise<void>((resolve, reject) => {
    let settled = false
    const cleanup = (): void => {
      clearTimeout(timeout)
      process.off('message', onMessage)
    }
    const finish = (error?: Error): void => {
      if (settled) return
      settled = true
      cleanup()
      if (error) {
        reject(error)
        return
      }
      resolve()
    }
    const timeout = setTimeout(() => {
      finish(new Error(`Timed out waiting for desktop command response: ${command}`))
    }, 5_000)

    const onMessage = (message: unknown): void => {
      if (!isDesktopCommandResult(message) || message.id !== id) return
      if (!message.ok) {
        finish(new Error(message.error ?? `Desktop command failed: ${command}`))
        return
      }
      finish()
    }

    process.on('message', onMessage)
    send.call(process, makeDesktopCommandRequest(id, command, payload), (error) => {
      if (!error) return
      finish(error)
    })
  })
}

const requestUpdaterInstallUpdate = (): Promise<void> => {
  const send = process.send
  if (typeof send !== 'function') {
    return Promise.resolve()
  }

  const id = `updater-install-update-${Date.now()}-${Math.random().toString(36).slice(2)}`
  const command = 'updaterInstallUpdate'

  return new Promise<void>((resolve, reject) => {
    let settled = false
    const cleanup = (): void => {
      clearTimeout(timeout)
      process.off('message', onMessage)
    }
    const finish = (error?: Error): void => {
      if (settled) return
      settled = true
      cleanup()
      if (error) {
        reject(error)
        return
      }
      resolve()
    }
    const timeout = setTimeout(() => {
      finish(new Error(`Timed out waiting for desktop command response: ${command}`))
    }, 5_000)

    const onMessage = (message: unknown): void => {
      if (!isDesktopCommandResult(message) || message.id !== id) return
      if (!message.ok) {
        finish(new Error(message.error ?? `Desktop command failed: ${command}`))
        return
      }
      finish()
    }

    process.on('message', onMessage)
    send.call(process, makeDesktopCommandRequest(id, command), (error) => {
      if (!error) return
      finish(error)
    })
  })
}

const requestUpdaterSetChannel = (channel: UpdaterChannel): Promise<void> => {
  const send = process.send
  if (typeof send !== 'function') {
    return Promise.resolve()
  }

  const id = `updater-set-channel-${Date.now()}-${Math.random().toString(36).slice(2)}`
  const command = 'updaterSetChannel'

  return new Promise<void>((resolve, reject) => {
    let settled = false
    const cleanup = (): void => {
      clearTimeout(timeout)
      process.off('message', onMessage)
    }
    const finish = (error?: Error): void => {
      if (settled) return
      settled = true
      cleanup()
      if (error) {
        reject(error)
        return
      }
      resolve()
    }
    const timeout = setTimeout(() => {
      finish(new Error(`Timed out waiting for desktop command response: ${command}`))
    }, 5_000)

    const onMessage = (message: unknown): void => {
      if (!isDesktopCommandResult(message) || message.id !== id) return
      if (!message.ok) {
        finish(new Error(message.error ?? `Desktop command failed: ${command}`))
        return
      }
      finish()
    }

    process.on('message', onMessage)
    send.call(process, makeDesktopCommandRequest(id, command, { channel }), (error) => {
      if (!error) return
      finish(error)
    })
  })
}

const requestUpdaterGetVersion = async (): Promise<string> => {
  const send = process.send
  if (typeof send !== 'function') {
    const { readFile } = await import('node:fs/promises')
    try {
      const raw = await readFile('package.json', 'utf-8')
      const parsed = JSON.parse(raw) as { readonly version?: unknown }
      return typeof parsed.version === 'string' ? parsed.version : ''
    } catch {
      return ''
    }
  }

  const id = `updater-get-version-${Date.now()}-${Math.random().toString(36).slice(2)}`
  const command = 'updaterGetVersion'

  return new Promise<string>((resolve, reject) => {
    let settled = false
    const cleanup = (): void => {
      clearTimeout(timeout)
      process.off('message', onMessage)
    }
    const finish = (value?: string, error?: Error): void => {
      if (settled) return
      settled = true
      cleanup()
      if (error) {
        reject(error)
        return
      }
      resolve(value ?? '')
    }
    const timeout = setTimeout(() => {
      finish(undefined, new Error(`Timed out waiting for desktop command response: ${command}`))
    }, 5_000)

    const onMessage = (message: unknown): void => {
      if (!isDesktopCommandResult(message) || message.id !== id) return
      if (!message.ok) {
        finish(undefined, new Error(message.error ?? `Desktop command failed: ${command}`))
        return
      }
      if (typeof message.value !== 'string') {
        finish(undefined, new Error(`Desktop command returned invalid version: ${command}`))
        return
      }
      finish(message.value)
    }

    process.on('message', onMessage)
    send.call(process, makeDesktopCommandRequest(id, command), (error) => {
      if (!error) return
      finish(undefined, error)
    })
  })
}

const requestUpdaterDownloadUpdate = (): Promise<void> => {
  const send = process.send
  if (typeof send !== 'function') {
    return Promise.resolve()
  }

  const id = `updater-download-update-${Date.now()}-${Math.random().toString(36).slice(2)}`
  const command = 'updaterDownloadUpdate'

  return new Promise<void>((resolve, reject) => {
    let settled = false
    const cleanup = (): void => {
      clearTimeout(timeout)
      process.off('message', onMessage)
    }
    const finish = (error?: Error): void => {
      if (settled) return
      settled = true
      cleanup()
      if (error) {
        reject(error)
        return
      }
      resolve()
    }
    const timeout = setTimeout(() => {
      finish(new Error(`Timed out waiting for desktop command response: ${command}`))
    }, 5_000)

    const onMessage = (message: unknown): void => {
      if (!isDesktopCommandResult(message) || message.id !== id) return
      if (!message.ok) {
        finish(new Error(message.error ?? `Desktop command failed: ${command}`))
        return
      }
      finish()
    }

    process.on('message', onMessage)
    send.call(process, makeDesktopCommandRequest(id, command), (error) => {
      if (!error) return
      finish(error)
    })
  })
}
