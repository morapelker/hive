import { loadShellEnv } from './services/shell-env'
import { app, shell, BrowserWindow, Menu, dialog, powerMonitor } from 'electron'
import { join } from 'path'
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
import { disposeVoiceDictation, initVoiceDictation } from './voice/voice-ipc'
import { createLogger } from './services/logger'
import { wireHeadlessSignalShutdown } from './services/headless-shutdown'
import {
  getMainWindowChromeOptions,
  loadWindowBounds,
  registerWindowChromeHandlers,
  wireWindowChromeEvents
} from './window-chrome'
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
import { discordService } from './services/discord-service'
import {
  configureElectronMainPerfLogging,
  getElectronMainPerfLogger
} from './services/perf-logging/electron-main-perf'
import { configure as configureCodexDebugLogger } from './services/codex-debug-logger'
import { ptyService } from './services/pty-service'
import {
  reconcileShellCommandRuns,
  startShellCommandRunSweep
} from './services/shell-command-runs'
import { ghosttyService } from './services/ghostty-service'
import { getGhosttyConfigPathOnce } from './services/ghostty-config-store'
import { closeClaudeHookServer } from './services/claude-hook-server'
import { agentEventBus } from './services/agent-event-bus'
import { startSdkTurnRecorder } from './services/document-flow/sdk-turn-recorder'
import { recordSessionFinalMessage } from './services/document-flow/session-final-message-recorder'
import {
  closeClaudeApiProxy,
  dropClaudeApiProxyUpstreamSockets,
  getClaudeApiProxyHostStatus,
  onClaudeApiProxyHostEvent,
  probeClaudeApiUpstream,
  startClaudeApiProxy
} from './services/claude-api-proxy/claude-api-proxy'
import { startThreadpoolProbe } from './services/perf-logging/threadpool-probe'
import { publishDesktopBackendEvent } from './desktop/backend-event-publisher'
import { createThreadpoolStallRecovery } from './services/perf-logging/threadpool-stall-recovery'
import { wakeThreadpoolWorkers } from './services/perf-logging/threadpool-waker'
import {
  configureClaudeCliSessionRecovery,
  disposeClaudeCliSessionRecovery
} from './services/claude-cli-session-recovery'
import { getLastClaudeCliStatus } from './services/claude-hook-server'
import { writeClaudeCliPrompt } from './services/claude-cli-pty-prompt'
import { scriptRunner } from './services/script-runner'
import { cleanupScripts } from './services/script-cleanup'
import { cleanupFileTreeWatchers, getFileTreeWatcherCount } from './services/file-tree-watcher'
import { cleanupTerminals } from './services/terminal-pty-bridge'
import { wireQuitCleanup } from './services/quit-cleanup'
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
  APP_STARTED_AT,
  startDesktopBackend,
  stopDesktopBackend
} from './desktop/backend-manager'
import {
  getDesktopPreloadBootstrapArguments,
  registerDesktopBridgeHandlers
} from './desktop/desktop-bridge-handlers'
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
import { markDeepLinksReady, registerDeepLinkHandling } from './services/deep-link-service'

const log = createLogger({ component: 'Main' })

// Must be wired before app 'ready' so cold-start hive:// links are captured.
registerDeepLinkHandling()

// Track custom commands file mtime for change detection
let lastKnownMtime: number | null = null

function initializeCustomCommandsFile(): void {
  try {
    const db = getDatabase()
    const existingSettings = db.getSetting(APP_SETTINGS_DB_KEY)
    const settings = existingSettings ? JSON.parse(existingSettings) : {}
    const hasCustomCommandsInDb = Array.isArray(settings.customProjectCommands)

    if (!hasCustomCommandsInDb && getFileModTime() === null) {
      const templateResult = createTemplateFile()
      if (templateResult.created) {
        log.info('Created custom commands template file (first launch)')
      } else if (!templateResult.success && templateResult.error) {
        log.error('Failed to create custom commands template:', templateResult.error)
      }
    }
  } catch (error) {
    log.error('Failed to initialize custom commands file:', error)
  }

  lastKnownMtime = getFileModTime()
}

