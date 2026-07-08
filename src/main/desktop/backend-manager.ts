import type { ChildProcess } from 'node:child_process'
import { spawn } from 'node:child_process'
import { app, BrowserWindow, clipboard, dialog, shell } from 'electron'
import { join } from 'node:path'
import {
  isDesktopCommandRequest,
  makeDesktopCommandResult,
  type OpenCodeAbortResult,
  type OpenCodeCapabilitiesResult,
  type OpenCodeCommandResult,
  type OpenCodeCommandsResult,
  type OpenCodeCommandApprovalReplyResult,
  type OpenCodeConnectResult,
  type OpenCodeDisconnectResult,
  type OpenCodeForkResult,
  type OpenCodeGetMessagesResult,
  type OpenCodeListModelsPayload,
  type OpenCodeListModelsResult,
  type OpenCodeModelInfoResult,
  type OpenCodePermissionListResult,
  type OpenCodePermissionReplyResult,
  type OpenCodePlanApproveResult,
  type OpenCodePlanRejectResult,
  type OpenCodePromptMessage,
  type OpenCodePromptModel,
  type OpenCodePromptOptions,
  type OpenCodePromptResult,
  type OpenCodeQuestionReplyResult,
  type OpenCodeQuestionRejectResult,
  type OpenCodeRefreshFromThreadResult,
  type OpenCodeRedoResult,
  type OpenCodeReconnectResult,
  type OpenCodeRenameSessionResult,
  type OpenCodeSetModelInput,
  type OpenCodeSetModelResult,
  type OpenCodeSessionInfoResult,
  type OpenCodeSteerResult,
  type OpenCodeUndoResult
} from '../../shared/desktop-command'
import { openInApp } from '../services/open-in-app'
import { openInChrome } from '../services/open-in-chrome'
import { createLogger } from '../services/logger'
import { updateMenuState } from '../menu'
import { setKeepAwake } from '../services/power-save-blocker'
import { sleepNow } from '../services/sleep-now'
import { notificationService } from '../services/notification-service'
import { updaterService } from '../services/updater'
import { appendResponseLog, createResponseLog } from '../services/response-logger'
import { deleteAttachment, saveAttachment } from '../services/attachment-storage'
import {
  getProjectIconDataUrl,
  removeProjectIcon,
  saveProjectIcon
} from '../services/project-icons'
import { scriptRunner } from '../services/script-runner'
import { ptyService } from '../services/pty-service'
import { ghosttyService } from '../services/ghostty-service'
import { getGhosttyConfigPathOnce } from '../services/ghostty-config-store'
import { startFileTreeWatcher, stopFileTreeWatcher } from '../services/file-tree-watcher'
import {
  createClaudeCliTerminal,
  destroyNodePtyTerminal,
  handleClaudeCliTerminalInput
} from '../services/terminal-pty-bridge'
import { claudeCliTelegramBridge } from '../services/claude-cli-telegram-bridge'
import { setClaudeCliPlanAutoApprove } from '../services/claude-cli-plan-auto-approve'
import { openPathWithEditor, openPathWithTerminal } from '../services/settings-openers'
import {
  beginPetPointerInteraction,
  createPetWindow,
  destroyPetWindow,
  endPetPointerInteraction,
  focusMainWindowFromPet,
  forwardStatusToPet,
  getCurrentPetStatus,
  getPetConfig,
  movePetWindow,
  persistPetSettings,
  setPetIgnoreMouseEvents,
  updatePetSettings
} from '../services/pet-window'
import {
  DEFAULT_DESKTOP_BACKEND_MAX_PORT,
  DEFAULT_DESKTOP_BACKEND_PORT,
  makeDesktopBackendSpawnConfig,
  parseDesktopBackendPortEnv,
  type DesktopBackendSpawnConfig
} from './backend-config'
import { getCurrentBackend, setCurrentBackend } from './backend-event-publisher'

export interface DesktopBackendBootstrap {
  readonly httpBaseUrl: string
  readonly wsBaseUrl: string
  readonly bootstrapToken: string
}

export interface StartedDesktopBackend {
  readonly config: DesktopBackendSpawnConfig
  readonly bootstrap: DesktopBackendBootstrap
  readonly stop: () => Promise<void>
  /** Current server child process, or null if not connected (restart-aware). */
  readonly getChild: () => ChildProcess | null
}

export interface StartDesktopBackendInput {
  readonly baseDir?: string
  readonly host?: string
  readonly port?: number
  readonly maxPort?: number
  readonly entryPath?: string
  readonly cwd?: string
  readonly executablePath?: string
  readonly readinessTimeoutMs?: number
  readonly readinessIntervalMs?: number
  readonly restartLimit?: number
  readonly headless?: boolean
}

interface BackendManagerDeps {
  readonly spawnProcess?: typeof spawn
  readonly fetch?: typeof fetch
  readonly setTimeout?: typeof setTimeout
  readonly clearTimeout?: typeof clearTimeout
  readonly logger?: {
    readonly info: (message: string, data?: Record<string, unknown>) => void
    readonly warn: (message: string, data?: Record<string, unknown>) => void
    readonly error: (message: string, error?: Error, data?: Record<string, unknown>) => void
  }
}

const DEFAULT_READINESS_TIMEOUT_MS = 30_000
const DEFAULT_READINESS_INTERVAL_MS = 100
const DEFAULT_RESTART_LIMIT = 2
const READINESS_PATH = '/.well-known/hive/environment'

let openCodeConnectHandler:
  | ((worktreePath: string, hiveSessionId: string) => Promise<OpenCodeConnectResult>)
  | null = null
let openCodeReconnectHandler:
  | ((
      worktreePath: string,
      opencodeSessionId: string,
      hiveSessionId: string
    ) => Promise<OpenCodeReconnectResult>)
  | null = null
let openCodePromptHandler:
  | ((
      worktreePath: string,
      opencodeSessionId: string,
      messageOrParts: OpenCodePromptMessage,
      model?: OpenCodePromptModel,
      options?: OpenCodePromptOptions
    ) => Promise<OpenCodePromptResult>)
  | null = null
let openCodeAbortHandler:
  | ((worktreePath: string, opencodeSessionId: string) => Promise<OpenCodeAbortResult>)
  | null = null
let openCodeSteerHandler:
  | ((
      worktreePath: string,
      opencodeSessionId: string,
      message: string
    ) => Promise<OpenCodeSteerResult>)
  | null = null
let openCodeDisconnectHandler:
  | ((worktreePath: string, opencodeSessionId: string) => Promise<OpenCodeDisconnectResult>)
  | null = null
let openCodeGetMessagesHandler:
  | ((worktreePath: string, opencodeSessionId: string) => Promise<OpenCodeGetMessagesResult>)
  | null = null
let openCodeRefreshFromThreadHandler:
  | ((worktreePath: string, opencodeSessionId: string) => Promise<OpenCodeRefreshFromThreadResult>)
  | null = null
let openCodeListModelsHandler:
  | ((opts: OpenCodeListModelsPayload) => Promise<OpenCodeListModelsResult>)
  | null = null
let openCodeSetModelHandler:
  | ((model: OpenCodeSetModelInput | null) => Promise<OpenCodeSetModelResult>)
  | null = null
let openCodeModelInfoHandler:
  | ((
      worktreePath: string,
      modelId: string,
      agentSdk?: OpenCodeListModelsPayload['agentSdk']
    ) => Promise<OpenCodeModelInfoResult>)
  | null = null
let openCodeQuestionReplyHandler:
  | ((
      requestId: string,
      answers: string[][],
      worktreePath?: string
    ) => Promise<OpenCodeQuestionReplyResult>)
  | null = null
let openCodeQuestionRejectHandler:
  | ((requestId: string, worktreePath?: string) => Promise<OpenCodeQuestionRejectResult>)
  | null = null
let openCodePlanApproveHandler:
  | ((
      worktreePath: string,
      hiveSessionId: string,
      requestId?: string
    ) => Promise<OpenCodePlanApproveResult>)
  | null = null
let openCodePlanRejectHandler:
  | ((
      worktreePath: string,
      hiveSessionId: string,
      feedback: string,
      requestId?: string
    ) => Promise<OpenCodePlanRejectResult>)
  | null = null
let openCodePermissionReplyHandler:
  | ((
      requestId: string,
      reply: 'once' | 'always' | 'reject',
      worktreePath?: string,
      message?: string
    ) => Promise<OpenCodePermissionReplyResult>)
  | null = null
let openCodePermissionListHandler:
  | ((worktreePath?: string) => Promise<OpenCodePermissionListResult>)
  | null = null
let openCodeCommandApprovalReplyHandler:
  | ((
      requestId: string,
      approved: boolean,
      remember?: 'allow' | 'block',
      pattern?: string,
      worktreePath?: string,
      patterns?: string[]
    ) => Promise<OpenCodeCommandApprovalReplyResult>)
  | null = null
let openCodeSessionInfoHandler:
  | ((worktreePath: string, opencodeSessionId: string) => Promise<OpenCodeSessionInfoResult>)
  | null = null
let openCodeUndoHandler:
  | ((worktreePath: string, opencodeSessionId: string) => Promise<OpenCodeUndoResult>)
  | null = null
let openCodeRedoHandler:
  | ((worktreePath: string, opencodeSessionId: string) => Promise<OpenCodeRedoResult>)
  | null = null
let openCodeCommandHandler:
  | ((
      worktreePath: string,
      opencodeSessionId: string,
      command: string,
      args: string,
      model?: OpenCodePromptModel,
      options?: OpenCodePromptOptions
    ) => Promise<OpenCodeCommandResult>)
  | null = null
let openCodeCommandsHandler:
  | ((worktreePath: string, sessionId?: string) => Promise<OpenCodeCommandsResult>)
  | null = null
let openCodeRenameSessionHandler:
  | ((
      opencodeSessionId: string,
      title: string,
      worktreePath?: string
    ) => Promise<OpenCodeRenameSessionResult>)
  | null = null
let openCodeCapabilitiesHandler:
  | ((sessionId?: string) => Promise<OpenCodeCapabilitiesResult>)
  | null = null
let openCodeForkHandler:
  | ((
      worktreePath: string,
      opencodeSessionId: string,
      messageId?: string
    ) => Promise<OpenCodeForkResult>)
  | null = null

const defaultLog = createLogger({ component: 'DesktopBackendManager' })

export const getDesktopBackendBootstrap = (): DesktopBackendBootstrap | null =>
  getCurrentBackend()?.bootstrap ?? null

export const setDesktopBackendOpenCodeConnectHandler = (
  handler: ((worktreePath: string, hiveSessionId: string) => Promise<OpenCodeConnectResult>) | null
): void => {
  openCodeConnectHandler = handler
}

export const setDesktopBackendOpenCodeReconnectHandler = (
  handler:
    | ((
        worktreePath: string,
        opencodeSessionId: string,
        hiveSessionId: string
      ) => Promise<OpenCodeReconnectResult>)
    | null
): void => {
  openCodeReconnectHandler = handler
}

