import { Effect } from 'effect'
import { z } from 'zod'
import {
  type ConfirmPayload,
  isDesktopCommandResult,
  makeDesktopCommandRequest,
  type OpenInAppPayload,
  type OpenInAppResult,
  type OpenInChromePayload,
  type OpenInChromeResult,
  type SetKeepAwakePayload,
  type SetSessionQueuedStatePayload,
  type UpdateMenuStatePayload
} from '../../../shared/desktop-command'
import type { SystemAppPaths } from '../../../shared/system-types'
import type { RpcHandler } from '../router'

type SystemDesktopCommandName =
  | 'quitApp'
  | 'confirm'
  | 'systemGetAppVersion'
  | 'systemGetAppPaths'
  | 'systemIsPackaged'
  | 'openInApp'
  | 'openInChrome'
  | 'updateMenuState'
  | 'setKeepAwake'
  | 'sleepNow'
  | 'setSessionQueuedState'

export interface SystemOpsRpcService {
  readonly getLogDir: () => Effect.Effect<string, unknown, never>
  readonly getAppVersion: () => Effect.Effect<string, unknown, never>
  readonly getAppPaths: () => Effect.Effect<SystemAppPaths, unknown, never>
  readonly isLogMode: () => Effect.Effect<boolean, unknown, never>
  readonly detectAgentSdks: () => Effect.Effect<AgentSdkDetectionResult, unknown, never>
  readonly quitApp: () => Effect.Effect<void, unknown, never>
  readonly confirm?: (message: string) => Effect.Effect<boolean, unknown, never>
  readonly openInApp: (
    appName: string,
    path: string
  ) => Effect.Effect<OpenInAppResult, unknown, never>
  readonly openInChrome?: (
    url: string,
    customCommand?: string
  ) => Effect.Effect<OpenInChromeResult, unknown, never>
  readonly updateMenuState?: (state: UpdateMenuStatePayload) => Effect.Effect<void, unknown, never>
  readonly isPackaged?: () => Effect.Effect<boolean, unknown, never>
  readonly getPlatform?: () => Effect.Effect<NodeJS.Platform, unknown, never>
  readonly setKeepAwake?: (active: boolean) => Effect.Effect<void, unknown, never>
  readonly sleepNow?: () => Effect.Effect<boolean, unknown, never>
  readonly setSessionQueuedState?: (
    sessionId: string,
    hasQueued: boolean
  ) => Effect.Effect<void, unknown, never>
}

export interface AgentSdkDetectionResult {
  readonly opencode: boolean
  readonly claude: boolean
  readonly codex: boolean
  /** Optional so pre-existing service stubs remain assignable; the live detector always sets it. */
  readonly codexCli?: boolean
}

const emptyParamsSchema = z.union([z.object({}).strict(), z.undefined(), z.null()])
const openInAppParamsSchema = z
  .object({
    appName: z.string().min(1),
    path: z.string()
  })
  .strict()
const confirmParamsSchema = z
  .object({
    message: z.string()
  })
  .strict()
const openInChromeParamsSchema = z
  .object({
    url: z.string().min(1),
    customCommand: z.string().min(1).optional()
  })
  .strict()
const updateMenuStateParamsSchema = z
  .object({
    hasActiveSession: z.boolean(),
    hasActiveWorktree: z.boolean(),
    canUndo: z.boolean().optional(),
    canRedo: z.boolean().optional()
  })
  .strict()
const setKeepAwakeParamsSchema = z
  .object({
    active: z.boolean()
  })
  .strict()
const setSessionQueuedStateParamsSchema = z
  .object({
    sessionId: z.string().min(1),
    hasQueued: z.boolean()
  })
  .strict()

