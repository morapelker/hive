import { existsSync, statSync } from 'node:fs'
import { basename, join } from 'node:path'
import { Effect } from 'effect'
import { z } from 'zod'
import { isDesktopCommandResult, makeDesktopCommandRequest } from '../../../shared/desktop-command'
import type { SuggestionItem } from '../../../shared/types/setup-suggestions'
import type { RpcHandler } from '../router'

export interface ProjectOpsRpcService {
  readonly openDirectoryDialog: () => Effect.Effect<string | null, unknown, never>
  readonly showInFolder: (path: string) => Effect.Effect<void, unknown, never>
  readonly openPath: (path: string) => Effect.Effect<string, unknown, never>
  readonly copyToClipboard: (text: string) => Effect.Effect<void, unknown, never>
  readonly readFromClipboard: () => Effect.Effect<string, unknown, never>
  readonly isGitRepository: (path: string) => Effect.Effect<boolean, unknown, never>
  readonly validateProject: (path: string) => Effect.Effect<ProjectValidationResult, unknown, never>
  readonly detectLanguage: (projectPath: string) => Effect.Effect<string | null, unknown, never>
  readonly detectSetupSuggestions: (
    projectPath: string
  ) => Effect.Effect<SuggestionItem[], unknown, never>
  readonly findXcworkspace: (projectPath: string) => Effect.Effect<string | null, unknown, never>
  readonly isAndroidProject: (projectPath: string) => Effect.Effect<boolean, unknown, never>
  readonly loadLanguageIcons: () => Effect.Effect<Record<string, string>, unknown, never>
  readonly initRepository: (path: string) => Effect.Effect<InitRepositoryResult, unknown, never>
  readonly pickProjectIcon: (
    projectId: string
  ) => Effect.Effect<PickProjectIconResult, unknown, never>
  readonly removeProjectIcon: (
    projectId: string
  ) => Effect.Effect<RemoveProjectIconResult, unknown, never>
  readonly getProjectIconPath: (filename: string) => Effect.Effect<string | null, unknown, never>
  readonly detectFavicon: (projectPath: string) => Effect.Effect<string | null, unknown, never>
  readonly getAbsoluteIconDataUrl: (
    absolutePath: string
  ) => Effect.Effect<string | null, unknown, never>
}

export interface ProjectValidationResult {
  readonly success: boolean
  readonly path?: string
  readonly name?: string
  readonly error?: string
}

export interface InitRepositoryResult {
  readonly success: boolean
  readonly error?: string
}

export interface PickProjectIconResult {
  readonly success: boolean
  readonly filename?: string
  readonly error?: string
}

export interface RemoveProjectIconResult {
  readonly success: boolean
  readonly error?: string
}

const pathParamsSchema = z.object({ path: z.string().min(1) }).strict()
const textParamsSchema = z.object({ text: z.string() }).strict()
const projectIdParamsSchema = z.object({ projectId: z.string().min(1) }).strict()
const filenameParamsSchema = z.object({ filename: z.string().min(1) }).strict()
const emptyParamsSchema = z.union([z.object({}).strict(), z.undefined(), z.null()])

const isValidDirectory = (path: string): boolean => {
  try {
    return existsSync(path) && statSync(path).isDirectory()
  } catch {
    return false
  }
}

const isGitRepositoryPath = (path: string): boolean => {
  try {
    const gitPath = join(path, '.git')
    return existsSync(gitPath) && statSync(gitPath).isDirectory()
  } catch {
    return false
  }
}

