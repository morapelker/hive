import { Effect } from 'effect'
import { z } from 'zod'
import { isDesktopCommandResult, makeDesktopCommandRequest } from '../../../shared/desktop-command'
import { detectEditors, detectTerminals } from '../../../main/services/settings-detection'
import { getAllSettingsMap } from '../../../main/services/settings-openers'
import {
  getCustomCommandsFilePath,
  loadCustomCommandsFromFile,
  saveCustomCommandsToFile,
  type CustomCommandFileResult
} from '../../../main/services/custom-commands-file-service'
import { getDatabase } from '../../../main/db'
import type { DetectedApp } from '../../../shared/types/settings'
import { APP_SETTINGS_DB_KEY } from '../../../shared/types/settings'
import type { CustomProjectCommand } from '../../../shared/lib/custom-commands'
import type { RpcHandler } from '../router'

export interface SettingsOperationResult {
  readonly success: boolean
  readonly error?: string
}

export interface ReloadCustomCommandsResult {
  readonly success: boolean
  readonly count?: number
  readonly mtime?: number | null
  readonly error?: string
}

export interface SaveCustomCommandsFileResult {
  readonly success: boolean
  readonly mtime?: number | null
  readonly error?: string
}

export interface SettingsOpsRpcService {
  readonly detectEditors: () => Effect.Effect<DetectedApp[], unknown, never>
  readonly detectTerminals: () => Effect.Effect<DetectedApp[], unknown, never>
  readonly getAll: () => Effect.Effect<Record<string, string>, unknown, never>
  readonly getCustomCommandsFilePath: () => Effect.Effect<string, unknown, never>
  readonly loadCustomCommandsFile: () => Effect.Effect<CustomCommandFileResult, unknown, never>
  readonly saveCustomCommandsFile: (
    commands: CustomProjectCommand[]
  ) => Effect.Effect<SaveCustomCommandsFileResult, unknown, never>
  readonly reloadCustomCommands: () => Effect.Effect<ReloadCustomCommandsResult, unknown, never>
  readonly openWithEditor: (
    worktreePath: string,
    editorId: string,
    customCommand?: string
  ) => Effect.Effect<SettingsOperationResult, unknown, never>
  readonly openWithTerminal: (
    worktreePath: string,
    terminalId: string,
    customCommand?: string
  ) => Effect.Effect<SettingsOperationResult, unknown, never>
}

const emptyParamsSchema = z.union([z.object({}).strict(), z.undefined(), z.null()])
const customCommandSchema = z
  .object({
    id: z.string().min(1),
    name: z.string(),
    prompt: z.string()
  })
  .strict()
const saveCustomCommandsFileParamsSchema = z
  .object({
    commands: z.array(customCommandSchema)
  })
  .strict()
const openWithEditorParamsSchema = z
  .object({
    worktreePath: z.string().min(1),
    editorId: z.string().min(1),
    customCommand: z.string().optional()
  })
  .strict()
const openWithTerminalParamsSchema = z
  .object({
    worktreePath: z.string().min(1),
    terminalId: z.string().min(1),
    customCommand: z.string().optional()
  })
  .strict()

export const makeLiveSettingsOpsRpcService = (): SettingsOpsRpcService => ({
  detectEditors: () =>
    Effect.sync(() => {
      try {
        return detectEditors()
      } catch {
        return []
      }
    }),
  detectTerminals: () =>
    Effect.sync(() => {
      try {
        return detectTerminals()
      } catch {
        return []
      }
    }),
  getAll: () => Effect.sync(() => getAllSettingsMap()),
  getCustomCommandsFilePath: () => Effect.sync(() => getCustomCommandsFilePath()),
  loadCustomCommandsFile: () =>
    Effect.sync(() => {
      try {
        return loadCustomCommandsFromFile()
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Unknown error'
        }
      }
    }),
  saveCustomCommandsFile: (commands) =>
    Effect.sync(() => {
      try {
        return saveCustomCommandsToFile(commands)
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Unknown error'
        }
      }
    }),
  reloadCustomCommands: () =>
    Effect.sync(() => {
      try {
        const fileResult = loadCustomCommandsFromFile()

        if (!fileResult.success) {
          return fileResult
        }

        if (fileResult.commands) {
          const db = getDatabase()
          const existingSettings = db.getSetting(APP_SETTINGS_DB_KEY)
          const settings =
            existingSettings && existingSettings.trim().length > 0
              ? (JSON.parse(existingSettings) as Record<string, unknown>)
              : {}

          settings.customProjectCommands = fileResult.commands
          db.setSetting(APP_SETTINGS_DB_KEY, JSON.stringify(settings))

          return {
            success: true,
            count: fileResult.commands.length,
            mtime: fileResult.mtime
          }
        }

        return { success: true, count: 0, mtime: fileResult.mtime }
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Unknown error'
        }
      }
    }),
  openWithEditor: (worktreePath, editorId, customCommand) =>
    Effect.tryPromise({
      try: () => requestOpenWithEditorCommand(worktreePath, editorId, customCommand),
      catch: (cause) => cause
    }),
  openWithTerminal: (worktreePath, terminalId, customCommand) =>
    Effect.tryPromise({
      try: () => requestOpenWithTerminalCommand(worktreePath, terminalId, customCommand),
      catch: (cause) => cause
    })
})

