import { loadShellEnv } from './services/shell-env'
import { app, shell, BrowserWindow, screen, webContents } from 'electron'
import { join } from 'path'
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs'
import { electronApp, is } from '@electron-toolkit/utils'
import { getDatabase, closeDatabase } from './db'
import {
  connectOpenCodeSession,
  reconnectOpenCodeSession,
  promptOpenCodeSession,
  abortOpenCodeSession,
  steerOpenCodeSession,
  disconnectOpenCodeSession,
  getOpenCodeSessionMessages,
  refreshOpenCodeSessionFromThread,
  listOpenCodeModels,
  setOpenCodeSelectedModel,
  getOpenCodeModelInfo,
  replyOpenCodeQuestion,
  rejectOpenCodeQuestion,
  approveOpenCodePlan,
  rejectOpenCodePlan,
  replyOpenCodePermission,
  listOpenCodePermissions,
  replyOpenCodeCommandApproval,
  getOpenCodeSessionInfo,
  undoOpenCodeSession,
  redoOpenCodeSession,
  sendOpenCodeCommand,
  listOpenCodeCommands,
  renameOpenCodeSession,
  getOpenCodeCapabilities,
  forkOpenCodeSession,
  cleanupOpenCode
} from './services/opencode-session-commands'
import { buildMenu, shutdownMenu } from './menu'
import { createLogger } from './services/logger'
import { emitWindowFocused } from './services/app-events'
import { notificationService } from './services/notification-service'
import { updaterService } from './services/updater'
import { ClaudeCodeImplementer } from './services/claude-code-implementer'
import { CodexImplementer } from './services/codex-implementer'
import { AgentSdkManager } from './services/agent-sdk-manager'
import { resolveClaudeBinaryPath } from './services/claude-binary-resolver'
import { resolveCodexBinaryPath } from './services/codex-binary-resolver'
import { resolveOpenCodeLaunchSpec } from './services/opencode-binary-resolver'
import {
  setClaudeBinaryPath as setRouterClaudeBinaryPath,
  setCodexBinaryPath as setRouterCodexBinaryPath,
  setOpenCodeLaunchSpec as setRouterOpenCodeLaunchSpec
} from './services/text-generation-router'
import type { AgentSdkImplementer } from './services/agent-sdk-types'
import { telemetryService } from './services/telemetry-service'
import { perfDiagnostics } from './services/perf-diagnostics'
import { configure as configureCodexDebugLogger } from './services/codex-debug-logger'
import { ptyService } from './services/pty-service'
import { ghosttyService } from './services/ghostty-service'
import { closeClaudeHookServer } from './services/claude-hook-server'
import { scriptRunner } from './services/script-runner'
import { cleanupScripts } from './services/script-cleanup'
import { cleanupFileTreeWatchers, getFileTreeWatcherCount } from './services/file-tree-watcher'
import { cleanupTerminals } from './services/terminal-pty-bridge'
import { bashService } from './effect/bash/facade'
import { disposeAllRuntimes } from './effect/_shared/runtime'
import { getRuntime as getSpawnRuntime } from './effect/spawn/runtime'
import {
  setDesktopBackendOpenCodeAbortHandler,
  setDesktopBackendOpenCodeCapabilitiesHandler,
  setDesktopBackendOpenCodeCommandHandler,
  setDesktopBackendOpenCodeCommandsHandler,
  setDesktopBackendOpenCodeConnectHandler,
  setDesktopBackendOpenCodeDisconnectHandler,
  setDesktopBackendOpenCodeForkHandler,
  setDesktopBackendOpenCodeGetMessagesHandler,
  setDesktopBackendOpenCodeListModelsHandler,
  setDesktopBackendOpenCodeModelInfoHandler,
  setDesktopBackendOpenCodePlanApproveHandler,
  setDesktopBackendOpenCodePlanRejectHandler,
  setDesktopBackendOpenCodeCommandApprovalReplyHandler,
  setDesktopBackendOpenCodePermissionListHandler,
  setDesktopBackendOpenCodePermissionReplyHandler,
  setDesktopBackendOpenCodePromptHandler,
  setDesktopBackendOpenCodeQuestionReplyHandler,
  setDesktopBackendOpenCodeQuestionRejectHandler,
  setDesktopBackendOpenCodeRefreshFromThreadHandler,
  setDesktopBackendOpenCodeRedoHandler,
  setDesktopBackendOpenCodeReconnectHandler,
  setDesktopBackendOpenCodeRenameSessionHandler,
  setDesktopBackendOpenCodeSetModelHandler,
  setDesktopBackendOpenCodeSessionInfoHandler,
  setDesktopBackendOpenCodeSteerHandler,
  setDesktopBackendOpenCodeUndoHandler,
  startDesktopBackend,
  stopDesktopBackend
} from './desktop/backend-manager'
import { getDesktopPreloadBootstrapArguments } from './desktop/desktop-bridge-handlers'
import type { LocalEnvironmentBootstrap } from '@shared/desktop-bridge'
import {
  initTicketProviderManager,
  GitHubProvider,
  JiraProvider
} from './services/ticket-providers'
import { APP_SETTINGS_DB_KEY } from '../shared/types/settings'
import { openCodeService } from './services/opencode-service'
import {
  createTemplateFile,
  getFileModTime,
  loadCustomCommandsFromFile
} from './services/custom-commands-file-service'
import { telegramForwardingService } from './services/telegram-forwarding-service'
import { cleanupPowerSaveBlocker } from './services/power-save-blocker'
import {
  emitCloseSessionShortcut,
  emitFileSearchShortcut,
  emitNewSessionShortcut,
  emitQuitConfirmationHide,
  emitQuitConfirmationShow
} from './services/shortcut-events'
import {
  configurePetWindow,
  destroyPetWindow,
  getPetWindow,
  shouldSuppressMainWindowActivationFromPet
} from './services/pet-window'
import {
  consumeQuitViaShortcut,
  getQuitConfirmationDecision,
  QUIT_CONFIRM_WINDOW_MS,
  readWarnBeforeQuitting
} from './quit-confirmation'
import { emitSettingsUpdated } from './services/settings-events'