export const makeLiveProjectOpsRpcService = (): ProjectOpsRpcService => ({
  openDirectoryDialog: () =>
    Effect.tryPromise({
      try: () => requestProjectOpenDirectoryDialog(),
      catch: (cause) => cause
    }),
  showInFolder: (path) =>
    Effect.tryPromise({
      try: () => requestProjectShowInFolder(path),
      catch: (cause) => cause
    }),
  openPath: (path) =>
    Effect.tryPromise({
      try: () => requestProjectOpenPath(path),
      catch: (cause) => cause
    }),
  copyToClipboard: (text) =>
    Effect.tryPromise({
      try: () => requestProjectWriteClipboardText(text),
      catch: (cause) => cause
    }),
  readFromClipboard: () =>
    Effect.tryPromise({
      try: () => requestProjectReadClipboardText(),
      catch: (cause) => cause
    }),
  isGitRepository: (path) =>
    Effect.try({
      try: () => isGitRepositoryPath(path),
      catch: () => false
    }),
  validateProject: (path) =>
    Effect.sync(() => {
      if (!isValidDirectory(path)) {
        return {
          success: false,
          error: 'The selected path is not a valid directory.'
        }
      }

      if (!isGitRepositoryPath(path)) {
        return {
          success: false,
          error:
            'The selected folder is not a Git repository. Please select a folder containing a .git directory.'
        }
      }

      return {
        success: true,
        path,
        name: basename(path)
      }
    }),
  detectLanguage: (projectPath) =>
    Effect.tryPromise({
      try: async () => {
        const { detectProjectLanguage } = await import('../../../main/services/language-detector')
        return detectProjectLanguage(projectPath)
      },
      catch: (cause) => cause
    }),
  detectSetupSuggestions: (projectPath) =>
    Effect.tryPromise({
      try: async () => {
        const { detectSetupSuggestions } = await import(
          '../../../main/services/setup-script-suggester'
        )
        return detectSetupSuggestions(projectPath)
      },
      catch: (cause) => cause
    }),
  findXcworkspace: (projectPath) =>
    Effect.tryPromise({
      try: async () => {
        const { findXcworkspace } = await import('../../../main/services/language-detector')
        return findXcworkspace(projectPath)
      },
      catch: (cause) => cause
    }),
  isAndroidProject: (projectPath) =>
    Effect.tryPromise({
      try: async () => {
        const { isAndroidProject } = await import('../../../main/services/language-detector')
        return isAndroidProject(projectPath)
      },
      catch: (cause) => cause
    }),
  loadLanguageIcons: () =>
    Effect.tryPromise({
      try: async () => {
        const { loadLanguageIcons } = await import('../../../main/services/language-icons')
        return loadLanguageIcons()
      },
      catch: (cause) => cause
    }),
  initRepository: (path) =>
    Effect.tryPromise({
      try: async () => {
        const { initRepository } = await import('../../../main/services/git-repository')
        return initRepository(path)
      },
      catch: (cause) => cause
    }),
  pickProjectIcon: (projectId) =>
    Effect.tryPromise({
      try: () => requestProjectPickProjectIcon(projectId),
      catch: (cause) => cause
    }),
  removeProjectIcon: (projectId) =>
    Effect.tryPromise({
      try: () => requestProjectRemoveProjectIcon(projectId),
      catch: (cause) => cause
    }),
  getProjectIconPath: (filename) =>
    Effect.tryPromise({
      try: () => requestProjectGetProjectIconPath(filename),
      catch: (cause) => cause
    }),
  detectFavicon: (projectPath) =>
    Effect.tryPromise({
      try: async () => {
        const { detectProjectFavicon } = await import('../../../main/services/language-detector')
        return detectProjectFavicon(projectPath)
      },
      catch: (cause) => cause
    }),
  getAbsoluteIconDataUrl: (absolutePath) =>
    Effect.tryPromise({
      try: async () => {
        const { getAbsoluteIconDataUrl } = await import('../../../main/services/project-icons')
        return getAbsoluteIconDataUrl(absolutePath)
      },
      catch: (cause) => cause
    })
})

const requestProjectOpenDirectoryDialog = (): Promise<string | null> => {
  const send = process.send
  if (typeof send !== 'function') {
    return Promise.resolve(null)
  }

  const id = `project-open-directory-dialog-${Date.now()}-${Math.random().toString(36).slice(2)}`
  const command = 'projectOpenDirectoryDialog'

  return new Promise<string | null>((resolve, reject) => {
    let settled = false
    const cleanup = (): void => {
      clearTimeout(timeout)
      process.off('message', onMessage)
    }
    const finish = (value?: string | null, error?: Error): void => {
      if (settled) return
      settled = true
      cleanup()
      if (error) {
        reject(error)
        return
      }
      resolve(value ?? null)
    }
    const timeout = setTimeout(() => {
      finish(null, new Error(`Timed out waiting for desktop command response: ${command}`))
    }, 5_000)

    const onMessage = (message: unknown): void => {
      if (!isDesktopCommandResult(message) || message.id !== id) return
      if (!message.ok) {
        finish(null, new Error(message.error ?? `Desktop command failed: ${command}`))
        return
      }
      if (message.value !== null && typeof message.value !== 'string') {
        finish(null, new Error(`Desktop command returned invalid selected path: ${command}`))
        return
      }
      finish(message.value)
    }

    process.on('message', onMessage)
    send.call(process, makeDesktopCommandRequest(id, command), (error) => {
      if (!error) return
      finish(null, error)
    })
  })
}

