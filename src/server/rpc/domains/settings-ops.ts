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
import { getDatabase, type DatabaseService } from '../../../main/db'
import { getUserEnvironmentVariables } from '../../../main/services/env-vars'
import { runDevFolderExclusive } from '../../../main/services/dev-folder/exclusive'
import { DEV_FOLDER_PENDING_MOVE_KEY } from '../../../main/services/dev-folder/types'
import type { DetectedApp } from '../../../shared/types/settings'
import { APP_SETTINGS_DB_KEY } from '../../../shared/types/settings'
import {
  DEV_FOLDER_RPC,
  type DevFolderMovePlan,
  type DevFolderMoveResult,
  type DevFolderState,
  type MoveProjectToDevFolderParams,
  type SetDevFolderResult
} from '../../../shared/types/dev-folder'
import type { CustomProjectCommand } from '../../../shared/lib/custom-commands'
import {
  RUNNING_SESSIONS_REPORT_MAX,
  RUNNING_SESSIONS_REPORT_RPC
} from '../../../shared/session-running-state'
import type { RunningSessionsTracker } from '../../running-sessions'
import type { RpcHandler } from '../router'
import { getRpcRequestContext } from '../request-context'
import { RpcRouteError } from '../../../shared/rpc/errors'

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
  /** The dev folder in effect, the folders used before it and the projects still in those. */
  readonly getDevFolder: () => Effect.Effect<DevFolderState, unknown, never>
  /** Change the dev folder; `path: null` goes back to the default folder. */
  readonly setDevFolder: (params: {
    readonly path: string | null
  }) => Effect.Effect<SetDevFolderResult, unknown, never>
  /** What "Move projects" would do right now. Read-only. */
  readonly planDevFolderMove: () => Effect.Effect<DevFolderMovePlan, unknown, never>
  /** Move one project from a folder used before into the dev folder. */
  readonly moveProjectToDevFolder: (
    params: MoveProjectToDevFolderParams
  ) => Effect.Effect<DevFolderMoveResult, unknown, never>
  /**
   * The window says which of its sessions are running (working, or waiting on a person): the
   * whole set, replacing what it said before. `socketId` names the socket the report came
   * through; the report is forgotten when that socket closes.
   */
  readonly reportRunningSessions: (
    params: { readonly sessionIds: readonly string[] },
    socketId: string | null
  ) => Effect.Effect<{ readonly ok: true }, unknown, never>
}