export const makeLiveSystemOpsRpcService = (): SystemOpsRpcService => ({
  getLogDir: () =>
    Effect.tryPromise({
      try: async () => {
        const { getLogDir } = await import('../../../main/services/logger')
        return getLogDir()
      },
      catch: (cause) => cause
    }),
  getAppVersion: () =>
    Effect.tryPromise({
      try: () => requestDesktopCommand<string>('systemGetAppVersion'),
      catch: (cause) => cause
    }),
  getAppPaths: () =>
    Effect.tryPromise({
      try: async (): Promise<SystemAppPaths> => {
        const [{ getLogDir }, appPaths] = await Promise.all([
          import('../../../main/services/logger'),
          requestDesktopCommand<Pick<SystemAppPaths, 'userData' | 'home'>>('systemGetAppPaths')
        ])
        return {
          userData: appPaths.userData,
          home: appPaths.home,
          logs: getLogDir()
        }
      },
      catch: (cause) => cause
    }),
  isLogMode: () =>
    Effect.try({
      try: () => process.argv.slice(2).includes('--log'),
      catch: (cause) => cause
    }),
  detectAgentSdks: () =>
    Effect.tryPromise({
      try: async (): Promise<AgentSdkDetectionResult> => {
        const [{ detectAgentSdks }, { resolveOpenCodeLaunchSpec }] = await Promise.all([
          import('../../../main/services/system-info'),
          import('../../../main/services/opencode-binary-resolver')
        ])
        return detectAgentSdks(resolveOpenCodeLaunchSpec())
      },
      catch: (cause) => cause
    }),
  quitApp: () =>
    Effect.tryPromise({
      try: () => requestDesktopCommand('quitApp').then(() => undefined),
      catch: (cause) => cause
    }),
  confirm: (message) =>
    Effect.tryPromise({
      try: () => requestDesktopCommand<boolean>('confirm', { message }),
      catch: (cause) => cause
    }),
  openInApp: (appName, path) =>
    Effect.tryPromise({
      try: () => requestDesktopCommand<OpenInAppResult>('openInApp', { appName, path }),
      catch: (cause) => cause
    }),
  openInChrome: (url, customCommand) =>
    Effect.tryPromise({
      try: () =>
        requestDesktopCommand<OpenInChromeResult>('openInChrome', {
          url,
          ...(customCommand === undefined ? {} : { customCommand })
        }),
      catch: (cause) => cause
    }),
  updateMenuState: (state) =>
    Effect.tryPromise({
      try: () => requestDesktopCommand<void>('updateMenuState', state).then(() => undefined),
      catch: (cause) => cause
    }),
  isPackaged: () =>
    Effect.tryPromise({
      try: () => requestDesktopCommand<boolean>('systemIsPackaged'),
      catch: (cause) => cause
    }),
  getPlatform: () =>
    Effect.try({
      try: () => process.platform,
      catch: (cause) => cause
    }),
  setKeepAwake: (active) =>
    Effect.tryPromise({
      try: () => requestDesktopCommand<void>('setKeepAwake', { active }).then(() => undefined),
      catch: (cause) => cause
    }),
  sleepNow: () =>
    Effect.tryPromise({
      try: () => requestDesktopCommand<boolean>('sleepNow'),
      catch: (cause) => cause
    }),
  setSessionQueuedState: (sessionId, hasQueued) =>
    Effect.tryPromise({
      try: () =>
        requestDesktopCommand<void>('setSessionQueuedState', { sessionId, hasQueued }).then(
          () => undefined
        ),
      catch: (cause) => cause
    })
})