const requestProjectShowInFolder = (path: string): Promise<void> => {
  const send = process.send
  if (typeof send !== 'function') {
    return Promise.resolve()
  }

  const id = `project-show-in-folder-${Date.now()}-${Math.random().toString(36).slice(2)}`
  const command = 'projectShowInFolder'

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
    send.call(process, makeDesktopCommandRequest(id, command, { path }), (error) => {
      if (!error) return
      finish(error)
    })
  })
}

const requestProjectOpenPath = (path: string): Promise<string> => {
  const send = process.send
  if (typeof send !== 'function') {
    return Promise.resolve('')
  }

  const id = `project-open-path-${Date.now()}-${Math.random().toString(36).slice(2)}`
  const command = 'projectOpenPath'

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
        finish(undefined, new Error(`Desktop command returned invalid open-path result: ${command}`))
        return
      }
      finish(message.value)
    }

    process.on('message', onMessage)
    send.call(process, makeDesktopCommandRequest(id, command, { path }), (error) => {
      if (!error) return
      finish(undefined, error)
    })
  })
}

const requestProjectWriteClipboardText = (text: string): Promise<void> => {
  const send = process.send
  if (typeof send !== 'function') {
    return Promise.resolve()
  }

  const id = `project-write-clipboard-text-${Date.now()}-${Math.random().toString(36).slice(2)}`
  const command = 'projectWriteClipboardText'

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
    send.call(process, makeDesktopCommandRequest(id, command, { text }), (error) => {
      if (!error) return
      finish(error)
    })
  })
}