const log = createLogger({ component: 'Main' })

// Track custom commands file mtime for change detection
let lastKnownMtime: number | null = null

function initializeCustomCommandsFile(): void {
  const templateResult = createTemplateFile()
  if (templateResult.created) {
    log.info('Created custom commands template file')
  } else if (!templateResult.success && templateResult.error) {
    log.error('Failed to create custom commands template:', templateResult.error)
  }

  lastKnownMtime = getFileModTime()
}

function syncCustomCommandsFileIfChanged(): void {
  const currentMtime = getFileModTime()
  if (currentMtime === null || currentMtime === lastKnownMtime) {
    return
  }

  lastKnownMtime = currentMtime
  log.info('Custom commands file changed, reloading')

  const fileResult = loadCustomCommandsFromFile()
  if (!fileResult.success) {
    log.error('Failed to load custom commands:', fileResult.error)
    return
  }

  try {
    const db = getDatabase()
    const existingSettings = db.getSetting(APP_SETTINGS_DB_KEY)
    const settings = existingSettings ? JSON.parse(existingSettings) : {}

    settings.customProjectCommands = fileResult.commands
    db.setSetting(APP_SETTINGS_DB_KEY, JSON.stringify(settings))
    emitSettingsUpdated({ customProjectCommands: fileResult.commands })
  } catch (error) {
    log.error('Failed to sync custom commands to database:', error)
  }
}

// Global error handlers — prevent uncaught errors from crashing the Electron process
process.on('uncaughtException', (error) => {
  log.error('Uncaught exception', error, { fatal: false })
})

process.on('unhandledRejection', (reason) => {
  const error = reason instanceof Error ? reason : new Error(String(reason))
  log.error('Unhandled promise rejection', error, { fatal: false })
})

const appStartTime = Date.now()
let lastQuitConfirmAt: number | null = null

// Parse CLI flags
const cliArgs = process.argv.slice(2)
const isLogMode = cliArgs.includes('--log')

interface WindowBounds {
  x: number
  y: number
  width: number
  height: number
  isMaximized?: boolean
}

const BOUNDS_FILE = join(app.getPath('userData'), 'window-bounds.json')