export const setDesktopBackendOpenCodePromptHandler = (
  handler:
    | ((
        worktreePath: string,
        opencodeSessionId: string,
        messageOrParts: OpenCodePromptMessage,
        model?: OpenCodePromptModel,
        options?: OpenCodePromptOptions
      ) => Promise<OpenCodePromptResult>)
    | null
): void => {
  openCodePromptHandler = handler
}

export const setDesktopBackendOpenCodeAbortHandler = (
  handler:
    | ((worktreePath: string, opencodeSessionId: string) => Promise<OpenCodeAbortResult>)
    | null
): void => {
  openCodeAbortHandler = handler
}

export const setDesktopBackendOpenCodeSteerHandler = (
  handler:
    | ((
        worktreePath: string,
        opencodeSessionId: string,
        message: string
      ) => Promise<OpenCodeSteerResult>)
    | null
): void => {
  openCodeSteerHandler = handler
}

export const setDesktopBackendOpenCodeDisconnectHandler = (
  handler:
    | ((worktreePath: string, opencodeSessionId: string) => Promise<OpenCodeDisconnectResult>)
    | null
): void => {
  openCodeDisconnectHandler = handler
}

export const setDesktopBackendOpenCodeGetMessagesHandler = (
  handler:
    | ((worktreePath: string, opencodeSessionId: string) => Promise<OpenCodeGetMessagesResult>)
    | null
): void => {
  openCodeGetMessagesHandler = handler
}

export const setDesktopBackendOpenCodeRefreshFromThreadHandler = (
  handler:
    | ((
        worktreePath: string,
        opencodeSessionId: string
      ) => Promise<OpenCodeRefreshFromThreadResult>)
    | null
): void => {
  openCodeRefreshFromThreadHandler = handler
}

export const setDesktopBackendOpenCodeListModelsHandler = (
  handler: ((opts: OpenCodeListModelsPayload) => Promise<OpenCodeListModelsResult>) | null
): void => {
  openCodeListModelsHandler = handler
}

export const setDesktopBackendOpenCodeSetModelHandler = (
  handler: ((model: OpenCodeSetModelInput | null) => Promise<OpenCodeSetModelResult>) | null
): void => {
  openCodeSetModelHandler = handler
}

export const setDesktopBackendOpenCodeModelInfoHandler = (
  handler:
    | ((
        worktreePath: string,
        modelId: string,
        agentSdk?: OpenCodeListModelsPayload['agentSdk']
      ) => Promise<OpenCodeModelInfoResult>)
    | null
): void => {
  openCodeModelInfoHandler = handler
}

export const setDesktopBackendOpenCodeQuestionReplyHandler = (
  handler:
    | ((
        requestId: string,
        answers: string[][],
        worktreePath?: string
      ) => Promise<OpenCodeQuestionReplyResult>)
    | null
): void => {
  openCodeQuestionReplyHandler = handler
}

export const setDesktopBackendOpenCodeQuestionRejectHandler = (
  handler:
    | ((requestId: string, worktreePath?: string) => Promise<OpenCodeQuestionRejectResult>)
    | null
): void => {
  openCodeQuestionRejectHandler = handler
}

export const setDesktopBackendOpenCodePlanApproveHandler = (
  handler:
    | ((
        worktreePath: string,
        hiveSessionId: string,
        requestId?: string
      ) => Promise<OpenCodePlanApproveResult>)
    | null
): void => {
  openCodePlanApproveHandler = handler
}

export const setDesktopBackendOpenCodePlanRejectHandler = (
  handler:
    | ((
        worktreePath: string,
        hiveSessionId: string,
        feedback: string,
        requestId?: string
      ) => Promise<OpenCodePlanRejectResult>)
    | null
): void => {
  openCodePlanRejectHandler = handler
}

export const setDesktopBackendOpenCodePermissionReplyHandler = (
  handler:
    | ((
        requestId: string,
        reply: 'once' | 'always' | 'reject',
        worktreePath?: string,
        message?: string
      ) => Promise<OpenCodePermissionReplyResult>)
    | null
): void => {
  openCodePermissionReplyHandler = handler
}

export const setDesktopBackendOpenCodePermissionListHandler = (
  handler: ((worktreePath?: string) => Promise<OpenCodePermissionListResult>) | null
): void => {
  openCodePermissionListHandler = handler
}

export const setDesktopBackendOpenCodeCommandApprovalReplyHandler = (
  handler:
    | ((
        requestId: string,
        approved: boolean,
        remember?: 'allow' | 'block',
        pattern?: string,
        worktreePath?: string,
        patterns?: string[]
      ) => Promise<OpenCodeCommandApprovalReplyResult>)
    | null
): void => {
  openCodeCommandApprovalReplyHandler = handler
}

export const setDesktopBackendOpenCodeSessionInfoHandler = (
  handler:
    | ((worktreePath: string, opencodeSessionId: string) => Promise<OpenCodeSessionInfoResult>)
    | null
): void => {
  openCodeSessionInfoHandler = handler
}

export const setDesktopBackendOpenCodeUndoHandler = (
  handler: ((worktreePath: string, opencodeSessionId: string) => Promise<OpenCodeUndoResult>) | null
): void => {
  openCodeUndoHandler = handler
}

export const setDesktopBackendOpenCodeRedoHandler = (
  handler: ((worktreePath: string, opencodeSessionId: string) => Promise<OpenCodeRedoResult>) | null
): void => {
  openCodeRedoHandler = handler
}

export const setDesktopBackendOpenCodeCommandHandler = (
  handler:
    | ((
        worktreePath: string,
        opencodeSessionId: string,
        command: string,
        args: string,
        model?: OpenCodePromptModel,
        options?: OpenCodePromptOptions
      ) => Promise<OpenCodeCommandResult>)
    | null
): void => {
  openCodeCommandHandler = handler
}

export const setDesktopBackendOpenCodeCommandsHandler = (
  handler: ((worktreePath: string, sessionId?: string) => Promise<OpenCodeCommandsResult>) | null
): void => {
  openCodeCommandsHandler = handler
}

export const setDesktopBackendOpenCodeRenameSessionHandler = (
  handler:
    | ((
        opencodeSessionId: string,
        title: string,
        worktreePath?: string
      ) => Promise<OpenCodeRenameSessionResult>)
    | null
): void => {
  openCodeRenameSessionHandler = handler
}

export const setDesktopBackendOpenCodeCapabilitiesHandler = (
  handler: ((sessionId?: string) => Promise<OpenCodeCapabilitiesResult>) | null
): void => {
  openCodeCapabilitiesHandler = handler
}

export const setDesktopBackendOpenCodeForkHandler = (
  handler:
    | ((
        worktreePath: string,
        opencodeSessionId: string,
        messageId?: string
      ) => Promise<OpenCodeForkResult>)
    | null
): void => {
  openCodeForkHandler = handler
}

export const startDesktopBackend = async (
  input: StartDesktopBackendInput = {},
  deps: BackendManagerDeps = {}
): Promise<StartedDesktopBackend> => {
  const existingBackend = getCurrentBackend()
  if (existingBackend) return existingBackend

  const log = deps.logger ?? defaultLog
  const headless = input.headless ?? false
  // HIVE_DESKTOP_BASE_DIR redirects the backend's data dir (and thus its
  // hive.db) for E2E/dev runs. `app.getPath('home')` ignores $HOME on macOS
  // (getpwuid), so without this a dev build always opens the real user DB.
  const baseDir =
    input.baseDir ?? process.env.HIVE_DESKTOP_BASE_DIR ?? join(app.getPath('home'), '.hive')
  // `dev:web` pins the backend to a known free port via HIVE_DESKTOP_BACKEND_PORT so
  // its Vite dev server can target it. When set, scan only that single port.
  const pinnedPort = parseDesktopBackendPortEnv(process.env.HIVE_DESKTOP_BACKEND_PORT)
  const envBootstrapToken = process.env.HIVE_DESKTOP_BOOTSTRAP_TOKEN?.trim() || undefined
  const config = await makeDesktopBackendSpawnConfig({
    executablePath: input.executablePath,
    entryPath: input.entryPath,
    cwd: input.cwd,
    baseDir,
    host: input.host,
    port: input.port ?? pinnedPort ?? DEFAULT_DESKTOP_BACKEND_PORT,
    maxPort: input.maxPort ?? pinnedPort ?? DEFAULT_DESKTOP_BACKEND_MAX_PORT,
    bootstrapToken: envBootstrapToken,
    // The desktop backend canonically reads the existing desktop database at
    // <baseDir>/hive.db (i.e. ~/.hive/hive.db). This is intentional and
    // permanent: updating users must keep seeing their existing
    // projects/worktrees/sessions. We deliberately do NOT use or create the
    // server-mode userdata/state.sqlite for desktop, and we do NOT copy/migrate
    // data between the two. Keep this override in place.
    env: { HIVE_SERVER_DB_PATH: join(baseDir, 'hive.db') }
  })

  let stopping = false
  let restartCount = 0
  let processRef: ChildProcess | null = null
  const spawnProcess = deps.spawnProcess ?? spawn

  const spawnBackend = (): ChildProcess => {
    log.info('Starting desktop backend', {
      entryPath: config.entryPath,
      port: config.port,
      host: config.host
    })

    const child = spawnProcess(config.executablePath, [config.entryPath], {
      cwd: config.cwd,
      env: config.env,
      stdio: ['ignore', 'pipe', 'pipe', 'ipc']
    })

    child.on('message', (message) => {
      void handleDesktopBackendCommand(child, message, log, { headless })
    })
    child.stdout?.on('data', (chunk) => {
      log.info('Backend stdout', { text: String(chunk) })
    })
    child.stderr?.on('data', (chunk) => {
      log.warn('Backend stderr', { text: String(chunk) })
    })
    child.once('exit', (code, signal) => {
      if (processRef === child) processRef = null
      if (stopping) return

      log.warn('Desktop backend exited unexpectedly', {
        code: code ?? null,
        signal: signal ?? null
      })
      if (restartCount >= (input.restartLimit ?? DEFAULT_RESTART_LIMIT)) {
        log.error('Desktop backend restart limit reached', undefined, { restartCount })
        return
      }

      restartCount += 1
      const delayMs = Math.min(500 * 2 ** (restartCount - 1), 5_000)
      ;(deps.setTimeout ?? setTimeout)(() => {
        if (!stopping && getCurrentBackend()) {
          processRef = spawnBackend()
        }
      }, delayMs)
    })

    return child
  }

  processRef = spawnBackend()
  try {
    await waitForBackendReady(config.httpBaseUrl, {
      fetchImpl: deps.fetch ?? fetch,
      timeoutMs: input.readinessTimeoutMs ?? DEFAULT_READINESS_TIMEOUT_MS,
      intervalMs: input.readinessIntervalMs ?? DEFAULT_READINESS_INTERVAL_MS
    })
  } catch (error) {
    stopping = true
    processRef.kill('SIGTERM')
    throw error
  }

  const started: StartedDesktopBackend = {
    config,
    bootstrap: {
      httpBaseUrl: config.httpBaseUrl,
      wsBaseUrl: config.wsBaseUrl,
      bootstrapToken: config.bootstrapToken
    },
    getChild: () => processRef,
    stop: async () => {
      stopping = true
      const child = processRef
      processRef = null
      if (!child || child.killed) return

      await new Promise<void>((resolveStop) => {
        child.once('exit', () => resolveStop())
        child.kill('SIGTERM')
        ;(deps.setTimeout ?? setTimeout)(() => {
          if (!child.killed) child.kill('SIGKILL')
          resolveStop()
        }, 2_000)
      })
    }
  }

  setCurrentBackend(started)
  log.info('Desktop backend ready', {
    httpBaseUrl: config.httpBaseUrl,
    wsBaseUrl: config.wsBaseUrl
  })
  return started
}