const requestProjectReadClipboardText = (): Promise<string> => {
  const send = process.send
  if (typeof send !== 'function') {
    return Promise.resolve('')
  }

  const id = `project-read-clipboard-text-${Date.now()}-${Math.random().toString(36).slice(2)}`
  const command = 'projectReadClipboardText'

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
        finish(undefined, new Error(`Desktop command returned invalid clipboard text: ${command}`))
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

const requestProjectPickProjectIcon = (projectId: string): Promise<PickProjectIconResult> => {
  const send = process.send
  if (typeof send !== 'function') {
    return Promise.resolve({ success: false, error: 'cancelled' })
  }

  const id = `project-pick-project-icon-${Date.now()}-${Math.random().toString(36).slice(2)}`
  const command = 'projectPickProjectIcon'

  return new Promise<PickProjectIconResult>((resolve, reject) => {
    let settled = false
    const cleanup = (): void => {
      clearTimeout(timeout)
      process.off('message', onMessage)
    }
    const finish = (value?: PickProjectIconResult, error?: Error): void => {
      if (settled) return
      settled = true
      cleanup()
      if (error) {
        reject(error)
        return
      }
      resolve(value ?? { success: false, error: 'cancelled' })
    }
    const timeout = setTimeout(() => {
      finish(
        undefined,
        new Error(`Timed out waiting for desktop command response: ${command}`)
      )
    }, 5_000)

    const onMessage = (message: unknown): void => {
      if (!isDesktopCommandResult(message) || message.id !== id) return
      if (!message.ok) {
        finish(undefined, new Error(message.error ?? `Desktop command failed: ${command}`))
        return
      }
      if (!isPickProjectIconResult(message.value)) {
        finish(
          undefined,
          new Error(`Desktop command returned invalid project icon result: ${command}`)
        )
        return
      }
      finish(message.value)
    }

    process.on('message', onMessage)
    send.call(process, makeDesktopCommandRequest(id, command, { projectId }), (error) => {
      if (!error) return
      finish(undefined, error)
    })
  })
}

const isPickProjectIconResult = (value: unknown): value is PickProjectIconResult => {
  if (!value || typeof value !== 'object') return false
  const result = value as Record<string, unknown>
  return (
    typeof result.success === 'boolean' &&
    (result.filename === undefined || typeof result.filename === 'string') &&
    (result.error === undefined || typeof result.error === 'string')
  )
}

const requestProjectRemoveProjectIcon = (projectId: string): Promise<RemoveProjectIconResult> => {
  const send = process.send
  if (typeof send !== 'function') {
    return Promise.resolve({ success: true })
  }

  const id = `project-remove-project-icon-${Date.now()}-${Math.random().toString(36).slice(2)}`
  const command = 'projectRemoveProjectIcon'

  return new Promise<RemoveProjectIconResult>((resolve, reject) => {
    let settled = false
    const cleanup = (): void => {
      clearTimeout(timeout)
      process.off('message', onMessage)
    }
    const finish = (value?: RemoveProjectIconResult, error?: Error): void => {
      if (settled) return
      settled = true
      cleanup()
      if (error) {
        reject(error)
        return
      }
      resolve(value ?? { success: true })
    }
    const timeout = setTimeout(() => {
      finish(
        undefined,
        new Error(`Timed out waiting for desktop command response: ${command}`)
      )
    }, 5_000)

    const onMessage = (message: unknown): void => {
      if (!isDesktopCommandResult(message) || message.id !== id) return
      if (!message.ok) {
        finish(undefined, new Error(message.error ?? `Desktop command failed: ${command}`))
        return
      }
      if (!isRemoveProjectIconResult(message.value)) {
        finish(
          undefined,
          new Error(`Desktop command returned invalid project icon removal result: ${command}`)
        )
        return
      }
      finish(message.value)
    }

    process.on('message', onMessage)
    send.call(process, makeDesktopCommandRequest(id, command, { projectId }), (error) => {
      if (!error) return
      finish(undefined, error)
    })
  })
}

const isRemoveProjectIconResult = (value: unknown): value is RemoveProjectIconResult => {
  if (!value || typeof value !== 'object') return false
  const result = value as Record<string, unknown>
  return (
    typeof result.success === 'boolean' &&
    (result.error === undefined || typeof result.error === 'string')
  )
}

const requestProjectGetProjectIconPath = (filename: string): Promise<string | null> => {
  const send = process.send
  if (typeof send !== 'function') {
    return Promise.resolve(null)
  }

  const id = `project-get-project-icon-path-${Date.now()}-${Math.random().toString(36).slice(2)}`
  const command = 'projectGetProjectIconPath'

  return new Promise<string | null>((resolve, reject) => {
    let settled = false
    const cleanup = (): void => {
      clearTimeout(timeout)
      process.off('message', onMessage)
    }
    const finish = (value?: string | null, error?: Error): void => {
      if (settled) return
      settled = true
      cleanup()
      if (error) {
        reject(error)
        return
      }
      resolve(value ?? null)
    }
    const timeout = setTimeout(() => {
      finish(
        null,
        new Error(`Timed out waiting for desktop command response: ${command}`)
      )
    }, 5_000)

    const onMessage = (message: unknown): void => {
      if (!isDesktopCommandResult(message) || message.id !== id) return
      if (!message.ok) {
        finish(null, new Error(message.error ?? `Desktop command failed: ${command}`))
        return
      }
      if (message.value !== null && typeof message.value !== 'string') {
        finish(
          null,
          new Error(`Desktop command returned invalid project icon data URL: ${command}`)
        )
        return
      }
      finish(message.value)
    }

    process.on('message', onMessage)
    send.call(process, makeDesktopCommandRequest(id, command, { filename }), (error) => {
      if (!error) return
      finish(null, error)
    })
  })
}

export const makeProjectOpsRpcHandlers = (
  service: ProjectOpsRpcService = makeLiveProjectOpsRpcService()
): ReadonlyMap<string, RpcHandler> =>
  new Map<string, RpcHandler>([
    [
      'projectOps.openDirectoryDialog',
      (params) =>
        Effect.gen(function* () {
          yield* Effect.try({
            try: () => emptyParamsSchema.parse(params),
            catch: (cause) => cause
          })
          return yield* service.openDirectoryDialog()
        })
    ],
    [
      'projectOps.showInFolder',
      (params) =>
        Effect.gen(function* () {
          const { path } = yield* Effect.try({
            try: () => pathParamsSchema.parse(params),
            catch: (cause) => cause
          })
          return yield* service.showInFolder(path)
        })
    ],
    [
      'projectOps.openPath',
      (params) =>
        Effect.gen(function* () {
          const { path } = yield* Effect.try({
            try: () => pathParamsSchema.parse(params),
            catch: (cause) => cause
          })
          return yield* service.openPath(path)
        })
    ],
    [
      'projectOps.copyToClipboard',
      (params) =>
        Effect.gen(function* () {
          const { text } = yield* Effect.try({
            try: () => textParamsSchema.parse(params),
            catch: (cause) => cause
          })
          return yield* service.copyToClipboard(text)
        })
    ],
    [
      'projectOps.readFromClipboard',
      (params) =>
        Effect.gen(function* () {
          yield* Effect.try({
            try: () => emptyParamsSchema.parse(params),
            catch: (cause) => cause
          })
          return yield* service.readFromClipboard()
        })
    ],
    [
      'projectOps.isGitRepository',
      (params) =>
        Effect.gen(function* () {
          const { path } = yield* Effect.try({
            try: () => pathParamsSchema.parse(params),
            catch: (cause) => cause
          })
          return yield* service.isGitRepository(path)
        })
    ],
    [
      'projectOps.validateProject',
      (params) =>
        Effect.gen(function* () {
          const { path } = yield* Effect.try({
            try: () => pathParamsSchema.parse(params),
            catch: (cause) => cause
          })
          return yield* service.validateProject(path)
        })
    ],
    [
      'projectOps.detectLanguage',
      (params) =>
        Effect.gen(function* () {
          const { path } = yield* Effect.try({
            try: () => pathParamsSchema.parse(params),
            catch: (cause) => cause
          })
          return yield* service.detectLanguage(path)
        })
    ],
    [
      'projectOps.detectSetupSuggestions',
      (params) =>
        Effect.gen(function* () {
          const { path } = yield* Effect.try({
            try: () => pathParamsSchema.parse(params),
            catch: (cause) => cause
          })
          return yield* service.detectSetupSuggestions(path)
        })
    ],
    [
      'projectOps.findXcworkspace',
      (params) =>
        Effect.gen(function* () {
          const { path } = yield* Effect.try({
            try: () => pathParamsSchema.parse(params),
            catch: (cause) => cause
          })
          return yield* service.findXcworkspace(path)
        })
    ],
    [
      'projectOps.isAndroidProject',
      (params) =>
        Effect.gen(function* () {
          const { path } = yield* Effect.try({
            try: () => pathParamsSchema.parse(params),
            catch: (cause) => cause
          })
          return yield* service.isAndroidProject(path)
        })
    ],
    [
      'projectOps.loadLanguageIcons',
      (params) =>
        Effect.gen(function* () {
          yield* Effect.try({
            try: () => emptyParamsSchema.parse(params),
            catch: (cause) => cause
          })
          return yield* service.loadLanguageIcons()
        })
    ],
    [
      'projectOps.initRepository',
      (params) =>
        Effect.gen(function* () {
          const { path } = yield* Effect.try({
            try: () => pathParamsSchema.parse(params),
            catch: (cause) => cause
          })
          return yield* service.initRepository(path)
        })
    ],
    [
      'projectOps.pickProjectIcon',
      (params) =>
        Effect.gen(function* () {
          const { projectId } = yield* Effect.try({
            try: () => projectIdParamsSchema.parse(params),
            catch: (cause) => cause
          })
          return yield* service.pickProjectIcon(projectId)
        })
    ],
    [
      'projectOps.removeProjectIcon',
      (params) =>
        Effect.gen(function* () {
          const { projectId } = yield* Effect.try({
            try: () => projectIdParamsSchema.parse(params),
            catch: (cause) => cause
          })
          return yield* service.removeProjectIcon(projectId)
        })
    ],
    [
      'projectOps.getProjectIconPath',
      (params) =>
        Effect.gen(function* () {
          const { filename } = yield* Effect.try({
            try: () => filenameParamsSchema.parse(params),
            catch: (cause) => cause
          })
          return yield* service.getProjectIconPath(filename)
        })
    ],
    [
      'projectOps.detectFavicon',
      (params) =>
        Effect.gen(function* () {
          const { path } = yield* Effect.try({
            try: () => pathParamsSchema.parse(params),
            catch: (cause) => cause
          })
          return yield* service.detectFavicon(path)
        })
    ],
    [
      'projectOps.getAbsoluteIconDataUrl',
      (params) =>
        Effect.gen(function* () {
          const { path } = yield* Effect.try({
            try: () => pathParamsSchema.parse(params),
            catch: (cause) => cause
          })
          return yield* service.getAbsoluteIconDataUrl(path)
        })
    ]
  ])