function loadWindowBounds(): WindowBounds | null {
  try {
    if (existsSync(BOUNDS_FILE)) {
      const data = readFileSync(BOUNDS_FILE, 'utf-8')
      const bounds = JSON.parse(data) as WindowBounds

      // Validate that the bounds are still valid (screen might have changed)
      const displays = screen.getAllDisplays()
      const isOnScreen = displays.some((display) => {
        const { x, y, width, height } = display.bounds
        return (
          bounds.x >= x &&
          bounds.y >= y &&
          bounds.x + bounds.width <= x + width &&
          bounds.y + bounds.height <= y + height
        )
      })

      if (isOnScreen) {
        return bounds
      }
    }
  } catch {
    // Ignore errors, use defaults
  }
  return null
}

function saveWindowBounds(window: BrowserWindow): void {
  try {
    const bounds = window.getBounds()
    const isMaximized = window.isMaximized()

    // Ensure directory exists
    const dir = app.getPath('userData')
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true })
    }

    writeFileSync(BOUNDS_FILE, JSON.stringify({ ...bounds, isMaximized }))
  } catch {
    // Ignore save errors
  }
}

let mainWindow: BrowserWindow | null = null

function ensureDockVisible(reason: string): void {
  if (process.platform !== 'darwin') return

  try {
    app.setActivationPolicy('regular')
    void app.dock?.show().catch((error) => {
      log.warn('Failed to show Dock icon', { reason, error })
    })
  } catch (error) {
    log.warn('Failed to enforce regular Dock activation policy', { reason, error })
  }
}

function createWindow(backendBootstrap?: LocalEnvironmentBootstrap | null): void {
  const savedBounds = loadWindowBounds()

  mainWindow = new BrowserWindow({
    width: savedBounds?.width ?? 1200,
    height: savedBounds?.height ?? 800,
    x: savedBounds?.x,
    y: savedBounds?.y,
    minWidth: 800,
    minHeight: 600,
    show: false,
    autoHideMenuBar: true,
    ...(process.platform === 'darwin'
      ? {
          titleBarStyle: 'hiddenInset' as const,
          trafficLightPosition: { x: 15, y: 10 }
        }
      : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      additionalArguments: getDesktopPreloadBootstrapArguments(backendBootstrap)
    }
  })

  ensureDockVisible('create-main-window')

  // Restore maximized state
  if (savedBounds?.isMaximized) {
    mainWindow.maximize()
  }

  let windowShown = false

  mainWindow.on('ready-to-show', () => {
    windowShown = true
    log.info('Window ready-to-show fired, showing window')
    mainWindow!.show()
  })

  // Safety timeout — on Windows the renderer can take 10+ seconds to fire ready-to-show.
  // Force-show the window after 3 seconds so the user sees something while it finishes loading.
  setTimeout(() => {
    if (!windowShown && mainWindow && !mainWindow.isDestroyed()) {
      log.warn('Window ready-to-show did not fire within 3s — force-showing window')
      mainWindow.show()
    }
  }, 3_000)

  // Log renderer failures that would silently prevent ready-to-show
  mainWindow.webContents.on(
    'did-fail-load',
    (_event, errorCode, errorDescription, validatedURL) => {
      log.error('Renderer failed to load', new Error(errorDescription), { errorCode, validatedURL })
    }
  )

  mainWindow.webContents.on('render-process-gone', (_event, details) => {
    log.error('Renderer process gone', new Error(details.reason), { exitCode: details.exitCode })
  })

  mainWindow.on('unresponsive', () => {
    log.warn('Window became unresponsive')
  })

  // Emit focus event to renderer for git refresh on window focus
  mainWindow.on('focus', () => {
    emitWindowFocused()
  })

  // Save window bounds on resize and move
  const createdWindow = mainWindow
  mainWindow.on('resize', () => saveWindowBounds(createdWindow))
  mainWindow.on('move', () => saveWindowBounds(createdWindow))
  mainWindow.on('close', () => saveWindowBounds(createdWindow))
  mainWindow.on('closed', () => {
    mainWindow = null
  })

  // Intercept Cmd+T (macOS) / Ctrl+T (Windows/Linux) before Chromium consumes it
  mainWindow.webContents.on('before-input-event', (event, input) => {
    if (
      input.key.toLowerCase() === 't' &&
      (input.meta || input.control) &&
      !input.alt &&
      !input.shift &&
      input.type === 'keyDown'
    ) {
      event.preventDefault()
      emitNewSessionShortcut()
    }

    // Intercept Cmd+D — forward to renderer to toggle file search dialog
    if (
      input.key.toLowerCase() === 'd' &&
      (input.meta || input.control) &&
      !input.alt &&
      !input.shift &&
      input.type === 'keyDown'
    ) {
      event.preventDefault()
      emitFileSearchShortcut()
    }

    // Intercept Cmd+W — never close the window, forward to renderer to close session tab
    if (
      input.key.toLowerCase() === 'w' &&
      (input.meta || input.control) &&
      !input.alt &&
      !input.shift &&
      input.type === 'keyDown'
    ) {
      event.preventDefault()
      emitCloseSessionShortcut()
    }

    // Block zoom shortcuts — Ghostty native overlay requires 1:1 coordinate mapping.
    // Any zoom level breaks the CSS-to-AppKit point sync for the NSView overlay.
    if (
      (input.meta || input.control) &&
      !input.alt &&
      (input.key === '=' || input.key === '+' || input.key === '-') &&
      input.type === 'keyDown'
    ) {
      event.preventDefault()
    }
  })

  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  // HMR for renderer based on electron-vite cli.
  // Load the remote URL for development or the local html file for production.
  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    log.info('Loading renderer URL (dev)', { url: process.env['ELECTRON_RENDERER_URL'] })
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    const rendererPath = join(__dirname, '../renderer/index.html')
    log.info('Loading renderer file', { path: rendererPath })
    mainWindow.loadFile(rendererPath)
  }
}