/** What the live service needs beyond the database. */
export interface SettingsOpsServiceExtras {
  /**
   * The sessions this Mac's window reports as working or waiting: a project with one of them is
   * not moved. Absent means nothing was reported (and a report is accepted and dropped); what
   * the database and the terminals say about a project still counts.
   */
  readonly activity?:
    | (Pick<RunningSessionsTracker, 'runningSessionIds'> &
        Partial<Pick<RunningSessionsTracker, 'report'>>)
    | null
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
const setDevFolderParamsSchema = z
  .object({
    path: z.string().min(1).max(4096).nullable()
  })
  .strict()
const moveProjectToDevFolderParamsSchema = z
  .object({
    projectId: z.string().min(1),
    expectedToPath: z.string().min(1)
  })
  .strict()

const reportRunningSessionsParamsSchema = z
  .object({
    sessionIds: z.array(z.string().min(1).max(200)).max(RUNNING_SESSIONS_REPORT_MAX)
  })
  .strict()

/**
 * The dev folder is a setting of this Mac, and moving a project rewrites paths in its database
 * and on its disk, so only this Mac's own window may ask. A call with no request context (the
 * window on the loopback socket, a test) passes.
 */
const requireDesktopPrincipal = (): Effect.Effect<void, RpcRouteError> =>
  Effect.suspend(() =>
    getRpcRequestContext()?.principal?.kind === 'device'
      ? Effect.fail(new RpcRouteError('FORBIDDEN', 'Not available from a remote device'))
      : Effect.void
  )

// The dev folder modules are loaded on first use. The move service is bound to git, the file
// system, the boards, the connections and the terminals, and most calls to this domain never
// need any of that.
const loadDevFolderSettings = () => import('../../../main/services/dev-folder/dev-folder-settings')
const loadDevFolderMoves = () => import('../../../main/services/dev-folder/move-projects')
const loadLiveMoveDeps = async (extras: SettingsOpsServiceExtras) => {
  const { createLiveMoveProjectsDeps } = await import('../../../main/services/dev-folder/live-deps')
  return createLiveMoveProjectsDeps({ activity: extras.activity ?? null })
}

/** Why something failed, short enough to sit inside a sentence. */
const reasonOf = (error: unknown): string =>
  (error instanceof Error ? error.message : String(error)).replace(/[.\s]+$/, '')

/**
 * The dev folder as Settings shows it. The count of projects still in a folder used before is
 * a hint beside the folder: when it cannot be made, the folder is still answered and the hint
 * reads as "none".
 */
const readDevFolder = async (db: DatabaseService): Promise<DevFolderState> => {
  const { readDevFolderState } = await loadDevFolderSettings()
  const counter = await Promise.all([
    loadDevFolderMoves(),
    import('../../../main/services/dev-folder/live-query-deps')
  ]).catch((error: unknown) => {
    console.warn('[dev-folder] could not load the count of projects left behind', error)
    return null
  })
  // Nothing is awaited from here on: the folder and the count are one reading of the database.
  const state = readDevFolderState(db)
  let leftBehind: DevFolderState['leftBehind'] = { count: 0, folders: [] }
  if (counter) {
    const [{ countLeftBehind }, { createLiveMoveQueryDeps }] = counter
    try {
      leftBehind = countLeftBehind(createLiveMoveQueryDeps(db))
    } catch (error) {
      console.warn('[dev-folder] could not count the projects left behind', error)
    }
  }
  return { ...state, leftBehind }
}

const changeDevFolder = async (path: string | null): Promise<SetDevFolderResult> => {
  let db: DatabaseService
  try {
    db = getDatabase()
    const { createLiveSetDevFolderDeps, setDevFolder } = await loadDevFolderSettings()
    // A Claude config folder set in the app's own environment variables is as much the app's
    // as the one in the process environment: the dev folder may not be inside either.
    const env = { ...process.env, ...getUserEnvironmentVariables(db) }
    const outcome = setDevFolder(path, createLiveSetDevFolderDeps(db, { env }))
    if (!outcome.success) return outcome
  } catch (error) {
    // `setDevFolder` reports its own failures, so this is a failure before it ran: nothing
    // was written.
    return { success: false, error: `The dev folder could not be changed: ${reasonOf(error)}.` }
  }
  return { success: true, state: await readDevFolder(db) }
}

/**
 * The answer when a move could not be started at all (the move service or what it needs did
 * not load): nothing on disk and nothing in the database was touched.
 */
const moveNotStarted = (
  params: MoveProjectToDevFolderParams,
  error: unknown
): DevFolderMoveResult => {
  let project: { readonly name: string; readonly path: string } | null = null
  try {
    project = getDatabase().getProject(params.projectId)
  } catch {
    // The answer then names the project by its id only.
  }
  return {
    projectId: params.projectId,
    projectName: project?.name ?? '',
    action: 'failed',
    fromPath: project?.path ?? '',
    toPath: null,
    skipReason: null,
    detail: `This project was not moved: ${reasonOf(error)}. It is still in its old folder.`,
    warnings: [],
    movedPaths: []
  }
}

const moveProject = async (
  params: MoveProjectToDevFolderParams,
  extras: SettingsOpsServiceExtras
): Promise<DevFolderMoveResult> => {
  let move: () => Promise<DevFolderMoveResult>
  try {
    const [{ moveProjectToDevFolder }, deps] = await Promise.all([
      loadDevFolderMoves(),
      loadLiveMoveDeps(extras)
    ])
    move = () => moveProjectToDevFolder(params, deps)
  } catch (error) {
    return moveNotStarted(params, error)
  }
  // Outside the guard above: once the move has started, only its own answer says what happened.
  return move()
}

/**
 * Whether a move to the dev folder has left the note that its follow-up steps are owed. One
 * settings row is read; a row that cannot be read counts as none, and the plan or the move
 * that asked says what is wrong with the database.
 */
const moveIsOwed = (): boolean => {
  try {
    return Boolean(getDatabase().getSetting(DEV_FOLDER_PENDING_MOVE_KEY))
  } catch {
    return false
  }
}

/**
 * How long server start waits for a move that a quit interrupted. The desktop app ends a
 * server that has not answered within 30 seconds of being started, and would do so again on
 * every launch while the move is still owed: past this wait the server starts and the move is
 * finished behind it.
 */
const INTERRUPTED_MOVE_WAIT_MS = 10_000
/** The longest delay a Node timer takes; a longer one fires at once. */
const MAX_TIMER_MS = 2 ** 31 - 1

/**
 * Finish the move to the dev folder that a quit interrupted, if there is one: the project
 * already points at its new folder, and its worktree links, Claude state and connection
 * folders are still owed. The server calls this once while it starts, before it serves
 * anything, so no window reads the project in between. One settings row is read and nothing
 * is loaded when no move is owed. Never rejects: a failure is logged and the server starts.
 */
export const finishInterruptedDevFolderMove = async (
  extras: SettingsOpsServiceExtras = {},
  options: { readonly waitMs?: number } = {}
): Promise<void> => {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    if (!getDatabase().getSetting(DEV_FOLDER_PENDING_MOVE_KEY)) return
    const finished = runDevFolderExclusive(async () => {
      const [{ resumePendingDevFolderMove }, deps] = await Promise.all([
        loadDevFolderMoves(),
        loadLiveMoveDeps(extras)
      ])
      await resumePendingDevFolderMove(deps)
    }).then(
      () => true,
      (error: unknown) => {
        console.warn('[dev-folder] could not finish the move that a quit interrupted', error)
        return true
      }
    )
    const waitMs = options.waitMs ?? INTERRUPTED_MOVE_WAIT_MS
    // A wait that no timer can hold (longer than 24 days, or none at all) is no limit.
    const inTime =
      waitMs > MAX_TIMER_MS
        ? await finished
        : await Promise.race([
            finished,
            new Promise<boolean>((resolve) => {
              timer = setTimeout(() => resolve(false), waitMs)
            })
          ])
    if (!inTime) {
      console.warn(
        '[dev-folder] the move that a quit interrupted is still being finished; the server starts without waiting for it'
      )
    }
  } catch (error) {
    console.warn('[dev-folder] could not check for a move that a quit interrupted', error)
  } finally {
    clearTimeout(timer)
  }
}