export const makeSystemOpsRpcHandlers = (
  service: SystemOpsRpcService = makeLiveSystemOpsRpcService()
): ReadonlyMap<string, RpcHandler> =>
  new Map<string, RpcHandler>([
    [
      'systemOps.getLogDir',
      (params) =>
        Effect.gen(function* () {
          yield* Effect.try({
            try: () => emptyParamsSchema.parse(params),
            catch: (cause) => cause
          })
          return yield* service.getLogDir()
        })
    ],
    [
      'systemOps.getAppVersion',
      (params) =>
        Effect.gen(function* () {
          yield* Effect.try({
            try: () => emptyParamsSchema.parse(params),
            catch: (cause) => cause
          })
          return yield* service.getAppVersion()
        })
    ],
    [
      'systemOps.getAppPaths',
      (params) =>
        Effect.gen(function* () {
          yield* Effect.try({
            try: () => emptyParamsSchema.parse(params),
            catch: (cause) => cause
          })
          return yield* service.getAppPaths()
        })
    ],
    [
      'systemOps.isLogMode',
      (params) =>
        Effect.gen(function* () {
          yield* Effect.try({
            try: () => emptyParamsSchema.parse(params),
            catch: (cause) => cause
          })
          return yield* service.isLogMode()
        })
    ],
    [
      'systemOps.detectAgentSdks',
      (params) =>
        Effect.gen(function* () {
          yield* Effect.try({
            try: () => emptyParamsSchema.parse(params),
            catch: (cause) => cause
          })
          return yield* service.detectAgentSdks()
        })
    ],
    [
      'systemOps.quitApp',
      (params) =>
        Effect.gen(function* () {
          yield* Effect.try({
            try: () => emptyParamsSchema.parse(params),
            catch: (cause) => cause
          })
          return yield* service.quitApp()
        })
    ],
    [
      'systemOps.confirm',
      (params) =>
        Effect.gen(function* () {
          const { message } = yield* Effect.try({
            try: () => confirmParamsSchema.parse(params),
            catch: (cause) => cause
          })
          if (!service.confirm) {
            return yield* Effect.fail(new Error('systemOps.confirm is unavailable'))
          }
          return yield* service.confirm(message)
        })
    ],
    [
      'systemOps.openInApp',
      (params) =>
        Effect.gen(function* () {
          const { appName, path } = yield* Effect.try({
            try: () => openInAppParamsSchema.parse(params),
            catch: (cause) => cause
          })
          return yield* service.openInApp(appName, path)
        })
    ],
    [
      'systemOps.openInChrome',
      (params) =>
        Effect.gen(function* () {
          const { url, customCommand } = yield* Effect.try({
            try: () => openInChromeParamsSchema.parse(params),
            catch: (cause) => cause
          })
          if (!service.openInChrome) {
            return yield* Effect.fail(new Error('systemOps.openInChrome is unavailable'))
          }
          return yield* service.openInChrome(url, customCommand)
        })
    ],
    [
      'systemOps.updateMenuState',
      (params) =>
        Effect.gen(function* () {
          const state = yield* Effect.try({
            try: () => updateMenuStateParamsSchema.parse(params),
            catch: (cause) => cause
          })
          if (!service.updateMenuState) {
            return yield* Effect.fail(new Error('systemOps.updateMenuState is unavailable'))
          }
          return yield* service.updateMenuState(state)
        })
    ],
    [
      'systemOps.isPackaged',
      (params) =>
        Effect.gen(function* () {
          yield* Effect.try({
            try: () => emptyParamsSchema.parse(params),
            catch: (cause) => cause
          })
          if (!service.isPackaged) {
            return yield* Effect.fail(new Error('systemOps.isPackaged is unavailable'))
          }
          return yield* service.isPackaged()
        })
    ],
    [
      'systemOps.getPlatform',
      (params) =>
        Effect.gen(function* () {
          yield* Effect.try({
            try: () => emptyParamsSchema.parse(params),
            catch: (cause) => cause
          })
          if (!service.getPlatform) {
            return yield* Effect.fail(new Error('systemOps.getPlatform is unavailable'))
          }
          return yield* service.getPlatform()
        })
    ],
    [
      'systemOps.setKeepAwake',
      (params) =>
        Effect.gen(function* () {
          const { active } = yield* Effect.try({
            try: () => setKeepAwakeParamsSchema.parse(params),
            catch: (cause) => cause
          })
          if (!service.setKeepAwake) {
            return yield* Effect.fail(new Error('systemOps.setKeepAwake is unavailable'))
          }
          return yield* service.setKeepAwake(active)
        })
    ],
    [
      'systemOps.sleepNow',
      (params) =>
        Effect.gen(function* () {
          yield* Effect.try({
            try: () => emptyParamsSchema.parse(params),
            catch: (cause) => cause
          })
          if (!service.sleepNow) {
            return yield* Effect.fail(new Error('systemOps.sleepNow is unavailable'))
          }
          return yield* service.sleepNow()
        })
    ],
    [
      'systemOps.setSessionQueuedState',
      (params) =>
        Effect.gen(function* () {
          const { sessionId, hasQueued } = yield* Effect.try({
            try: () => setSessionQueuedStateParamsSchema.parse(params),
            catch: (cause) => cause
          })
          if (!service.setSessionQueuedState) {
            return yield* Effect.fail(new Error('systemOps.setSessionQueuedState is unavailable'))
          }
          return yield* service.setSessionQueuedState(sessionId, hasQueued)
        })
    ]
  ])