const handleDesktopBackendCommand = (
  child: ChildProcess,
  message: unknown,
  log: NonNullable<BackendManagerDeps['logger']>,
  options: { readonly headless?: boolean } = {}
): Promise<void> | void => {
  if (!isDesktopCommandRequest(message)) return

  if (message.command === 'quitApp') {
    sendDesktopBackendCommandResult(child, makeDesktopCommandResult(message.id, { ok: true }), log)
    setImmediate(() => {
      app.quit()
    })
    return
  }

  if (message.command === 'confirm') {
    const focusedWindow = BrowserWindow.getFocusedWindow()
    const options = {
      type: 'question' as const,
      buttons: ['Cancel', 'OK'],
      defaultId: 1,
      cancelId: 0,
      message: message.payload.message
    }
    return (
      focusedWindow ? dialog.showMessageBox(focusedWindow, options) : dialog.showMessageBox(options)
    )
      .then((result) => {
        sendDesktopBackendCommandResult(
          child,
          makeDesktopCommandResult(message.id, { ok: true, value: result.response === 1 }),
          log
        )
      })
      .catch((error) => {
        sendDesktopBackendCommandResult(
          child,
          makeDesktopCommandResult(message.id, {
            ok: false,
            error: error instanceof Error ? error.message : String(error)
          }),
          log
        )
      })
  }

  if (message.command === 'projectOpenDirectoryDialog') {
    const focusedWindow = BrowserWindow.getFocusedWindow()
    const options = {
      properties: ['openDirectory', 'createDirectory'] as const,
      title: 'Select Project Folder',
      buttonLabel: 'Add Project'
    }
    return (
      focusedWindow ? dialog.showOpenDialog(focusedWindow, options) : dialog.showOpenDialog(options)
    )
      .then((result) => {
        const selectedPath =
          result.canceled || result.filePaths.length === 0 ? null : result.filePaths[0]
        sendDesktopBackendCommandResult(
          child,
          makeDesktopCommandResult(message.id, { ok: true, value: selectedPath }),
          log
        )
      })
      .catch((error) => {
        sendDesktopBackendCommandResult(
          child,
          makeDesktopCommandResult(message.id, {
            ok: false,
            error: error instanceof Error ? error.message : String(error)
          }),
          log
        )
      })
  }

  if (message.command === 'telegramClaudeCliRegister') {
    claudeCliTelegramBridge.register(message.payload.sessionId)
    sendDesktopBackendCommandResult(
      child,
      makeDesktopCommandResult(message.id, { ok: true, value: { success: true } }),
      log
    )
    return
  }

  if (message.command === 'telegramClaudeCliCancel') {
    claudeCliTelegramBridge.cancelSession(message.payload.sessionId)
    sendDesktopBackendCommandResult(
      child,
      makeDesktopCommandResult(message.id, { ok: true, value: { success: true } }),
      log
    )
    return
  }

  if (message.command === 'terminalSetClaudeCliPlanAutoApprove') {
    setClaudeCliPlanAutoApprove(message.payload.sessionId, message.payload.enabled)
    sendDesktopBackendCommandResult(
      child,
      makeDesktopCommandResult(message.id, { ok: true, value: { success: true } }),
      log
    )
    return
  }

  if (message.command === 'telegramClaudeCliQuestionReply') {
    const success = claudeCliTelegramBridge.hasPendingQuestion(message.payload.requestId)
    if (success) {
      claudeCliTelegramBridge.resolveQuestion(message.payload.requestId, message.payload.answers)
    }
    sendDesktopBackendCommandResult(
      child,
      makeDesktopCommandResult(message.id, { ok: true, value: { success } }),
      log
    )
    return
  }

  if (message.command === 'telegramClaudeCliQuestionReject') {
    const success = claudeCliTelegramBridge.hasPendingQuestion(message.payload.requestId)
    if (success) {
      claudeCliTelegramBridge.rejectQuestion(message.payload.requestId)
    }
    sendDesktopBackendCommandResult(
      child,
      makeDesktopCommandResult(message.id, { ok: true, value: { success } }),
      log
    )
    return
  }

  if (message.command === 'telegramClaudeCliPlanReply') {
    const success = claudeCliTelegramBridge.hasPendingPlan(message.payload.requestId)
    if (success) {
      claudeCliTelegramBridge.resolvePlan(
        message.payload.requestId,
        message.payload.approve,
        message.payload.feedback
      )
    }
    sendDesktopBackendCommandResult(
      child,
      makeDesktopCommandResult(message.id, { ok: true, value: { success } }),
      log
    )
    return
  }

  if (message.command === 'projectShowInFolder') {
    try {
      shell.showItemInFolder(message.payload.path)
      sendDesktopBackendCommandResult(
        child,
        makeDesktopCommandResult(message.id, { ok: true, value: undefined }),
        log
      )
    } catch (error) {
      sendDesktopBackendCommandResult(
        child,
        makeDesktopCommandResult(message.id, {
          ok: false,
          error: error instanceof Error ? error.message : String(error)
        }),
        log
      )
    }
    return undefined
  }

  if (message.command === 'projectOpenPath') {
    return shell
      .openPath(message.payload.path)
      .then((value) => {
        sendDesktopBackendCommandResult(
          child,
          makeDesktopCommandResult(message.id, { ok: true, value }),
          log
        )
      })
      .catch((error) => {
        sendDesktopBackendCommandResult(
          child,
          makeDesktopCommandResult(message.id, {
            ok: false,
            error: error instanceof Error ? error.message : String(error)
          }),
          log
        )
      })
  }

  if (message.command === 'projectWriteClipboardText') {
    try {
      clipboard.writeText(message.payload.text)
      sendDesktopBackendCommandResult(
        child,
        makeDesktopCommandResult(message.id, { ok: true, value: undefined }),
        log
      )
    } catch (error) {
      sendDesktopBackendCommandResult(
        child,
        makeDesktopCommandResult(message.id, {
          ok: false,
          error: error instanceof Error ? error.message : String(error)
        }),
        log
      )
    }
    return undefined
  }

  if (message.command === 'projectReadClipboardText') {
    try {
      const text = clipboard.readText()
      sendDesktopBackendCommandResult(
        child,
        makeDesktopCommandResult(message.id, { ok: true, value: text }),
        log
      )
    } catch (error) {
      sendDesktopBackendCommandResult(
        child,
        makeDesktopCommandResult(message.id, {
          ok: false,
          error: error instanceof Error ? error.message : String(error)
        }),
        log
      )
    }
    return undefined
  }

  if (message.command === 'projectPickProjectIcon') {
    return dialog
      .showOpenDialog(BrowserWindow.getFocusedWindow()!, {
        properties: ['openFile'],
        title: 'Select Project Icon',
        buttonLabel: 'Select Icon',
        filters: [{ name: 'Images', extensions: ['svg', 'png', 'jpg', 'jpeg', 'webp'] }]
      })
      .then((result) => {
        if (result.canceled || result.filePaths.length === 0) {
          sendDesktopBackendCommandResult(
            child,
            makeDesktopCommandResult(message.id, {
              ok: true,
              value: { success: false, error: 'cancelled' }
            }),
            log
          )
          return
        }

        const iconDir = join(app.getPath('home'), '.hive', 'project-icons')
        const value = saveProjectIcon(message.payload.projectId, result.filePaths[0], iconDir)
        sendDesktopBackendCommandResult(
          child,
          makeDesktopCommandResult(message.id, { ok: true, value }),
          log
        )
      })
      .catch((error) => {
        sendDesktopBackendCommandResult(
          child,
          makeDesktopCommandResult(message.id, {
            ok: false,
            error: error instanceof Error ? error.message : String(error)
          }),
          log
        )
      })
  }

  if (message.command === 'projectRemoveProjectIcon') {
    try {
      const iconDir = join(app.getPath('home'), '.hive', 'project-icons')
      const value = removeProjectIcon(message.payload.projectId, iconDir)
      sendDesktopBackendCommandResult(
        child,
        makeDesktopCommandResult(message.id, { ok: true, value }),
        log
      )
    } catch (error) {
      sendDesktopBackendCommandResult(
        child,
        makeDesktopCommandResult(message.id, {
          ok: false,
          error: error instanceof Error ? error.message : String(error)
        }),
        log
      )
    }
    return undefined
  }

  if (message.command === 'projectGetProjectIconPath') {
    try {
      const iconDir = join(app.getPath('home'), '.hive', 'project-icons')
      const value = getProjectIconDataUrl(message.payload.filename, iconDir)
      sendDesktopBackendCommandResult(
        child,
        makeDesktopCommandResult(message.id, { ok: true, value }),
        log
      )
    } catch (error) {
      sendDesktopBackendCommandResult(
        child,
        makeDesktopCommandResult(message.id, {
          ok: false,
          error: error instanceof Error ? error.message : String(error)
        }),
        log
      )
    }
    return undefined
  }

  if (message.command === 'gitShowInFinder') {
    try {
      shell.showItemInFolder(message.payload.filePath)
      sendDesktopBackendCommandResult(
        child,
        makeDesktopCommandResult(message.id, { ok: true, value: { success: true } }),
        log
      )
    } catch (error) {
      sendDesktopBackendCommandResult(
        child,
        makeDesktopCommandResult(message.id, {
          ok: true,
          value: {
            success: false,
            error: error instanceof Error ? error.message : String(error)
          }
        }),
        log
      )
    }
    return undefined
  }

  if (message.command === 'kanbanOpenBoardImportFileDialog') {
    return dialog
      .showOpenDialog({
        filters: [{ name: 'Hive Board', extensions: ['json'] }],
        properties: ['openFile']
      })
      .then((result) => {
        sendDesktopBackendCommandResult(
          child,
          makeDesktopCommandResult(message.id, {
            ok: true,
            value: {
              filePath:
                result.canceled || result.filePaths.length === 0 ? null : result.filePaths[0]
            }
          }),
          log
        )
      })
      .catch((error) => {
        sendDesktopBackendCommandResult(
          child,
          makeDesktopCommandResult(message.id, {
            ok: false,
            error: error instanceof Error ? error.message : String(error)
          }),
          log
        )
      })
  }

  if (message.command === 'kanbanSaveBoardExportDialog') {
    return dialog
      .showSaveDialog({
        defaultPath: `board-${message.payload.projectName}.hive.json`,
        filters: [{ name: 'Hive Board', extensions: ['hive.json'] }]
      })
      .then((result) => {
        sendDesktopBackendCommandResult(
          child,
          makeDesktopCommandResult(message.id, {
            ok: true,
            value: { filePath: result.canceled || !result.filePath ? null : result.filePath }
          }),
          log
        )
      })
      .catch((error) => {
        sendDesktopBackendCommandResult(
          child,
          makeDesktopCommandResult(message.id, {
            ok: false,
            error: error instanceof Error ? error.message : String(error)
          }),
          log
        )
      })
  }

  if (message.command === 'systemGetAppVersion') {
    try {
      const version = app.getVersion()
      sendDesktopBackendCommandResult(
        child,
        makeDesktopCommandResult(message.id, { ok: true, value: version }),
        log
      )
    } catch (error) {
      sendDesktopBackendCommandResult(
        child,
        makeDesktopCommandResult(message.id, {
          ok: false,
          error: error instanceof Error ? error.message : String(error)
        }),
        log
      )
    }
    return undefined
  }

  if (message.command === 'systemGetAppPaths') {
    try {
      const value = {
        userData: app.getPath('userData'),
        home: app.getPath('home')
      }
      sendDesktopBackendCommandResult(
        child,
        makeDesktopCommandResult(message.id, { ok: true, value }),
        log
      )
    } catch (error) {
      sendDesktopBackendCommandResult(
        child,
        makeDesktopCommandResult(message.id, {
          ok: false,
          error: error instanceof Error ? error.message : String(error)
        }),
        log
      )
    }
    return undefined
  }

  if (message.command === 'systemIsPackaged') {
    try {
      sendDesktopBackendCommandResult(
        child,
        makeDesktopCommandResult(message.id, { ok: true, value: app.isPackaged }),
        log
      )
    } catch (error) {
      sendDesktopBackendCommandResult(
        child,
        makeDesktopCommandResult(message.id, {
          ok: false,
          error: error instanceof Error ? error.message : String(error)
        }),
        log
      )
    }
    return undefined
  }

  if (message.command === 'openInApp') {
    return openInApp(message.payload.appName, message.payload.path, { clipboard })
      .then((value) => {
        sendDesktopBackendCommandResult(
          child,
          makeDesktopCommandResult(message.id, { ok: true, value }),
          log
        )
      })
      .catch((error) => {
        sendDesktopBackendCommandResult(
          child,
          makeDesktopCommandResult(message.id, {
            ok: false,
            error: error instanceof Error ? error.message : String(error)
          }),
          log
        )
      })
  }

  if (message.command === 'openInChrome') {
    return openInChrome(message.payload.url, message.payload.customCommand, {
      openExternal: shell.openExternal
    })
      .then((value) => {
        sendDesktopBackendCommandResult(
          child,
          makeDesktopCommandResult(message.id, { ok: true, value }),
          log
        )
      })
      .catch((error) => {
        sendDesktopBackendCommandResult(
          child,
          makeDesktopCommandResult(message.id, {
            ok: false,
            error: error instanceof Error ? error.message : String(error)
          }),
          log
        )
      })
  }

  if (message.command === 'opencodeConnect') {
    if (!openCodeConnectHandler) {
      sendDesktopBackendCommandResult(
        child,
        makeDesktopCommandResult(message.id, {
          ok: true,
          value: { success: false, error: 'OpenCode connect handler is not registered' }
        }),
        log
      )
      return
    }

    return openCodeConnectHandler(message.payload.worktreePath, message.payload.hiveSessionId)
      .then((value) => {
        sendDesktopBackendCommandResult(
          child,
          makeDesktopCommandResult(message.id, { ok: true, value }),
          log
        )
      })
      .catch((error) => {
        sendDesktopBackendCommandResult(
          child,
          makeDesktopCommandResult(message.id, {
            ok: true,
            value: { success: false, error: error instanceof Error ? error.message : String(error) }
          }),
          log
        )
      })
  }

  if (message.command === 'opencodeReconnect') {
    if (!openCodeReconnectHandler) {
      sendDesktopBackendCommandResult(
        child,
        makeDesktopCommandResult(message.id, { ok: true, value: { success: false } }),
        log
      )
      return
    }

    return openCodeReconnectHandler(
      message.payload.worktreePath,
      message.payload.opencodeSessionId,
      message.payload.hiveSessionId
    )
      .then((value) => {
        sendDesktopBackendCommandResult(
          child,
          makeDesktopCommandResult(message.id, { ok: true, value }),
          log
        )
      })
      .catch(() => {
        sendDesktopBackendCommandResult(
          child,
          makeDesktopCommandResult(message.id, { ok: true, value: { success: false } }),
          log
        )
      })
  }

  if (message.command === 'opencodePrompt') {
    if (!openCodePromptHandler) {
      sendDesktopBackendCommandResult(
        child,
        makeDesktopCommandResult(message.id, {
          ok: true,
          value: { success: false, error: 'OpenCode prompt handler is not registered' }
        }),
        log
      )
      return
    }

    return openCodePromptHandler(
      message.payload.worktreePath,
      message.payload.opencodeSessionId,
      message.payload.messageOrParts,
      message.payload.model,
      message.payload.options
    )
      .then((value) => {
        sendDesktopBackendCommandResult(
          child,
          makeDesktopCommandResult(message.id, { ok: true, value }),
          log
        )
      })
      .catch((error) => {
        sendDesktopBackendCommandResult(
          child,
          makeDesktopCommandResult(message.id, {
            ok: true,
            value: { success: false, error: error instanceof Error ? error.message : String(error) }
          }),
          log
        )
      })
  }

  if (message.command === 'opencodeAbort') {
    if (!openCodeAbortHandler) {
      sendDesktopBackendCommandResult(
        child,
        makeDesktopCommandResult(message.id, {
          ok: true,
          value: { success: false, error: 'OpenCode abort handler is not registered' }
        }),
        log
      )
      return
    }

    return openCodeAbortHandler(message.payload.worktreePath, message.payload.opencodeSessionId)
      .then((value) => {
        sendDesktopBackendCommandResult(
          child,
          makeDesktopCommandResult(message.id, { ok: true, value }),
          log
        )
      })
      .catch((error) => {
        sendDesktopBackendCommandResult(
          child,
          makeDesktopCommandResult(message.id, {
            ok: true,
            value: { success: false, error: error instanceof Error ? error.message : String(error) }
          }),
          log
        )
      })
  }

  if (message.command === 'opencodeSteer') {
    if (!openCodeSteerHandler) {
      sendDesktopBackendCommandResult(
        child,
        makeDesktopCommandResult(message.id, {
          ok: true,
          value: { success: false, error: 'OpenCode steer handler is not registered' }
        }),
        log
      )
      return
    }

    return openCodeSteerHandler(
      message.payload.worktreePath,
      message.payload.opencodeSessionId,
      message.payload.message
    )
      .then((value) => {
        sendDesktopBackendCommandResult(
          child,
          makeDesktopCommandResult(message.id, { ok: true, value }),
          log
        )
      })
      .catch((error) => {
        sendDesktopBackendCommandResult(
          child,
          makeDesktopCommandResult(message.id, {
            ok: true,
            value: { success: false, error: error instanceof Error ? error.message : String(error) }
          }),
          log
        )
      })
  }

  if (message.command === 'opencodeDisconnect') {
    if (!openCodeDisconnectHandler) {
      sendDesktopBackendCommandResult(
        child,
        makeDesktopCommandResult(message.id, {
          ok: true,
          value: { success: false, error: 'OpenCode disconnect handler is not registered' }
        }),
        log
      )
      return
    }

    return openCodeDisconnectHandler(
      message.payload.worktreePath,
      message.payload.opencodeSessionId
    )
      .then((value) => {
        sendDesktopBackendCommandResult(
          child,
          makeDesktopCommandResult(message.id, { ok: true, value }),
          log
        )
      })
      .catch((error) => {
        sendDesktopBackendCommandResult(
          child,
          makeDesktopCommandResult(message.id, {
            ok: true,
            value: { success: false, error: error instanceof Error ? error.message : String(error) }
          }),
          log
        )
      })
  }

  if (message.command === 'opencodeGetMessages') {
    if (!openCodeGetMessagesHandler) {
      sendDesktopBackendCommandResult(
        child,
        makeDesktopCommandResult(message.id, {
          ok: true,
          value: {
            success: false,
            error: 'OpenCode get messages handler is not registered',
            messages: []
          }
        }),
        log
      )
      return
    }

    return openCodeGetMessagesHandler(
      message.payload.worktreePath,
      message.payload.opencodeSessionId
    )
      .then((value) => {
        sendDesktopBackendCommandResult(
          child,
          makeDesktopCommandResult(message.id, { ok: true, value }),
          log
        )
      })
      .catch((error) => {
        sendDesktopBackendCommandResult(
          child,
          makeDesktopCommandResult(message.id, {
            ok: true,
            value: {
              success: false,
              error: error instanceof Error ? error.message : String(error),
              messages: []
            }
          }),
          log
        )
      })
  }

  if (message.command === 'opencodeRefreshFromThread') {
    if (!openCodeRefreshFromThreadHandler) {
      sendDesktopBackendCommandResult(
        child,
        makeDesktopCommandResult(message.id, {
          ok: true,
          value: {
            success: false,
            error: 'OpenCode refresh from thread handler is not registered'
          }
        }),
        log
      )
      return
    }

    return openCodeRefreshFromThreadHandler(
      message.payload.worktreePath,
      message.payload.opencodeSessionId
    )
      .then((value) => {
        sendDesktopBackendCommandResult(
          child,
          makeDesktopCommandResult(message.id, { ok: true, value }),
          log
        )
      })
      .catch((error) => {
        sendDesktopBackendCommandResult(
          child,
          makeDesktopCommandResult(message.id, {
            ok: true,
            value: { success: false, error: error instanceof Error ? error.message : String(error) }
          }),
          log
        )
      })
  }

  if (message.command === 'opencodeListModels') {
    if (!openCodeListModelsHandler) {
      sendDesktopBackendCommandResult(
        child,
        makeDesktopCommandResult(message.id, {
          ok: true,
          value: {
            success: false,
            error: 'OpenCode list models handler is not registered',
            providers: {}
          }
        }),
        log
      )
      return
    }

    return openCodeListModelsHandler(message.payload)
      .then((value) => {
        sendDesktopBackendCommandResult(
          child,
          makeDesktopCommandResult(message.id, { ok: true, value }),
          log
        )
      })
      .catch((error) => {
        sendDesktopBackendCommandResult(
          child,
          makeDesktopCommandResult(message.id, {
            ok: true,
            value: {
              success: false,
              error: error instanceof Error ? error.message : String(error),
              providers: {}
            }
          }),
          log
        )
      })
  }

  if (message.command === 'opencodeSetModel') {
    if (!openCodeSetModelHandler) {
      sendDesktopBackendCommandResult(
        child,
        makeDesktopCommandResult(message.id, {
          ok: true,
          value: {
            success: false,
            error: 'OpenCode set model handler is not registered'
          }
        }),
        log
      )
      return
    }

    return openCodeSetModelHandler(message.payload.model)
      .then((value) => {
        sendDesktopBackendCommandResult(
          child,
          makeDesktopCommandResult(message.id, { ok: true, value }),
          log
        )
      })
      .catch((error) => {
        sendDesktopBackendCommandResult(
          child,
          makeDesktopCommandResult(message.id, {
            ok: true,
            value: { success: false, error: error instanceof Error ? error.message : String(error) }
          }),
          log
        )
      })
  }

  if (message.command === 'opencodeModelInfo') {
    if (!openCodeModelInfoHandler) {
      sendDesktopBackendCommandResult(
        child,
        makeDesktopCommandResult(message.id, {
          ok: true,
          value: {
            success: false,
            error: 'OpenCode model info handler is not registered'
          }
        }),
        log
      )
      return
    }

    return openCodeModelInfoHandler(
      message.payload.worktreePath,
      message.payload.modelId,
      message.payload.agentSdk
    )
      .then((value) => {
        sendDesktopBackendCommandResult(
          child,
          makeDesktopCommandResult(message.id, { ok: true, value }),
          log
        )
      })
      .catch((error) => {
        sendDesktopBackendCommandResult(
          child,
          makeDesktopCommandResult(message.id, {
            ok: true,
            value: { success: false, error: error instanceof Error ? error.message : String(error) }
          }),
          log
        )
      })
  }

  if (message.command === 'opencodeQuestionReply') {
    if (!openCodeQuestionReplyHandler) {
      sendDesktopBackendCommandResult(
        child,
        makeDesktopCommandResult(message.id, {
          ok: true,
          value: {
            success: false,
            error: 'OpenCode question reply handler is not registered'
          }
        }),
        log
      )
      return
    }

    return openCodeQuestionReplyHandler(
      message.payload.requestId,
      message.payload.answers,
      message.payload.worktreePath
    )
      .then((value) => {
        sendDesktopBackendCommandResult(
          child,
          makeDesktopCommandResult(message.id, { ok: true, value }),
          log
        )
      })
      .catch((error) => {
        sendDesktopBackendCommandResult(
          child,
          makeDesktopCommandResult(message.id, {
            ok: true,
            value: { success: false, error: error instanceof Error ? error.message : String(error) }
          }),
          log
        )
      })
  }

  if (message.command === 'opencodeQuestionReject') {
    if (!openCodeQuestionRejectHandler) {
      sendDesktopBackendCommandResult(
        child,
        makeDesktopCommandResult(message.id, {
          ok: true,
          value: {
            success: false,
            error: 'OpenCode question reject handler is not registered'
          }
        }),
        log
      )
      return
    }

    return openCodeQuestionRejectHandler(message.payload.requestId, message.payload.worktreePath)
      .then((value) => {
        sendDesktopBackendCommandResult(
          child,
          makeDesktopCommandResult(message.id, { ok: true, value }),
          log
        )
      })
      .catch((error) => {
        sendDesktopBackendCommandResult(
          child,
          makeDesktopCommandResult(message.id, {
            ok: true,
            value: { success: false, error: error instanceof Error ? error.message : String(error) }
          }),
          log
        )
      })
  }

  if (message.command === 'opencodePlanApprove') {
    if (!openCodePlanApproveHandler) {
      sendDesktopBackendCommandResult(
        child,
        makeDesktopCommandResult(message.id, {
          ok: true,
          value: {
            success: false,
            error: 'OpenCode plan approve handler is not registered'
          }
        }),
        log
      )
      return
    }

    return openCodePlanApproveHandler(
      message.payload.worktreePath,
      message.payload.hiveSessionId,
      message.payload.requestId
    )
      .then((value) => {
        sendDesktopBackendCommandResult(
          child,
          makeDesktopCommandResult(message.id, { ok: true, value }),
          log
        )
      })
      .catch((error) => {
        sendDesktopBackendCommandResult(
          child,
          makeDesktopCommandResult(message.id, {
            ok: true,
            value: { success: false, error: error instanceof Error ? error.message : String(error) }
          }),
          log
        )
      })
  }

  if (message.command === 'opencodePlanReject') {
    if (!openCodePlanRejectHandler) {
      sendDesktopBackendCommandResult(
        child,
        makeDesktopCommandResult(message.id, {
          ok: true,
          value: {
            success: false,
            error: 'OpenCode plan reject handler is not registered'
          }
        }),
        log
      )
      return
    }

    return openCodePlanRejectHandler(
      message.payload.worktreePath,
      message.payload.hiveSessionId,
      message.payload.feedback,
      message.payload.requestId
    )
      .then((value) => {
        sendDesktopBackendCommandResult(
          child,
          makeDesktopCommandResult(message.id, { ok: true, value }),
          log
        )
      })
      .catch((error) => {
        sendDesktopBackendCommandResult(
          child,
          makeDesktopCommandResult(message.id, {
            ok: true,
            value: { success: false, error: error instanceof Error ? error.message : String(error) }
          }),
          log
        )
      })
  }

  if (message.command === 'opencodePermissionReply') {
    if (!openCodePermissionReplyHandler) {
      sendDesktopBackendCommandResult(
        child,
        makeDesktopCommandResult(message.id, {
          ok: true,
          value: {
            success: false,
            error: 'OpenCode permission reply handler is not registered'
          }
        }),
        log
      )
      return
    }

    return openCodePermissionReplyHandler(
      message.payload.requestId,
      message.payload.reply,
      message.payload.worktreePath,
      message.payload.message
    )
      .then((value) => {
        sendDesktopBackendCommandResult(
          child,
          makeDesktopCommandResult(message.id, { ok: true, value }),
          log
        )
      })
      .catch((error) => {
        sendDesktopBackendCommandResult(
          child,
          makeDesktopCommandResult(message.id, {
            ok: true,
            value: { success: false, error: error instanceof Error ? error.message : String(error) }
          }),
          log
        )
      })
  }

  if (message.command === 'opencodePermissionList') {
    if (!openCodePermissionListHandler) {
      sendDesktopBackendCommandResult(
        child,
        makeDesktopCommandResult(message.id, {
          ok: true,
          value: {
            success: false,
            permissions: [],
            error: 'OpenCode permission list handler is not registered'
          }
        }),
        log
      )
      return
    }

    return openCodePermissionListHandler(message.payload.worktreePath)
      .then((value) => {
        sendDesktopBackendCommandResult(
          child,
          makeDesktopCommandResult(message.id, { ok: true, value }),
          log
        )
      })
      .catch((error) => {
        sendDesktopBackendCommandResult(
          child,
          makeDesktopCommandResult(message.id, {
            ok: true,
            value: {
              success: false,
              permissions: [],
              error: error instanceof Error ? error.message : String(error)
            }
          }),
          log
        )
      })
  }

  if (message.command === 'opencodeCommandApprovalReply') {
    if (!openCodeCommandApprovalReplyHandler) {
      sendDesktopBackendCommandResult(
        child,
        makeDesktopCommandResult(message.id, {
          ok: true,
          value: {
            success: false,
            error: 'OpenCode command approval reply handler is not registered'
          }
        }),
        log
      )
      return
    }

    return openCodeCommandApprovalReplyHandler(
      message.payload.requestId,
      message.payload.approved,
      message.payload.remember,
      message.payload.pattern,
      message.payload.worktreePath,
      message.payload.patterns
    )
      .then((value) => {
        sendDesktopBackendCommandResult(
          child,
          makeDesktopCommandResult(message.id, { ok: true, value }),
          log
        )
      })
      .catch((error) => {
        sendDesktopBackendCommandResult(
          child,
          makeDesktopCommandResult(message.id, {
            ok: true,
            value: { success: false, error: error instanceof Error ? error.message : String(error) }
          }),
          log
        )
      })
  }

  if (message.command === 'opencodeSessionInfo') {
    if (!openCodeSessionInfoHandler) {
      sendDesktopBackendCommandResult(
        child,
        makeDesktopCommandResult(message.id, {
          ok: true,
          value: {
            success: false,
            error: 'OpenCode session info handler is not registered'
          }
        }),
        log
      )
      return
    }

    return openCodeSessionInfoHandler(
      message.payload.worktreePath,
      message.payload.opencodeSessionId
    )
      .then((value) => {
        sendDesktopBackendCommandResult(
          child,
          makeDesktopCommandResult(message.id, { ok: true, value }),
          log
        )
      })
      .catch((error) => {
        sendDesktopBackendCommandResult(
          child,
          makeDesktopCommandResult(message.id, {
            ok: true,
            value: { success: false, error: error instanceof Error ? error.message : String(error) }
          }),
          log
        )
      })
  }

  if (message.command === 'opencodeUndo') {
    if (!openCodeUndoHandler) {
      sendDesktopBackendCommandResult(
        child,
        makeDesktopCommandResult(message.id, {
          ok: true,
          value: {
            success: false,
            error: 'OpenCode undo handler is not registered'
          }
        }),
        log
      )
      return
    }

    return openCodeUndoHandler(message.payload.worktreePath, message.payload.opencodeSessionId)
      .then((value) => {
        sendDesktopBackendCommandResult(
          child,
          makeDesktopCommandResult(message.id, { ok: true, value }),
          log
        )
      })
      .catch((error) => {
        sendDesktopBackendCommandResult(
          child,
          makeDesktopCommandResult(message.id, {
            ok: true,
            value: { success: false, error: error instanceof Error ? error.message : String(error) }
          }),
          log
        )
      })
  }

  if (message.command === 'opencodeRedo') {
    if (!openCodeRedoHandler) {
      sendDesktopBackendCommandResult(
        child,
        makeDesktopCommandResult(message.id, {
          ok: true,
          value: {
            success: false,
            error: 'OpenCode redo handler is not registered'
          }
        }),
        log
      )
      return
    }

    return openCodeRedoHandler(message.payload.worktreePath, message.payload.opencodeSessionId)
      .then((value) => {
        sendDesktopBackendCommandResult(
          child,
          makeDesktopCommandResult(message.id, { ok: true, value }),
          log
        )
      })
      .catch((error) => {
        sendDesktopBackendCommandResult(
          child,
          makeDesktopCommandResult(message.id, {
            ok: true,
            value: { success: false, error: error instanceof Error ? error.message : String(error) }
          }),
          log
        )
      })
  }

  if (message.command === 'opencodeCommand') {
    if (!openCodeCommandHandler) {
      sendDesktopBackendCommandResult(
        child,
        makeDesktopCommandResult(message.id, {
          ok: true,
          value: {
            success: false,
            error: 'OpenCode command handler is not registered'
          }
        }),
        log
      )
      return
    }

    return openCodeCommandHandler(
      message.payload.worktreePath,
      message.payload.opencodeSessionId,
      message.payload.command,
      message.payload.args,
      message.payload.model,
      message.payload.options
    )
      .then((value) => {
        sendDesktopBackendCommandResult(
          child,
          makeDesktopCommandResult(message.id, { ok: true, value }),
          log
        )
      })
      .catch((error) => {
        sendDesktopBackendCommandResult(
          child,
          makeDesktopCommandResult(message.id, {
            ok: true,
            value: { success: false, error: error instanceof Error ? error.message : String(error) }
          }),
          log
        )
      })
  }

  if (message.command === 'opencodeCommands') {
    if (!openCodeCommandsHandler) {
      sendDesktopBackendCommandResult(
        child,
        makeDesktopCommandResult(message.id, {
          ok: true,
          value: {
            success: false,
            commands: [],
            error: 'OpenCode commands handler is not registered'
          }
        }),
        log
      )
      return
    }

    return openCodeCommandsHandler(message.payload.worktreePath, message.payload.sessionId)
      .then((value) => {
        sendDesktopBackendCommandResult(
          child,
          makeDesktopCommandResult(message.id, { ok: true, value }),
          log
        )
      })
      .catch((error) => {
        sendDesktopBackendCommandResult(
          child,
          makeDesktopCommandResult(message.id, {
            ok: true,
            value: {
              success: false,
              commands: [],
              error: error instanceof Error ? error.message : String(error)
            }
          }),
          log
        )
      })
  }

  if (message.command === 'opencodeRenameSession') {
    if (!openCodeRenameSessionHandler) {
      sendDesktopBackendCommandResult(
        child,
        makeDesktopCommandResult(message.id, {
          ok: true,
          value: {
            success: false,
            error: 'OpenCode rename session handler is not registered'
          }
        }),
        log
      )
      return
    }

    return openCodeRenameSessionHandler(
      message.payload.opencodeSessionId,
      message.payload.title,
      message.payload.worktreePath
    )
      .then((value) => {
        sendDesktopBackendCommandResult(
          child,
          makeDesktopCommandResult(message.id, { ok: true, value }),
          log
        )
      })
      .catch((error) => {
        sendDesktopBackendCommandResult(
          child,
          makeDesktopCommandResult(message.id, {
            ok: true,
            value: { success: false, error: error instanceof Error ? error.message : String(error) }
          }),
          log
        )
      })
  }

  if (message.command === 'opencodeCapabilities') {
    if (!openCodeCapabilitiesHandler) {
      sendDesktopBackendCommandResult(
        child,
        makeDesktopCommandResult(message.id, {
          ok: true,
          value: {
            success: false,
            error: 'OpenCode capabilities handler is not registered'
          }
        }),
        log
      )
      return
    }

    return openCodeCapabilitiesHandler(message.payload.sessionId)
      .then((value) => {
        sendDesktopBackendCommandResult(
          child,
          makeDesktopCommandResult(message.id, { ok: true, value }),
          log
        )
      })
      .catch((error) => {
        sendDesktopBackendCommandResult(
          child,
          makeDesktopCommandResult(message.id, {
            ok: true,
            value: { success: false, error: error instanceof Error ? error.message : String(error) }
          }),
          log
        )
      })
  }

  if (message.command === 'opencodeFork') {
    if (!openCodeForkHandler) {
      sendDesktopBackendCommandResult(
        child,
        makeDesktopCommandResult(message.id, {
          ok: true,
          value: {
            success: false,
            error: 'OpenCode fork handler is not registered'
          }
        }),
        log
      )
      return
    }

    return openCodeForkHandler(
      message.payload.worktreePath,
      message.payload.opencodeSessionId,
      message.payload.messageId
    )
      .then((value) => {
        sendDesktopBackendCommandResult(
          child,
          makeDesktopCommandResult(message.id, { ok: true, value }),
          log
        )
      })
      .catch((error) => {
        sendDesktopBackendCommandResult(
          child,
          makeDesktopCommandResult(message.id, {
            ok: true,
            value: { success: false, error: error instanceof Error ? error.message : String(error) }
          }),
          log
        )
      })
  }

  if (message.command === 'updateMenuState') {
    try {
      updateMenuState(message.payload)
      sendDesktopBackendCommandResult(
        child,
        makeDesktopCommandResult(message.id, { ok: true }),
        log
      )
    } catch (error) {
      sendDesktopBackendCommandResult(
        child,
        makeDesktopCommandResult(message.id, {
          ok: false,
          error: error instanceof Error ? error.message : String(error)
        }),
        log
      )
    }
  }

  if (message.command === 'setKeepAwake') {
    try {
      setKeepAwake(message.payload.active)
      sendDesktopBackendCommandResult(
        child,
        makeDesktopCommandResult(message.id, { ok: true }),
        log
      )
    } catch (error) {
      sendDesktopBackendCommandResult(
        child,
        makeDesktopCommandResult(message.id, {
          ok: false,
          error: error instanceof Error ? error.message : String(error)
        }),
        log
      )
    }
  }

  if (message.command === 'sleepNow') {
    try {
      const issued = sleepNow()
      sendDesktopBackendCommandResult(
        child,
        makeDesktopCommandResult(message.id, { ok: true, value: issued }),
        log
      )
    } catch (error) {
      sendDesktopBackendCommandResult(
        child,
        makeDesktopCommandResult(message.id, {
          ok: false,
          error: error instanceof Error ? error.message : String(error)
        }),
        log
      )
    }
  }

  if (message.command === 'setSessionQueuedState') {
    try {
      notificationService.setSessionQueuedState(
        message.payload.sessionId,
        message.payload.hasQueued
      )
      sendDesktopBackendCommandResult(
        child,
        makeDesktopCommandResult(message.id, { ok: true }),
        log
      )
    } catch (error) {
      sendDesktopBackendCommandResult(
        child,
        makeDesktopCommandResult(message.id, {
          ok: false,
          error: error instanceof Error ? error.message : String(error)
        }),
        log
      )
    }
  }

  if (message.command === 'updaterCheckForUpdate') {
    updaterService
      .checkForUpdates(message.payload)
      .then(() => {
        sendDesktopBackendCommandResult(
          child,
          makeDesktopCommandResult(message.id, { ok: true, value: undefined }),
          log
        )
      })
      .catch((error) => {
        sendDesktopBackendCommandResult(
          child,
          makeDesktopCommandResult(message.id, {
            ok: false,
            error: error instanceof Error ? error.message : String(error)
          }),
          log
        )
      })
    return undefined
  }

  if (message.command === 'updaterDownloadUpdate') {
    updaterService
      .downloadUpdate()
      .then(() => {
        sendDesktopBackendCommandResult(
          child,
          makeDesktopCommandResult(message.id, { ok: true, value: undefined }),
          log
        )
      })
      .catch((error) => {
        sendDesktopBackendCommandResult(
          child,
          makeDesktopCommandResult(message.id, {
            ok: false,
            error: error instanceof Error ? error.message : String(error)
          }),
          log
        )
      })
    return undefined
  }

  if (message.command === 'updaterInstallUpdate') {
    try {
      updaterService.quitAndInstall()
      sendDesktopBackendCommandResult(
        child,
        makeDesktopCommandResult(message.id, { ok: true, value: undefined }),
        log
      )
    } catch (error) {
      sendDesktopBackendCommandResult(
        child,
        makeDesktopCommandResult(message.id, {
          ok: false,
          error: error instanceof Error ? error.message : String(error)
        }),
        log
      )
    }
    return undefined
  }

  if (message.command === 'updaterSetChannel') {
    try {
      updaterService.setChannel(message.payload.channel)
      sendDesktopBackendCommandResult(
        child,
        makeDesktopCommandResult(message.id, { ok: true, value: undefined }),
        log
      )
    } catch (error) {
      sendDesktopBackendCommandResult(
        child,
        makeDesktopCommandResult(message.id, {
          ok: false,
          error: error instanceof Error ? error.message : String(error)
        }),
        log
      )
    }
    return undefined
  }

  if (message.command === 'updaterGetVersion') {
    try {
      const version = updaterService.getVersion()
      sendDesktopBackendCommandResult(
        child,
        makeDesktopCommandResult(message.id, { ok: true, value: version }),
        log
      )
    } catch (error) {
      sendDesktopBackendCommandResult(
        child,
        makeDesktopCommandResult(message.id, {
          ok: false,
          error: error instanceof Error ? error.message : String(error)
        }),
        log
      )
    }
    return undefined
  }

  if (message.command === 'showPet') {
    try {
      if (options.headless) {
        log.info('Ignoring showPet command in headless mode')
      } else {
        createPetWindow(getDesktopBackendBootstrap())
      }
      sendDesktopBackendCommandResult(
        child,
        makeDesktopCommandResult(message.id, { ok: true }),
        log
      )
    } catch (error) {
      sendDesktopBackendCommandResult(
        child,
        makeDesktopCommandResult(message.id, {
          ok: false,
          error: error instanceof Error ? error.message : String(error)
        }),
        log
      )
    }
  }

  if (message.command === 'hidePet') {
    try {
      destroyPetWindow()
      sendDesktopBackendCommandResult(
        child,
        makeDesktopCommandResult(message.id, { ok: true }),
        log
      )
    } catch (error) {
      sendDesktopBackendCommandResult(
        child,
        makeDesktopCommandResult(message.id, {
          ok: false,
          error: error instanceof Error ? error.message : String(error)
        }),
        log
      )
    }
  }

  if (message.command === 'publishPetStatus') {
    try {
      forwardStatusToPet(message.payload)
      sendDesktopBackendCommandResult(
        child,
        makeDesktopCommandResult(message.id, { ok: true }),
        log
      )
    } catch (error) {
      sendDesktopBackendCommandResult(
        child,
        makeDesktopCommandResult(message.id, {
          ok: false,
          error: error instanceof Error ? error.message : String(error)
        }),
        log
      )
    }
  }

  if (message.command === 'setPetIgnoreMouse') {
    try {
      setPetIgnoreMouseEvents(message.payload.ignore)
      sendDesktopBackendCommandResult(
        child,
        makeDesktopCommandResult(message.id, { ok: true }),
        log
      )
    } catch (error) {
      sendDesktopBackendCommandResult(
        child,
        makeDesktopCommandResult(message.id, {
          ok: false,
          error: error instanceof Error ? error.message : String(error)
        }),
        log
      )
    }
  }

  if (message.command === 'beginPetPointerInteraction') {
    try {
      beginPetPointerInteraction()
      sendDesktopBackendCommandResult(
        child,
        makeDesktopCommandResult(message.id, { ok: true }),
        log
      )
    } catch (error) {
      sendDesktopBackendCommandResult(
        child,
        makeDesktopCommandResult(message.id, {
          ok: false,
          error: error instanceof Error ? error.message : String(error)
        }),
        log
      )
    }
  }

  if (message.command === 'endPetPointerInteraction') {
    try {
      endPetPointerInteraction()
      sendDesktopBackendCommandResult(
        child,
        makeDesktopCommandResult(message.id, { ok: true }),
        log
      )
    } catch (error) {
      sendDesktopBackendCommandResult(
        child,
        makeDesktopCommandResult(message.id, {
          ok: false,
          error: error instanceof Error ? error.message : String(error)
        }),
        log
      )
    }
  }

  if (message.command === 'movePet') {
    try {
      movePetWindow(message.payload)
      sendDesktopBackendCommandResult(
        child,
        makeDesktopCommandResult(message.id, { ok: true }),
        log
      )
    } catch (error) {
      sendDesktopBackendCommandResult(
        child,
        makeDesktopCommandResult(message.id, {
          ok: false,
          error: error instanceof Error ? error.message : String(error)
        }),
        log
      )
    }
  }

  if (message.command === 'focusMainFromPet') {
    try {
      focusMainWindowFromPet(message.payload.worktreeId)
      sendDesktopBackendCommandResult(
        child,
        makeDesktopCommandResult(message.id, { ok: true }),
        log
      )
    } catch (error) {
      sendDesktopBackendCommandResult(
        child,
        makeDesktopCommandResult(message.id, {
          ok: false,
          error: error instanceof Error ? error.message : String(error)
        }),
        log
      )
    }
  }

  if (message.command === 'getPetConfig') {
    try {
      const value = getPetConfig()
      sendDesktopBackendCommandResult(
        child,
        makeDesktopCommandResult(message.id, { ok: true, value }),
        log
      )
    } catch (error) {
      sendDesktopBackendCommandResult(
        child,
        makeDesktopCommandResult(message.id, {
          ok: false,
          error: error instanceof Error ? error.message : String(error)
        }),
        log
      )
    }
  }

  if (message.command === 'getCurrentPetStatus') {
    try {
      const value = getCurrentPetStatus()
      sendDesktopBackendCommandResult(
        child,
        makeDesktopCommandResult(message.id, { ok: true, value }),
        log
      )
    } catch (error) {
      sendDesktopBackendCommandResult(
        child,
        makeDesktopCommandResult(message.id, {
          ok: false,
          error: error instanceof Error ? error.message : String(error)
        }),
        log
      )
    }
  }

  if (message.command === 'updatePetSettings') {
    try {
      updatePetSettings(message.payload)
      if (message.payload.enabled === true) {
        if (options.headless) {
          log.info('Skipping pet window creation in headless mode')
        } else {
          createPetWindow(getDesktopBackendBootstrap())
        }
      } else if (message.payload.enabled === false) {
        destroyPetWindow()
      }
      sendDesktopBackendCommandResult(
        child,
        makeDesktopCommandResult(message.id, { ok: true }),
        log
      )
    } catch (error) {
      sendDesktopBackendCommandResult(
        child,
        makeDesktopCommandResult(message.id, {
          ok: false,
          error: error instanceof Error ? error.message : String(error)
        }),
        log
      )
    }
  }

  if (message.command === 'markPetHatched') {
    try {
      persistPetSettings({ hasHatched: true })
      sendDesktopBackendCommandResult(
        child,
        makeDesktopCommandResult(message.id, { ok: true }),
        log
      )
    } catch (error) {
      sendDesktopBackendCommandResult(
        child,
        makeDesktopCommandResult(message.id, {
          ok: false,
          error: error instanceof Error ? error.message : String(error)
        }),
        log
      )
    }
  }

  if (message.command === 'createResponseLog') {
    try {
      const value = createResponseLog(message.payload.sessionId)
      sendDesktopBackendCommandResult(
        child,
        makeDesktopCommandResult(message.id, { ok: true, value }),
        log
      )
    } catch (error) {
      sendDesktopBackendCommandResult(
        child,
        makeDesktopCommandResult(message.id, {
          ok: false,
          error: error instanceof Error ? error.message : String(error)
        }),
        log
      )
    }
  }

  if (message.command === 'appendResponseLog') {
    try {
      appendResponseLog(message.payload.filePath, message.payload.data)
      sendDesktopBackendCommandResult(
        child,
        makeDesktopCommandResult(message.id, { ok: true }),
        log
      )
    } catch (error) {
      sendDesktopBackendCommandResult(
        child,
        makeDesktopCommandResult(message.id, {
          ok: false,
          error: error instanceof Error ? error.message : String(error)
        }),
        log
      )
    }
  }

  if (message.command === 'saveAttachment') {
    return saveAttachment(
      Buffer.from(message.payload.dataBase64, 'base64'),
      message.payload.originalName
    )
      .then((value) => {
        sendDesktopBackendCommandResult(
          child,
          makeDesktopCommandResult(message.id, { ok: true, value }),
          log
        )
      })
      .catch((error) => {
        sendDesktopBackendCommandResult(
          child,
          makeDesktopCommandResult(message.id, {
            ok: false,
            error: error instanceof Error ? error.message : String(error)
          }),
          log
        )
      })
  }

  if (message.command === 'deleteAttachment') {
    return deleteAttachment(message.payload.filePath)
      .then((value) => {
        sendDesktopBackendCommandResult(
          child,
          makeDesktopCommandResult(message.id, { ok: true, value }),
          log
        )
      })
      .catch((error) => {
        sendDesktopBackendCommandResult(
          child,
          makeDesktopCommandResult(message.id, {
            ok: false,
            error: error instanceof Error ? error.message : String(error)
          }),
          log
        )
      })
  }

  if (message.command === 'settingsOpenWithEditor') {
    try {
      const value = openPathWithEditor(
        message.payload.worktreePath,
        message.payload.editorId,
        message.payload.customCommand
      )
      sendDesktopBackendCommandResult(
        child,
        makeDesktopCommandResult(message.id, { ok: true, value }),
        log
      )
    } catch (error) {
      sendDesktopBackendCommandResult(
        child,
        makeDesktopCommandResult(message.id, {
          ok: false,
          error: error instanceof Error ? error.message : String(error)
        }),
        log
      )
    }
  }

  if (message.command === 'settingsOpenWithTerminal') {
    try {
      const value = openPathWithTerminal(
        message.payload.worktreePath,
        message.payload.terminalId,
        message.payload.customCommand
      )
      sendDesktopBackendCommandResult(
        child,
        makeDesktopCommandResult(message.id, { ok: true, value }),
        log
      )
    } catch (error) {
      sendDesktopBackendCommandResult(
        child,
        makeDesktopCommandResult(message.id, {
          ok: false,
          error: error instanceof Error ? error.message : String(error)
        }),
        log
      )
    }
  }

  if (message.command === 'watchFileTree') {
    try {
      const value = startFileTreeWatcher(message.payload.worktreePath)
      sendDesktopBackendCommandResult(
        child,
        makeDesktopCommandResult(message.id, { ok: true, value }),
        log
      )
    } catch (error) {
      sendDesktopBackendCommandResult(
        child,
        makeDesktopCommandResult(message.id, {
          ok: false,
          error: error instanceof Error ? error.message : String(error)
        }),
        log
      )
    }
  }

  if (message.command === 'unwatchFileTree') {
    return stopFileTreeWatcher(message.payload.worktreePath)
      .then((value) => {
        sendDesktopBackendCommandResult(
          child,
          makeDesktopCommandResult(message.id, { ok: true, value }),
          log
        )
      })
      .catch((error) => {
        sendDesktopBackendCommandResult(
          child,
          makeDesktopCommandResult(message.id, {
            ok: false,
            error: error instanceof Error ? error.message : String(error)
          }),
          log
        )
      })
  }

  if (message.command === 'killScript') {
    return scriptRunner
      .killProcess(`script:run:${message.payload.worktreeId}`)
      .then(() => {
        sendDesktopBackendCommandResult(
          child,
          makeDesktopCommandResult(message.id, { ok: true, value: { success: true } }),
          log
        )
      })
      .catch((error) => {
        sendDesktopBackendCommandResult(
          child,
          makeDesktopCommandResult(message.id, {
            ok: true,
            value: { success: false, error: error instanceof Error ? error.message : String(error) }
          }),
          log
        )
      })
  }

  if (message.command === 'terminalResize') {
    try {
      ptyService.resize(message.payload.terminalId, message.payload.cols, message.payload.rows)
      sendDesktopBackendCommandResult(
        child,
        makeDesktopCommandResult(message.id, { ok: true, value: { success: true } }),
        log
      )
    } catch (error) {
      sendDesktopBackendCommandResult(
        child,
        makeDesktopCommandResult(message.id, {
          ok: true,
          value: { success: false, error: error instanceof Error ? error.message : String(error) }
        }),
        log
      )
    }
    return undefined
  }

  if (message.command === 'terminalDestroy') {
    try {
      destroyNodePtyTerminal(message.payload.terminalId)
      sendDesktopBackendCommandResult(
        child,
        makeDesktopCommandResult(message.id, { ok: true, value: { success: true } }),
        log
      )
    } catch (error) {
      sendDesktopBackendCommandResult(
        child,
        makeDesktopCommandResult(message.id, {
          ok: true,
          value: { success: false, error: error instanceof Error ? error.message : String(error) }
        }),
        log
      )
    }
    return undefined
  }

  if (message.command === 'terminalWrite') {
    try {
      if (!ptyService.has(message.payload.terminalId)) {
        throw new Error('Terminal not found')
      }
      handleClaudeCliTerminalInput(message.payload.terminalId, message.payload.data)
      ptyService.write(message.payload.terminalId, message.payload.data)
      sendDesktopBackendCommandResult(
        child,
        makeDesktopCommandResult(message.id, { ok: true, value: { success: true } }),
        log
      )
    } catch (error) {
      sendDesktopBackendCommandResult(
        child,
        makeDesktopCommandResult(message.id, {
          ok: true,
          value: { success: false, error: error instanceof Error ? error.message : String(error) }
        }),
        log
      )
    }
    return undefined
  }

  if (message.command === 'terminalCreateClaudeCli') {
    return createClaudeCliTerminal(message.payload.sessionId, message.payload.opts)
      .then((value) => {
        sendDesktopBackendCommandResult(
          child,
          makeDesktopCommandResult(message.id, { ok: true, value }),
          log
        )
      })
      .catch((error) => {
        sendDesktopBackendCommandResult(
          child,
          makeDesktopCommandResult(message.id, {
            ok: true,
            value: { success: false, error: error instanceof Error ? error.message : String(error) }
          }),
          log
        )
      })
  }

  if (message.command === 'terminalGhosttyInit') {
    try {
      // Path was resolved once at app launch; re-using the memo avoids
      // touching Ghostty's TCC-protected dir mid-flow.
      const value = ghosttyService.init(getGhosttyConfigPathOnce())
      sendDesktopBackendCommandResult(
        child,
        makeDesktopCommandResult(message.id, { ok: true, value }),
        log
      )
    } catch (error) {
      sendDesktopBackendCommandResult(
        child,
        makeDesktopCommandResult(message.id, {
          ok: false,
          error: error instanceof Error ? error.message : String(error)
        }),
        log
      )
    }
    return undefined
  }

  if (message.command === 'terminalGhosttyIsAvailable') {
    try {
      ghosttyService.loadAddon()
      sendDesktopBackendCommandResult(
        child,
        makeDesktopCommandResult(message.id, {
          ok: true,
          value: {
            available: ghosttyService.isAvailable(),
            initialized: ghosttyService.isInitialized(),
            platform: process.platform
          }
        }),
        log
      )
    } catch (error) {
      sendDesktopBackendCommandResult(
        child,
        makeDesktopCommandResult(message.id, {
          ok: false,
          error: error instanceof Error ? error.message : String(error)
        }),
        log
      )
    }
    return undefined
  }

  if (message.command === 'terminalGhosttyCreateSurface') {
    try {
      const value = ghosttyService.createSurface(
        message.payload.terminalId,
        message.payload.rect,
        message.payload.opts ?? {}
      )
      sendDesktopBackendCommandResult(
        child,
        makeDesktopCommandResult(message.id, { ok: true, value }),
        log
      )
    } catch (error) {
      sendDesktopBackendCommandResult(
        child,
        makeDesktopCommandResult(message.id, {
          ok: false,
          error: error instanceof Error ? error.message : String(error)
        }),
        log
      )
    }
    return undefined
  }

  if (message.command === 'terminalGhosttySetFrame') {
    try {
      ghosttyService.setFrame(message.payload.terminalId, message.payload.rect)
      sendDesktopBackendCommandResult(
        child,
        makeDesktopCommandResult(message.id, { ok: true, value: undefined }),
        log
      )
    } catch (error) {
      sendDesktopBackendCommandResult(
        child,
        makeDesktopCommandResult(message.id, {
          ok: false,
          error: error instanceof Error ? error.message : String(error)
        }),
        log
      )
    }
    return undefined
  }

  if (message.command === 'terminalGhosttySetSize') {
    try {
      ghosttyService.setSize(
        message.payload.terminalId,
        message.payload.width,
        message.payload.height
      )
      sendDesktopBackendCommandResult(
        child,
        makeDesktopCommandResult(message.id, { ok: true, value: undefined }),
        log
      )
    } catch (error) {
      sendDesktopBackendCommandResult(
        child,
        makeDesktopCommandResult(message.id, {
          ok: false,
          error: error instanceof Error ? error.message : String(error)
        }),
        log
      )
    }
    return undefined
  }

  if (message.command === 'terminalGhosttyKeyEvent') {
    try {
      const value = ghosttyService.keyEvent(message.payload.terminalId, message.payload.event)
      sendDesktopBackendCommandResult(
        child,
        makeDesktopCommandResult(message.id, { ok: true, value }),
        log
      )
    } catch (error) {
      sendDesktopBackendCommandResult(
        child,
        makeDesktopCommandResult(message.id, {
          ok: false,
          error: error instanceof Error ? error.message : String(error)
        }),
        log
      )
    }
    return undefined
  }

  if (message.command === 'terminalGhosttyMouseButton') {
    try {
      ghosttyService.mouseButton(
        message.payload.terminalId,
        message.payload.state,
        message.payload.button,
        message.payload.mods
      )
      sendDesktopBackendCommandResult(
        child,
        makeDesktopCommandResult(message.id, { ok: true, value: undefined }),
        log
      )
    } catch (error) {
      sendDesktopBackendCommandResult(
        child,
        makeDesktopCommandResult(message.id, {
          ok: false,
          error: error instanceof Error ? error.message : String(error)
        }),
        log
      )
    }
    return undefined
  }

  if (message.command === 'terminalGhosttyMousePos') {
    try {
      ghosttyService.mousePos(
        message.payload.terminalId,
        message.payload.x,
        message.payload.y,
        message.payload.mods
      )
      sendDesktopBackendCommandResult(
        child,
        makeDesktopCommandResult(message.id, { ok: true, value: undefined }),
        log
      )
    } catch (error) {
      sendDesktopBackendCommandResult(
        child,
        makeDesktopCommandResult(message.id, {
          ok: false,
          error: error instanceof Error ? error.message : String(error)
        }),
        log
      )
    }
    return undefined
  }

  if (message.command === 'terminalGhosttyMouseScroll') {
    try {
      ghosttyService.mouseScroll(
        message.payload.terminalId,
        message.payload.dx,
        message.payload.dy,
        message.payload.mods
      )
      sendDesktopBackendCommandResult(
        child,
        makeDesktopCommandResult(message.id, { ok: true, value: undefined }),
        log
      )
    } catch (error) {
      sendDesktopBackendCommandResult(
        child,
        makeDesktopCommandResult(message.id, {
          ok: false,
          error: error instanceof Error ? error.message : String(error)
        }),
        log
      )
    }
    return undefined
  }

  if (message.command === 'terminalGhosttySetFocus') {
    try {
      ghosttyService.setFocus(message.payload.terminalId, message.payload.focused)
      sendDesktopBackendCommandResult(
        child,
        makeDesktopCommandResult(message.id, { ok: true, value: undefined }),
        log
      )
    } catch (error) {
      sendDesktopBackendCommandResult(
        child,
        makeDesktopCommandResult(message.id, {
          ok: false,
          error: error instanceof Error ? error.message : String(error)
        }),
        log
      )
    }
    return undefined
  }

  if (message.command === 'terminalGhosttyPasteText') {
    try {
      ghosttyService.pasteText(message.payload.terminalId, message.payload.text)
      sendDesktopBackendCommandResult(
        child,
        makeDesktopCommandResult(message.id, { ok: true, value: undefined }),
        log
      )
    } catch (error) {
      sendDesktopBackendCommandResult(
        child,
        makeDesktopCommandResult(message.id, {
          ok: false,
          error: error instanceof Error ? error.message : String(error)
        }),
        log
      )
    }
    return undefined
  }

  if (message.command === 'terminalGhosttyFocusDiagnostics') {
    try {
      const value = ghosttyService.focusDiagnostics()
      sendDesktopBackendCommandResult(
        child,
        makeDesktopCommandResult(message.id, { ok: true, value }),
        log
      )
    } catch (error) {
      sendDesktopBackendCommandResult(
        child,
        makeDesktopCommandResult(message.id, {
          ok: false,
          error: error instanceof Error ? error.message : String(error)
        }),
        log
      )
    }
    return undefined
  }

  if (message.command === 'terminalGhosttyDestroySurface') {
    try {
      ghosttyService.destroySurface(message.payload.terminalId)
      sendDesktopBackendCommandResult(
        child,
        makeDesktopCommandResult(message.id, { ok: true, value: undefined }),
        log
      )
    } catch (error) {
      sendDesktopBackendCommandResult(
        child,
        makeDesktopCommandResult(message.id, {
          ok: false,
          error: error instanceof Error ? error.message : String(error)
        }),
        log
      )
    }
    return undefined
  }

  if (message.command === 'terminalGhosttyShutdown') {
    try {
      ghosttyService.shutdown()
      sendDesktopBackendCommandResult(
        child,
        makeDesktopCommandResult(message.id, { ok: true, value: undefined }),
        log
      )
    } catch (error) {
      sendDesktopBackendCommandResult(
        child,
        makeDesktopCommandResult(message.id, {
          ok: false,
          error: error instanceof Error ? error.message : String(error)
        }),
        log
      )
    }
    return undefined
  }
}