export const makeLiveSettingsOpsRpcService = (
  extras: SettingsOpsServiceExtras = {}
): SettingsOpsRpcService => ({
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
    }),
  getDevFolder: () =>
    Effect.tryPromise({
      try: () => readDevFolder(getDatabase()),
      catch: (cause) => cause
    }),
  // Changing the folder and moving a project into it read and write the same folders and
  // rows: one at a time, in the order they were asked for.
  setDevFolder: ({ path }) =>
    Effect.tryPromise({
      try: () => runDevFolderExclusive(() => changeDevFolder(path)),
      catch: (cause) => cause
    }),
  planDevFolderMove: () =>
    Effect.tryPromise({
      try: async () => {
        const [{ planDevFolderMove, resumePendingDevFolderMove }, deps] = await Promise.all([
          loadDevFolderMoves(),
          loadLiveMoveDeps(extras)
        ])
        // A move that did not get to its end is finished before the plan is made, in its turn
        // among the changes of the dev folder: by the time that turn comes, a note that is
        // still there was not left by a move that is running. The plan itself only reads and
        // waits for nothing.
        if (moveIsOwed()) await runDevFolderExclusive(() => resumePendingDevFolderMove(deps))
        return planDevFolderMove(deps)
      },
      catch: (cause) => cause
    }),
  moveProjectToDevFolder: (params) =>
    Effect.tryPromise({
      try: () => runDevFolderExclusive(() => moveProject(params, extras)),
      catch: (cause) => cause
    }),
  reportRunningSessions: ({ sessionIds }, socketId) =>
    Effect.sync(() => {
      extras.activity?.report?.(socketId, sessionIds)
      return { ok: true as const }
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
    ],
    [
      DEV_FOLDER_RPC.get,
      (params) =>
        Effect.gen(function* () {
          yield* requireDesktopPrincipal()
          yield* Effect.try({
            try: () => emptyParamsSchema.parse(params),
            catch: (cause) => cause
          })
          return yield* service.getDevFolder()
        })
    ],
    [
      DEV_FOLDER_RPC.set,
      (params) =>
        Effect.gen(function* () {
          yield* requireDesktopPrincipal()
          const { path } = yield* Effect.try({
            try: () => setDevFolderParamsSchema.parse(params),
            catch: (cause) => cause
          })
          return yield* service.setDevFolder({ path })
        })
    ],
    [
      DEV_FOLDER_RPC.planMove,
      (params) =>
        Effect.gen(function* () {
          yield* requireDesktopPrincipal()
          yield* Effect.try({
            try: () => emptyParamsSchema.parse(params),
            catch: (cause) => cause
          })
          return yield* service.planDevFolderMove()
        })
    ],
    [
      DEV_FOLDER_RPC.moveProject,
      (params) =>
        Effect.gen(function* () {
          yield* requireDesktopPrincipal()
          const { projectId, expectedToPath } = yield* Effect.try({
            try: () => moveProjectToDevFolderParamsSchema.parse(params),
            catch: (cause) => cause
          })
          return yield* service.moveProjectToDevFolder({ projectId, expectedToPath })
        })
    ],
    [
      RUNNING_SESSIONS_REPORT_RPC,
      (params, _context, call) =>
        Effect.gen(function* () {
          const { sessionIds } = yield* Effect.try({
            try: () => reportRunningSessionsParamsSchema.parse(params),
            catch: (cause) => cause
          })
          // Keyed by the socket that reports, so its sessions go when the socket does.
          return yield* service.reportRunningSessions({ sessionIds }, call?.socketId ?? null)
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