function syncCustomCommandsFileIfChanged(): void {
  const currentMtime = getFileModTime()
  if (currentMtime === lastKnownMtime) {
    return
  }

  lastKnownMtime = currentMtime

  if (currentMtime === null) {
    log.info('Custom commands file deleted, clearing commands')
    try {
      const db = getDatabase()
      const existingSettings = db.getSetting(APP_SETTINGS_DB_KEY)
      const settings = existingSettings ? JSON.parse(existingSettings) : {}

      settings.customProjectCommands = []
      db.setSetting(APP_SETTINGS_DB_KEY, JSON.stringify(settings))
      emitSettingsUpdated({ customProjectCommands: [] })
    } catch (error) {
      log.error('Failed to clear custom commands from database:', error)
    }
    return
  }

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

    settings.customProjectCommands = fileResult.commands ?? []
    db.setSetting(APP_SETTINGS_DB_KEY, JSON.stringify(settings))
    emitSettingsUpdated({ customProjectCommands: fileResult.commands ?? [] })
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
const isHeadless = cliArgs.includes('--headless') || process.env.HIVE_HEADLESS === '1'
wireHeadlessSignalShutdown({ app, isHeadless })

let mainWindow: BrowserWindow | null = null
const wiredWindows = new WeakSet<BrowserWindow>()
let allowHeadlessDockActivation = false

/** Probe ticks are 15 s apart: a stall is declared after 30 s, a restart offered after 2 min. */
const THREADPOOL_STALL_AFTER = 2
const THREADPOOL_PROMPT_RESTART_AFTER = 8

/**
 * The last resort when waking the pool did not help. `app.exit` rather than
 * `app.quit`: the quit cleanup awaits file I/O on the very pool that is stuck.
 */
function promptRestartForThreadpoolStall(): void {
  if (isHeadless) return
  const options: Electron.MessageBoxOptions = {
    type: 'warning',
    buttons: ['Restart Now', 'Later'],
    defaultId: 0,
    cancelId: 1,
    message: 'Hive needs a restart',
    detail:
      "The app's background file access stopped responding, so terminals may not accept input. Restarting fixes it."
  }
  const window = mainWindow && !mainWindow.isDestroyed() ? mainWindow : null
  void (window ? dialog.showMessageBox(window, options) : dialog.showMessageBox(options)).then(
    ({ response }) => {
      if (response !== 0) return
      log.warn('Restarting after a thread-pool stall')
      app.relaunch()
      app.exit(0)
    }
  )
}

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
    ...getMainWindowChromeOptions(),
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
    syncCustomCommandsFileIfChanged()
  })

  // Save window bounds on resize and move
  wireWindowChromeEvents(mainWindow)
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

    // Intercept Cmd+W — never close the window, forward to renderer to close the active
    // modal / terminal / file / diff tab (session tabs are never closed by Cmd+W)
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

function wireWindow(window: BrowserWindow): void {
  if (wiredWindows.has(window)) return
  wiredWindows.add(window)

  log.info('Building application menu')
  buildMenu(window, is.dev)

  log.info('Initializing Ghostty desktop integration')
  ghosttyService.setMainWindow(window)

  notificationService.setMainWindow(window)
}

function openMainWindow(backendBootstrap?: LocalEnvironmentBootstrap | null): void {
  createWindow(backendBootstrap)
  if (mainWindow) {
    wireWindow(mainWindow)
  }
}