export const makeSettingsOpsRpcHandlers = (
  service: SettingsOpsRpcService = makeLiveSettingsOpsRpcService()
): ReadonlyMap<string, RpcHandler> =>
  new Map<string, RpcHandler>([
    [
      'settingsOps.detectEditors',
      (params) =>
        Effect.gen(function* () {
          yield* Effect.try({
            try: () => emptyParamsSchema.parse(params),
            catch: (cause) => cause
          })
          return yield* service.detectEditors()
        })
    ],
    [
      'settingsOps.detectTerminals',
      (params) =>
        Effect.gen(function* () {
          yield* Effect.try({
            try: () => emptyParamsSchema.parse(params),
            catch: (cause) => cause
          })
          return yield* service.detectTerminals()
        })
    ],
    [
      'settingsOps.getAll',
      (params) =>
        Effect.gen(function* () {
          yield* Effect.try({
            try: () => emptyParamsSchema.parse(params),
            catch: (cause) => cause
          })
          return yield* service.getAll()
        })
    ],
    [
      'settingsOps.getCustomCommandsFilePath',
      (params) =>
        Effect.gen(function* () {
          yield* Effect.try({
            try: () => emptyParamsSchema.parse(params),
            catch: (cause) => cause
          })
          return yield* service.getCustomCommandsFilePath()
        })
    ],
    [
      'settingsOps.loadCustomCommandsFile',
      (params) =>
        Effect.gen(function* () {
          yield* Effect.try({
            try: () => emptyParamsSchema.parse(params),
            catch: (cause) => cause
          })
          return yield* service.loadCustomCommandsFile()
        })
    ],
    [
      'settingsOps.saveCustomCommandsFile',
      (params) =>
        Effect.gen(function* () {
          const { commands } = yield* Effect.try({
            try: () => saveCustomCommandsFileParamsSchema.parse(params),
            catch: (cause) => cause
          })
          return yield* service.saveCustomCommandsFile(commands)
        })
    ],
    [
      'settingsOps.reloadCustomCommands',
      (params) =>
        Effect.gen(function* () {
          yield* Effect.try({
            try: () => emptyParamsSchema.parse(params),
            catch: (cause) => cause
          })
          return yield* service.reloadCustomCommands()
        })
    ],
    [
      'settingsOps.openWithEditor',
      (params) =>
        Effect.gen(function* () {
          const { worktreePath, editorId, customCommand } = yield* Effect.try({
            try: () => openWithEditorParamsSchema.parse(params),
            catch: (cause) => cause
          })
          return yield* service.openWithEditor(worktreePath, editorId, customCommand)
        })
    ],
    [
      'settingsOps.openWithTerminal',
      (params) =>
        Effect.gen(function* () {
          const { worktreePath, terminalId, customCommand } = yield* Effect.try({
            try: () => openWithTerminalParamsSchema.parse(params),
            catch: (cause) => cause
          })
          return yield* service.openWithTerminal(worktreePath, terminalId, customCommand)
        })
    ]
  ])

const requestOpenWithEditorCommand = (
  worktreePath: string,
  editorId: string,
  customCommand?: string
): Promise<SettingsOperationResult> => {
  const send = process.send
  if (typeof send !== 'function') {
    return import('../../../main/services/settings-openers').then(({ openPathWithEditor }) =>
      openPathWithEditor(worktreePath, editorId, customCommand)
    )
  }

  const command = 'settingsOpenWithEditor'
  const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
  return new Promise<SettingsOperationResult>((resolve, reject) => {
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
        const value = message.value
        if (
          typeof value === 'object' &&
          value !== null &&
          'success' in value &&
          typeof value.success === 'boolean'
        ) {
          resolve(value as SettingsOperationResult)
          return
        }
        reject(new Error(`Desktop command returned invalid response: ${command}`))
        return
      }
      reject(new Error(message.error ?? `Desktop command failed: ${command}`))
    }

    process.on('message', onMessage)
    send.call(
      process,
      makeDesktopCommandRequest(id, command, {
        worktreePath,
        editorId,
        ...(customCommand === undefined ? {} : { customCommand })
      }),
      (error) => {
        if (!error) return
        cleanup()
        reject(error)
      }
    )
  })
}

const requestOpenWithTerminalCommand = (
  worktreePath: string,
  terminalId: string,
  customCommand?: string
): Promise<SettingsOperationResult> => {
  const send = process.send
  if (typeof send !== 'function') {
    return import('../../../main/services/settings-openers').then(({ openPathWithTerminal }) =>
      openPathWithTerminal(worktreePath, terminalId, customCommand)
    )
  }

  const command = 'settingsOpenWithTerminal'
  const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
  return new Promise<SettingsOperationResult>((resolve, reject) => {
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
        const value = message.value
        if (
          typeof value === 'object' &&
          value !== null &&
          'success' in value &&
          typeof value.success === 'boolean'
        ) {
          resolve(value as SettingsOperationResult)
          return
        }
        reject(new Error(`Desktop command returned invalid response: ${command}`))
        return
      }
      reject(new Error(message.error ?? `Desktop command failed: ${command}`))
    }

    process.on('message', onMessage)
    send.call(
      process,
      makeDesktopCommandRequest(id, command, {
        worktreePath,
        terminalId,
        ...(customCommand === undefined ? {} : { customCommand })
      }),
      (error) => {
        if (!error) return
        cleanup()
        reject(error)
      }
    )
  })
}