const requestDesktopCommand = <A = unknown>(
  command: SystemDesktopCommandName,
  payload?:
    | OpenInAppPayload
    | ConfirmPayload
    | OpenInChromePayload
    | UpdateMenuStatePayload
    | SetKeepAwakePayload
    | SetSessionQueuedStatePayload
): Promise<A> => {
  const send = process.send
  if (typeof send !== 'function') {
    if (command === 'systemGetAppVersion') {
      return import('node:fs/promises').then(async ({ readFile }) => {
        try {
          const raw = await readFile('package.json', 'utf-8')
          const parsed = JSON.parse(raw) as { readonly version?: unknown }
          return (typeof parsed.version === 'string' ? parsed.version : '') as A
        } catch {
          return '' as A
        }
      })
    }

    if (command === 'systemGetAppPaths') {
      return import('node:os').then(({ homedir }) => {
        const home = homedir()
        return {
          userData: process.env.HIVE_SERVER_BASE_DIR ?? home,
          home
        } as A
      })
    }

    if (command === 'systemIsPackaged') {
      return Promise.resolve(false as A)
    }

    if (command === 'quitApp') {
      return Promise.resolve(undefined as A)
    }

    if (command === 'openInApp') {
      if (!payload) throw new Error('Missing openInApp payload')
      const openInAppPayload = payload as OpenInAppPayload
      return import('../../../main/services/open-in-app').then(({ openInApp }) =>
        openInApp(openInAppPayload.appName, openInAppPayload.path)
      ) as Promise<A>
    }

    if (command === 'confirm') {
      if (!payload) throw new Error('Missing confirm payload')
      return Promise.resolve(false as A)
    }

    if (command === 'updateMenuState') {
      if (!payload) throw new Error('Missing updateMenuState payload')
      return Promise.resolve(undefined as A)
    }

    if (command === 'setKeepAwake') {
      if (!payload) throw new Error('Missing setKeepAwake payload')
      return Promise.resolve(undefined as A)
    }

    if (command === 'sleepNow') {
      return import('../../../main/services/sleep-now').then(({ sleepNow }) => sleepNow() as A)
    }

    if (command === 'setSessionQueuedState') {
      if (!payload) throw new Error('Missing setSessionQueuedState payload')
      return Promise.resolve(undefined as A)
    }

    if (!payload) throw new Error('Missing openInChrome payload')
    const openInChromePayload = payload as OpenInChromePayload
    return import('../../../main/services/open-in-chrome').then(({ openInChrome }) =>
      openInChrome(openInChromePayload.url, openInChromePayload.customCommand)
    ) as Promise<A>
  }

  const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
  return new Promise<A>((resolve, reject) => {
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
        resolve(message.value as A)
        return
      }
      reject(new Error(message.error ?? `Desktop command failed: ${command}`))
    }

    process.on('message', onMessage)
    const request = (() => {
      if (command === 'openInApp') {
        if (!payload) {
          cleanup()
          reject(new Error('Missing openInApp payload'))
          return null
        }
        return makeDesktopCommandRequest(id, command, payload as OpenInAppPayload)
      }

      if (command === 'confirm') {
        if (!payload) {
          cleanup()
          reject(new Error('Missing confirm payload'))
          return null
        }
        return makeDesktopCommandRequest(id, command, payload as ConfirmPayload)
      }

      if (command === 'openInChrome') {
        if (!payload) {
          cleanup()
          reject(new Error('Missing openInChrome payload'))
          return null
        }
        return makeDesktopCommandRequest(id, command, payload as OpenInChromePayload)
      }

      if (command === 'updateMenuState') {
        if (!payload) {
          cleanup()
          reject(new Error('Missing updateMenuState payload'))
          return null
        }
        return makeDesktopCommandRequest(id, command, payload as UpdateMenuStatePayload)
      }

      if (command === 'setKeepAwake') {
        if (!payload) {
          cleanup()
          reject(new Error('Missing setKeepAwake payload'))
          return null
        }
        return makeDesktopCommandRequest(id, command, payload as SetKeepAwakePayload)
      }

      if (command === 'setSessionQueuedState') {
        if (!payload) {
          cleanup()
          reject(new Error('Missing setSessionQueuedState payload'))
          return null
        }
        return makeDesktopCommandRequest(id, command, payload as SetSessionQueuedStatePayload)
      }

      return makeDesktopCommandRequest(id, command)
    })()
    if (!request) return

    send.call(process, request, (error) => {
      if (!error) return
      cleanup()
      reject(error)
    })
  })
}