// This method will be called when Electron has finished
// initialization and is ready to create browser windows.
// Some APIs can only be used after this event occurs.
app
  .whenReady()
  .then(async () => {
    // Load full shell environment for macOS when launched from Finder/Dock/Spotlight.
    // Must run before any child process spawning (opencode, scripts, Claude Code SDK).
    loadShellEnv()

    // Resolve system-wide Claude binary (must run after loadShellEnv)
    const claudeBinaryPath = resolveClaudeBinaryPath()
    const codexBinaryPath = resolveCodexBinaryPath()
    const openCodeLaunchSpec = resolveOpenCodeLaunchSpec()

    log.info('App starting', {
      version: app.getVersion(),
      platform: process.platform,
      opencodeBinary: openCodeLaunchSpec?.command ?? 'not found',
      claudeBinary: claudeBinaryPath ?? 'not found',
      codexBinary: codexBinaryPath ?? 'not found'
    })

    if (isLogMode) {
      log.info('Response logging enabled via --log flag')
    }

    log.info('Starting local backend server')
    const desktopBackend = await startDesktopBackend()
    log.info('Local backend server ready', {
      httpBaseUrl: desktopBackend.bootstrap.httpBaseUrl,
      wsBaseUrl: desktopBackend.bootstrap.wsBaseUrl
    })

    // Set app user model id for windows
    electronApp.setAppUserModelId('com.hive')
    ensureDockVisible('startup')

    // Initialize database
    log.info('Initializing database')
    getDatabase()

    // Ensure the file-based custom command template exists and record its mtime.
    initializeCustomCommandsFile()

    // Initialize telemetry (must come after DB init since it reads/writes settings)
    telemetryService.init()

    // Register desktop-side integrations that back server desktop commands.
    log.info('Registering desktop integrations')
    configurePetWindow({ getMainWindow: () => mainWindow })
    initTicketProviderManager([new GitHubProvider(), new JiraProvider()])

    log.info('Creating main window')
    createWindow(desktopBackend.bootstrap)
    log.info('Main window created, waiting for renderer to load')

    // Register OpenCode handlers after window is created
    if (mainWindow) {
      // Build the full application menu (File, Edit, Session, Git, View, Window, Help)
      log.info('Building application menu')
      buildMenu(mainWindow, is.dev)

      // Create SDK manager for multi-provider dispatch
      // OpenCode sessions still route through openCodeService directly (fallback path in handlers)
      // The placeholder just satisfies AgentSdkManager's constructor signature
      const claudeImpl = new ClaudeCodeImplementer()
      claudeImpl.setDatabaseService(getDatabase())
      claudeImpl.setClaudeBinaryPath(claudeBinaryPath)
      setRouterClaudeBinaryPath(claudeBinaryPath)
      openCodeService.setOpenCodeLaunchSpec(openCodeLaunchSpec)
      setRouterOpenCodeLaunchSpec(openCodeLaunchSpec)
      const openCodePlaceholder = {
        id: 'opencode' as const,
        capabilities: {
          supportsUndo: true,
          supportsRedo: true,
          supportsCommands: true,
          supportsPermissionRequests: true,
          supportsQuestionPrompts: true,
          supportsModelSelection: true,
          supportsReconnect: true,
          supportsPartialStreaming: true,
          supportsSteer: false
        },
        connect: async () => ({ sessionId: '' }),
        reconnect: async () => ({ success: false }),
        disconnect: async () => {},
        cleanup: async () => {},
        prompt: async () => {},
        abort: async () => false,
        getMessages: async () => [],
        getAvailableModels: async () => ({}),
        getModelInfo: async () => null,
        setSelectedModel: () => {},
        getSessionInfo: async () => ({ revertMessageID: null, revertDiff: null }),
        questionReply: async () => {},
        questionReject: async () => {},
        permissionReply: async () => {},
        permissionList: async () => [],
        undo: async () => ({}),
        redo: async () => ({}),
        listCommands: async () => [],
        sendCommand: async () => {},
        renameSession: async () => {}
      } satisfies AgentSdkImplementer
      const codexImpl = new CodexImplementer()
      codexImpl.setDatabaseService(getDatabase())
      codexImpl.setCodexBinaryPath(codexBinaryPath)
      setRouterCodexBinaryPath(codexBinaryPath)
      const sdkManager = new AgentSdkManager([openCodePlaceholder, claudeImpl, codexImpl])
      getSpawnRuntime()

      const databaseService = getDatabase()
      telegramForwardingService.initialize({ db: databaseService, sdkManager })

      log.info('Initializing OpenCode desktop integration')
      setDesktopBackendOpenCodeConnectHandler((worktreePath, hiveSessionId) =>
        connectOpenCodeSession(worktreePath, hiveSessionId, sdkManager, databaseService)
      )
      setDesktopBackendOpenCodeReconnectHandler((worktreePath, opencodeSessionId, hiveSessionId) =>
        reconnectOpenCodeSession(
          worktreePath,
          opencodeSessionId,
          hiveSessionId,
          sdkManager,
          databaseService
        )
      )
      setDesktopBackendOpenCodePromptHandler(
        (worktreePath, opencodeSessionId, messageOrParts, model, options) =>
          promptOpenCodeSession(
            worktreePath,
            opencodeSessionId,
            messageOrParts,
            model,
            options,
            sdkManager,
            databaseService
          )
      )
      setDesktopBackendOpenCodeAbortHandler((worktreePath, opencodeSessionId) =>
        abortOpenCodeSession(worktreePath, opencodeSessionId, sdkManager, databaseService)
      )
      setDesktopBackendOpenCodeSteerHandler((worktreePath, opencodeSessionId, message) =>
        steerOpenCodeSession(worktreePath, opencodeSessionId, message, sdkManager, databaseService)
      )
      setDesktopBackendOpenCodeDisconnectHandler((worktreePath, opencodeSessionId) =>
        disconnectOpenCodeSession(worktreePath, opencodeSessionId, sdkManager, databaseService)
      )
      setDesktopBackendOpenCodeGetMessagesHandler((worktreePath, opencodeSessionId) =>
        getOpenCodeSessionMessages(worktreePath, opencodeSessionId, sdkManager, databaseService)
      )
      setDesktopBackendOpenCodeRefreshFromThreadHandler((worktreePath, opencodeSessionId) =>
        refreshOpenCodeSessionFromThread(
          worktreePath,
          opencodeSessionId,
          sdkManager,
          databaseService
        )
      )
      setDesktopBackendOpenCodeListModelsHandler((opts) => listOpenCodeModels(opts, sdkManager))
      setDesktopBackendOpenCodeSetModelHandler((model) =>
        setOpenCodeSelectedModel(model, sdkManager)
      )
      setDesktopBackendOpenCodeModelInfoHandler((worktreePath, modelId, agentSdk) =>
        getOpenCodeModelInfo(worktreePath, modelId, agentSdk, sdkManager)
      )
      setDesktopBackendOpenCodeQuestionReplyHandler((requestId, answers, worktreePath) =>
        replyOpenCodeQuestion(requestId, answers, worktreePath, sdkManager)
      )
      setDesktopBackendOpenCodeQuestionRejectHandler((requestId, worktreePath) =>
        rejectOpenCodeQuestion(requestId, worktreePath, sdkManager)
      )
      setDesktopBackendOpenCodePlanApproveHandler((worktreePath, hiveSessionId, requestId) =>
        approveOpenCodePlan(worktreePath, hiveSessionId, requestId, sdkManager)
      )
      setDesktopBackendOpenCodePlanRejectHandler(
        (worktreePath, hiveSessionId, feedback, requestId) =>
          rejectOpenCodePlan(worktreePath, hiveSessionId, feedback, requestId, sdkManager)
      )
      setDesktopBackendOpenCodePermissionReplyHandler((requestId, reply, worktreePath, message) =>
        replyOpenCodePermission(requestId, reply, worktreePath, message, sdkManager)
      )
      setDesktopBackendOpenCodePermissionListHandler((worktreePath) =>
        listOpenCodePermissions(worktreePath, sdkManager)
      )
      setDesktopBackendOpenCodeCommandApprovalReplyHandler(
        (requestId, approved, remember, pattern, worktreePath, patterns) =>
          replyOpenCodeCommandApproval(
            requestId,
            approved,
            remember,
            pattern,
            worktreePath,
            patterns,
            sdkManager
          )
      )
      setDesktopBackendOpenCodeSessionInfoHandler((worktreePath, opencodeSessionId) =>
        getOpenCodeSessionInfo(worktreePath, opencodeSessionId, sdkManager, databaseService)
      )
      setDesktopBackendOpenCodeUndoHandler((worktreePath, opencodeSessionId) =>
        undoOpenCodeSession(worktreePath, opencodeSessionId, sdkManager, databaseService)
      )
      setDesktopBackendOpenCodeRedoHandler((worktreePath, opencodeSessionId) =>
        redoOpenCodeSession(worktreePath, opencodeSessionId, sdkManager, databaseService)
      )
      setDesktopBackendOpenCodeCommandHandler(
        (worktreePath, opencodeSessionId, command, args, model) =>
          sendOpenCodeCommand(
            worktreePath,
            opencodeSessionId,
            command,
            args,
            model,
            sdkManager,
            databaseService
          )
      )
      setDesktopBackendOpenCodeCommandsHandler((worktreePath, sessionId) =>
        listOpenCodeCommands(worktreePath, sessionId, sdkManager, databaseService)
      )
      setDesktopBackendOpenCodeRenameSessionHandler((opencodeSessionId, title, worktreePath) =>
        renameOpenCodeSession(opencodeSessionId, title, worktreePath, sdkManager, databaseService)
      )
      setDesktopBackendOpenCodeCapabilitiesHandler((sessionId) =>
        getOpenCodeCapabilities(sessionId, sdkManager, databaseService)
      )
      setDesktopBackendOpenCodeForkHandler((worktreePath, opencodeSessionId, messageId) =>
        forkOpenCodeSession(worktreePath, opencodeSessionId, messageId)
      )
      log.info('Initializing Ghostty desktop integration')
      ghosttyService.setMainWindow(mainWindow)

      // Set up notification service with main window reference
      notificationService.setMainWindow(mainWindow)

      // Initialize auto-updater after backend event publishing is available.
      updaterService.init()

      // Wire up performance diagnostics collectors and auto-start if enabled
      perfDiagnostics.setCollectors({
        getPtyCount: () => ptyService.getCount(),
        getScriptStats: () => scriptRunner.getStats(),
        getFileWatcherCount: () => getFileTreeWatcherCount(),
        getWorktreeWatcherCount: () => -1,
        getBranchWatcherCount: () => -1,
        getActiveSessionCount: () => {
          try {
            return getDatabase().countActiveSessions()
          } catch {
            return -1
          }
        },
        getElectronProcessCounts: () => ({
          windows: BrowserWindow.getAllWindows().length,
          webContents: webContents.getAllWebContents().length
        })
      })

      // Auto-start perf diagnostics if setting is enabled
      try {
        const raw = getDatabase().getSetting(APP_SETTINGS_DB_KEY)
        if (raw) {
          const settings = JSON.parse(raw) as { perfDiagnosticsEnabled?: boolean }
          if (settings.perfDiagnosticsEnabled) {
            log.info('Auto-starting performance diagnostics (setting enabled)')
            perfDiagnostics.start()
          }
        }
      } catch {
        // ignore — setting may not exist yet
      }

      // Auto-enable codex JSONL logging if setting is enabled
      try {
        const raw = getDatabase().getSetting(APP_SETTINGS_DB_KEY)
        if (raw) {
          const settings = JSON.parse(raw) as {
            codexJsonlLoggingEnabled?: boolean
            codexJsonlResetPerSession?: boolean
          }
          if (settings.codexJsonlLoggingEnabled) {
            log.info('Auto-enabling codex JSONL logging (setting enabled)')
            configureCodexDebugLogger({
              enabled: true,
              resetPerSession: settings.codexJsonlResetPerSession ?? true
            })
          }
        }
      } catch {
        // ignore — setting may not exist yet
      }

      // Track app launch telemetry
      telemetryService.track('app_launched')
      telemetryService.identify({
        platform: process.platform,
        app_version: app.getVersion(),
        electron_version: process.versions.electron
      })
    }

    app.on('activate', function () {
      ensureDockVisible('activate')

      if (shouldSuppressMainWindowActivationFromPet()) {
        return
      }

      // The pet overlay is an auxiliary window and should not count as a main app
      // window for Dock activation. If only the pet exists, re-create Hive.
      const petWindow = getPetWindow()
      const hasMainAppWindow = BrowserWindow.getAllWindows().some(
        (window) => window !== petWindow && !window.isDestroyed()
      )

      if (!hasMainAppWindow) {
        createWindow()
        return
      }

      if (mainWindow && !mainWindow.isDestroyed()) {
        if (mainWindow.isMinimized()) {
          mainWindow.restore()
        }
        mainWindow.show()
        mainWindow.focus()
      }

      syncCustomCommandsFileIfChanged()
    })
  })
  .catch((error) => {
    log.error(
      'Fatal error during app startup',
      error instanceof Error ? error : new Error(String(error))
    )
    app.quit()
  })