const sendDesktopBackendCommandResult = (
  child: ChildProcess,
  result: ReturnType<typeof makeDesktopCommandResult>,
  log: NonNullable<BackendManagerDeps['logger']>
): void => {
  if (typeof child.send !== 'function') return

  child.send(result, (error) => {
    if (error) {
      log.warn('Failed to send desktop backend command result', { error })
    }
  })
}

export const stopDesktopBackend = async (): Promise<void> => {
  const backend = getCurrentBackend()
  setCurrentBackend(null)
  await backend?.stop()
}

export const __resetDesktopBackendForTests = async (): Promise<void> => {
  await stopDesktopBackend()
  openCodeConnectHandler = null
  openCodeReconnectHandler = null
  openCodePromptHandler = null
  openCodeAbortHandler = null
  openCodeSteerHandler = null
  openCodeDisconnectHandler = null
  openCodeGetMessagesHandler = null
  openCodeRefreshFromThreadHandler = null
  openCodeListModelsHandler = null
  openCodeSetModelHandler = null
  openCodeModelInfoHandler = null
  openCodeQuestionReplyHandler = null
  openCodeQuestionRejectHandler = null
  openCodePlanApproveHandler = null
  openCodePlanRejectHandler = null
  openCodePermissionReplyHandler = null
  openCodePermissionListHandler = null
  openCodeCommandApprovalReplyHandler = null
  openCodeSessionInfoHandler = null
  openCodeUndoHandler = null
  openCodeRedoHandler = null
  openCodeCommandHandler = null
  openCodeCommandsHandler = null
  openCodeRenameSessionHandler = null
  openCodeCapabilitiesHandler = null
  openCodeForkHandler = null
}

export const waitForBackendReady = async (
  httpBaseUrl: string,
  options: {
    readonly fetchImpl?: typeof fetch
    readonly timeoutMs?: number
    readonly intervalMs?: number
  } = {}
): Promise<void> => {
  const fetchImpl = options.fetchImpl ?? fetch
  const timeoutMs = options.timeoutMs ?? DEFAULT_READINESS_TIMEOUT_MS
  const intervalMs = options.intervalMs ?? DEFAULT_READINESS_INTERVAL_MS
  const deadline = Date.now() + timeoutMs
  const url = `${httpBaseUrl}${READINESS_PATH}`
  let lastError: unknown

  while (Date.now() <= deadline) {
    try {
      const response = await fetchImpl(url)
      if (response.ok) return
      lastError = new Error(`Backend readiness returned HTTP ${response.status}`)
    } catch (error) {
      lastError = error
    }

    await new Promise((resolveDelay) => setTimeout(resolveDelay, intervalMs))
  }

  throw new Error(
    `Timed out waiting for desktop backend readiness at ${url}${
      lastError instanceof Error ? `: ${lastError.message}` : ''
    }`
  )
}