function configureHeadlessDockMenu(backendBootstrap: LocalEnvironmentBootstrap): void {
  if (process.platform !== 'darwin') return

  app.dock?.setMenu(
    Menu.buildFromTemplate([
      {
        label: 'Open Hive Window',
        click: () => openMainWindow(backendBootstrap)
      }
    ])
  )
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

    // Route every Claude Code process through the local API proxy so the
    // subscription usage headers on each response update the usage bars in
    // real time. Must come after loadShellEnv (it chains to the user's own
    // ANTHROPIC_BASE_URL, if any) and before the backend child and any
    // terminal spawns, which inherit process.env.
    const claudeApiProxy = await startClaudeApiProxy()
    if (claudeApiProxy.started) {
      powerMonitor.on('resume', () => dropClaudeApiProxyUpstreamSockets())
      // Host lifecycle (restarts, stalls, missed pings) into the app log; the perf
      // log gets the same events as marks from the proxy module itself.
      onClaudeApiProxyHostEvent((name, data) => {
        if (name === 'proxy-host-start') return
        log.warn(`Claude API proxy host event: ${name}`, data)
      })
    }

    // Sessions whose turn died of a transient API failure (a hang, a dropped
    // link, a 5xx) are re-prompted once the API answers through the proxy
    // again — the user would otherwise have to find and poke each one.
    configureClaudeCliSessionRecovery({
      hasLivePty: (sessionId) => ptyService.has(sessionId),
      getLastStatus: (sessionId) => getLastClaudeCliStatus(sessionId),
      getAgentSdk: (sessionId) => {
        try {
          return getDatabase().getSession(sessionId)?.agent_sdk ?? null
        } catch {
          return null
        }
      },
      writePrompt: (sessionId, prompt) => writeClaudeCliPrompt(sessionId, prompt),
      probeUpstream: (timeoutMs) => probeClaudeApiUpstream(timeoutMs),
      isEnabled: () => {
        try {
          const raw = getDatabase().getSetting(APP_SETTINGS_DB_KEY)
          if (!raw) return true
          const settings = JSON.parse(raw) as { claudeCliAutoResumeAfterApiError?: boolean }
          return settings.claudeCliAutoResumeAfterApiError !== false
        } catch {
          return true
        }
      },
      publish: (channel, payload) => publishDesktopBackendEvent(channel, payload),
      log: createLogger({ component: 'ClaudeCliSessionRecovery' }),
      mark: (name, data) => getElectronMainPerfLogger().mark(name, data)
    })

    // Cache the XDG-only config path for native terminals without probing
    // Ghostty's protected Application Support directory.
    if (process.platform === 'darwin') {
      getGhosttyConfigPathOnce()
    }

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
    if (isHeadless) {
      log.info('Headless mode enabled')
    }

    log.info('Starting local backend server')
    const desktopBackend = await startDesktopBackend({ headless: isHeadless })
    log.info('Local backend server ready', {
      httpBaseUrl: desktopBackend.bootstrap.httpBaseUrl,
      wsBaseUrl: desktopBackend.bootstrap.wsBaseUrl
    })
    log.info(`Hive web UI available at ${desktopBackend.bootstrap.httpBaseUrl} (open in Chrome)`)

    // Set app user model id for windows
    electronApp.setAppUserModelId('com.hive')
    ensureDockVisible('startup')

    // Initialize database
    log.info('Initializing database')
    // The server child gets this instance's start time in its environment; the setting is
    // the fallback of a child that was not handed it (the database is shared by instances).
    getDatabase().setSetting('app_started_at', APP_STARTED_AT)

    // Shell command runs left over from the previous app lifetime: finalize the ones
    // that finished or died, re-adopt detached ones that are still running.
    await reconcileShellCommandRuns().catch((error) => {
      log.warn('Shell command run reconcile failed', {
        error: error instanceof Error ? error.message : String(error)
      })
    })
    startShellCommandRunSweep()

    // Ensure the file-based custom command template exists and record its mtime.
    initializeCustomCommandsFile()

    // Initialize telemetry (must come after DB init since it reads/writes settings)
    telemetryService.init()

    // Register desktop-side integrations that back server desktop commands.
    log.info('Registering desktop integrations')
    registerDesktopBridgeHandlers()
    registerWindowChromeHandlers(() => mainWindow)
    configurePetWindow({ getMainWindow: () => mainWindow, headless: isHeadless })
    initTicketProviderManager([new GitHubProvider(), new JiraProvider()])

    // Create SDK manager for multi-provider dispatch.
    // OpenCode sessions still route through openCodeService directly (fallback path in handlers).
    // The placeholder just satisfies AgentSdkManager's constructor signature.
    const claudeImpl = new ClaudeCodeImplementer()
    claudeImpl.setDatabaseService(getDatabase())
    claudeImpl.setClaudeBinaryPath(claudeBinaryPath)
    claudeImpl.setHeadless(isHeadless)
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
    discordService.setAgentSdkManager(sdkManager)
    getSpawnRuntime()

    const databaseService = getDatabase()
    telegramForwardingService.initialize({ db: databaseService, sdkManager })
    // Document runs resumed after a reload learn from this that an SDK session's turn ended.
    startSdkTurnRecorder({
      subscribe: (listener) => agentEventBus.subscribe(listener),
      getSessionSdk: (sessionId) => databaseService.getSession(sessionId)?.agent_sdk,
      record: recordSessionFinalMessage
    })

    // Voice dictation (hotkey → local speech model → paste). Off until enabled in Settings.
    log.info('Initializing voice dictation')
    initVoiceDictation({ db: databaseService, getMainWindow: () => mainWindow, headless: isHeadless })

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
      refreshOpenCodeSessionFromThread(worktreePath, opencodeSessionId, sdkManager, databaseService)
    )
    setDesktopBackendOpenCodeListModelsHandler((opts) => listOpenCodeModels(opts, sdkManager))
    setDesktopBackendOpenCodeSetModelHandler((model) => setOpenCodeSelectedModel(model, sdkManager))
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
    setDesktopBackendOpenCodePlanRejectHandler((worktreePath, hiveSessionId, feedback, requestId) =>
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
      (worktreePath, opencodeSessionId, command, args, model, options) =>
        sendOpenCodeCommand(
          worktreePath,
          opencodeSessionId,
          command,
          args,
          model,
          options,
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

    // Performance logging (Settings → Advanced): the Electron main process samples itself
    // alongside the server child. Auto-start when the persisted setting is on.
    const mainPerfLogger = getElectronMainPerfLogger()
    mainPerfLogger.registerGauge('main.ptys', () => ptyService.getCount())
    mainPerfLogger.registerGauge('main.scripts', () => scriptRunner.getStats())
    mainPerfLogger.registerGauge('main.fileTreeWatchers', () => getFileTreeWatcherCount())
    mainPerfLogger.registerGauge('claudeApiProxyHost', () => {
      const status = getClaudeApiProxyHostStatus()
      if (!status) return { running: 0 }
      const health = status.lastHealth
      const snapshot: Record<string, number> = {
        running: status.state === 'running' ? 1 : 0,
        restarts: status.restarts,
        missedPings: status.missedPings,
        pongAgeS: status.lastPongAt ? Math.round((Date.now() - status.lastPongAt) / 1000) : -1,
        hostRssMb: health?.rssMb ?? 0,
        hostInFlight: health?.stats.inFlight ?? 0,
        hostProbeMisses: health?.probe?.consecutiveMisses ?? 0
      }
      return snapshot
    })
    // The thread-pool heartbeat runs regardless of the perf switch: a stall is
    // the one failure that leaves every other signal looking healthy, and the
    // app log must say so even when perf logging is off.
    const threadpoolProbeLog = createLogger({ component: 'ThreadpoolProbe' })
    // Every terminal keystroke is an fs.write on this pool (node-pty), so a
    // wedged pool is "terminals stopped taking input": wake the workers at
    // once, and offer a restart if that does not bring them back.
    const threadpoolStallRecovery = createThreadpoolStallRecovery({
      stallAfter: THREADPOOL_STALL_AFTER,
      promptRestartAfter: THREADPOOL_PROMPT_RESTART_AFTER,
      log: threadpoolProbeLog,
      wake: wakeThreadpoolWorkers,
      promptRestart: promptRestartForThreadpoolStall,
      dumpHandles: () => {
        if (mainPerfLogger.isEnabled()) mainPerfLogger.dumpHandles('threadpool-stall')
      }
    })
    startThreadpoolProbe({
      log: threadpoolProbeLog,
      stallAfter: THREADPOOL_STALL_AFTER,
      onStall: threadpoolStallRecovery.onStall,
      onRecover: threadpoolStallRecovery.onRecover
    })
    try {
      const raw = getDatabase().getSetting(APP_SETTINGS_DB_KEY)
      if (raw) {
        const settings = JSON.parse(raw) as { perfDiagnosticsEnabled?: boolean }
        if (settings.perfDiagnosticsEnabled) {
          log.info('Auto-starting performance logging (setting enabled)')
          configureElectronMainPerfLogging(true)
        }
      }
    } catch {
      // ignore - setting may not exist yet
    }

    // Auto-enable codex JSONL logging if setting is enabled.
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
      // ignore - setting may not exist yet
    }

    // Track app launch telemetry.
    telemetryService.track('app_launched')
    telemetryService.identify({
      platform: process.platform,
      app_version: app.getVersion(),
      electron_version: process.versions.electron
    })

    if (isHeadless) {
      configureHeadlessDockMenu(desktopBackend.bootstrap)
      log.info('Running in HEADLESS mode - no native window. Discord bot active if configured.')
      log.info(`Web UI available at ${desktopBackend.bootstrap.httpBaseUrl} (open in a browser)`)
      setTimeout(() => {
        allowHeadlessDockActivation = true
      }, 5_000)
    } else {
      log.info('Creating main window')
      openMainWindow(desktopBackend.bootstrap)
      log.info('Main window created, waiting for renderer to load')
    }

    if (!isHeadless) {
      // Initialize auto-updater after backend event publishing is available.
      updaterService.init()
    }

    // Backend is up — deep links can now import accounts and publish events.
    markDeepLinksReady()

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
        if (isHeadless && !allowHeadlessDockActivation) {
          log.info('Ignoring early activate event in headless mode')
          return
        }
        openMainWindow(desktopBackend.bootstrap)
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
  if (process.platform !== 'darwin' && !isHeadless) {
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

// Cleanup when app is about to quit. Electron does not await async event
// handlers, so quit is always prevented while the cleanup chain runs and the
// app exits explicitly afterwards — otherwise teardown races the cleanup and
// live native watcher instances can deadlock the main thread (fsevents).
wireQuitCleanup({
  app,
  steps: [
    // Prevent further menu mutations — must be first to avoid native WeakPtr errors
    { name: 'shutdownMenu', run: () => shutdownMenu() },
    // Destroy ambient pet overlay before tearing down app services
    { name: 'destroyPetWindow', run: () => destroyPetWindow() },
    // Release the hotkey, the pill window and the speech engine worker
    { name: 'voiceDictation', run: () => disposeVoiceDictation() },
    { name: 'perfLogging', run: () => getElectronMainPerfLogger().stop() },
    { name: 'updaterService', run: () => updaterService.cleanup() },
    // Terminal PTYs and Ghostty runtime
    { name: 'cleanupTerminals', run: () => cleanupTerminals() },
    { name: 'closeClaudeHookServer', run: () => closeClaudeHookServer() },
    { name: 'sessionRecovery', run: () => disposeClaudeCliSessionRecovery() },
    { name: 'closeClaudeApiProxy', run: () => closeClaudeApiProxy() },
    { name: 'cleanupScripts', run: () => cleanupScripts() },
    { name: 'bashKillAll', run: () => bashService.killAll() },
    { name: 'disposeAllRuntimes', run: () => disposeAllRuntimes() },
    { name: 'stopDesktopBackend', run: () => stopDesktopBackend() },
    // Release any held power save blocker so the display can sleep again
    { name: 'cleanupPowerSaveBlocker', run: () => cleanupPowerSaveBlocker() },
    // Close chokidar watchers before exit so no live native watcher instances
    // remain when the Node environment is torn down
    { name: 'cleanupFileTreeWatchers', run: () => cleanupFileTreeWatchers() },
    { name: 'cleanupOpenCode', run: () => cleanupOpenCode() },
    { name: 'telegramForwarding', run: () => telegramForwardingService.dispose() },
    {
      name: 'telemetryShutdown',
      run: () => {
        telemetryService.track('app_session_ended', {
          session_duration_ms: Date.now() - appStartTime
        })
        return telemetryService.shutdown()
      }
    },
    { name: 'closeDatabase', run: () => closeDatabase() }
  ]
})