// Quit when all windows are closed, except on macOS. There, it's common
// for applications and their menu bar to stay active until the user quits
// explicitly with Cmd + Q.
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

app.on('before-quit', (event) => {
  const viaShortcut = consumeQuitViaShortcut()
  if (!viaShortcut) return

  if (!mainWindow || mainWindow.isDestroyed()) return

  const warnBeforeQuitting = readWarnBeforeQuitting(getDatabase().getSetting(APP_SETTINGS_DB_KEY))
  const decision = getQuitConfirmationDecision({
    now: Date.now(),
    lastQuitConfirmAt,
    warnBeforeQuitting
  })

  lastQuitConfirmAt = decision.lastQuitConfirmAt

  if (!decision.shouldPreventQuit) return

  event.preventDefault()

  if (mainWindow.isMinimized()) {
    mainWindow.restore()
  }
  mainWindow.show()
  mainWindow.focus()
  emitQuitConfirmationShow()

  setTimeout(() => {
    if (lastQuitConfirmAt && Date.now() - lastQuitConfirmAt >= QUIT_CONFIRM_WINDOW_MS) {
      lastQuitConfirmAt = null
      if (mainWindow && !mainWindow.isDestroyed()) {
        emitQuitConfirmationHide()
      }
    }
  }, QUIT_CONFIRM_WINDOW_MS + 50)
})

// Cleanup when app is about to quit
app.on('will-quit', async () => {
  // Prevent further menu mutations — must be first to avoid native WeakPtr errors
  shutdownMenu()
  // Destroy ambient pet overlay before tearing down app services
  destroyPetWindow()
  // Cleanup performance diagnostics
  perfDiagnostics.cleanup()
  // Cleanup updater timers
  updaterService.cleanup()
  // Cleanup terminal PTYs
  cleanupTerminals()
  // Cleanup Claude CLI hook server
  await closeClaudeHookServer()
  // Cleanup running scripts
  cleanupScripts()
  // Cleanup running bash runs (best-effort, no await)
  bashService.killAll()
  await disposeAllRuntimes()
  // Stop local backend server
  await stopDesktopBackend()
  // Release any held power save blocker so the display can sleep again
  cleanupPowerSaveBlocker()
  // Cleanup file tree watchers
  await cleanupFileTreeWatchers()
  // Cleanup OpenCode connections
  await cleanupOpenCode()
  telegramForwardingService.dispose()
  // Flush telemetry before closing database
  telemetryService.track('app_session_ended', {
    session_duration_ms: Date.now() - appStartTime
  })
  await telemetryService.shutdown()
  // Close database
  closeDatabase()
})
