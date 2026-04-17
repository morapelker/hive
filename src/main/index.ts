import { loadShellEnv } from './services/shell-env'
import { app, shell, BrowserWindow, screen, ipcMain, clipboard } from 'electron'
import { join } from 'path'
import { spawn, exec } from 'child_process'
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs'
import { electronApp, is } from '@electron-toolkit/utils'
import { getDatabase, closeDatabase } from './db'
import {
  registerDatabaseHandlers,
  registerProjectHandlers,
  registerWorktreeHandlers,
  registerOpenCodeHandlers,
  cleanupOpenCode,
  registerFileTreeHandlers,
  cleanupFileTreeWatchers,
  getFileTreeWatcherCount,
  registerGitFileHandlers,
  cleanupWorktreeWatchers,
  cleanupBranchWatchers,
  getWorktreeWatcherCount,
  getBranchWatcherCount,
  registerSettingsHandlers,
  registerFileHandlers,
  registerScriptHandlers,
  cleanupScripts,
  registerTerminalHandlers,
  cleanupTerminals,
  registerUpdaterHandlers,
  registerConnectionHandlers,
  registerUsageHandlers,
  registerAccountHandlers,
  registerKanbanHandlers,
  registerAttachmentHandlers
} from './ipc'
import { buildMenu, updateMenuState, shutdownMenu } from './menu'
import type { MenuState } from './menu'
import { createLogger, getLogDir } from './services/logger'
import { detectAgentSdks } from './services/system-info'
import { createResponseLog, appendResponseLog } from './services/response-logger'
import { notificationService } from './services/notification-service'
import { updaterService } from './services/updater'
import { ClaudeCodeImplementer } from './services/claude-code-implementer'
import { CodexImplementer } from './services/codex-implementer'
import { AgentSdkManager } from './services/agent-sdk-manager'
import { resolveClaudeBinaryPath } from './services/claude-binary-resolver'
import { resolveCodexBinaryPath } from './services/codex-binary-resolver'
import {
  resolveOpenCodeLaunchSpec,
  type OpenCodeLaunchSpec
} from './services/opencode-binary-resolver'
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
import { scriptRunner } from './services/script-runner'
import { bashService } from './services/bash-service'
import { registerBashHandlers } from './ipc/bash-handlers'
import { registerTicketImportHandlers } from './ipc/ticket-import-handlers'
import { initTicketProviderManager, GitHubProvider, JiraProvider } from './services/ticket-providers'
import { APP_SETTINGS_DB_KEY } from '../shared/types/settings'
import { openCodeService } from './services/opencode-service'
import { setKeepAwake, cleanupPowerSaveBlocker } from './services/power-save-blocker'

const log = createLogger({ component: 'Main' })

// Global error handlers — prevent uncaught errors from crashing the Electron process
process.on('uncaughtException', (error) => {
  log.error('Uncaught exception', error, { fatal: false })
})

process.on('unhandledRejection', (reason) => {
  const error = reason instanceof Error ? reason : new Error(String(reason))
  log.error('Unhandled promise rejection', error, { fatal: false })
})

const appStartTime = Date.now()

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

function createWindow(): void {
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
      sandbox: true
    }
  })

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
  mainWindow.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL) => {
    log.error('Renderer failed to load', new Error(errorDescription), { errorCode, validatedURL })
  })

  mainWindow.webContents.on('render-process-gone', (_event, details) => {
    log.error('Renderer process gone', new Error(details.reason), { exitCode: details.exitCode })
  })

  mainWindow.on('unresponsive', () => {
    log.warn('Window became unresponsive')
  })

  // Emit focus event to renderer for git refresh on window focus
  mainWindow.on('focus', () => {
    mainWindow!.webContents.send('app:windowFocused')
  })

  // Save window bounds on resize and move
  mainWindow.on('resize', () => saveWindowBounds(mainWindow))
  mainWindow.on('move', () => saveWindowBounds(mainWindow))
  mainWindow.on('close', () => saveWindowBounds(mainWindow))

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
      mainWindow!.webContents.send('shortcut:new-session')
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
      mainWindow!.webContents.send('shortcut:file-search')
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
      mainWindow!.webContents.send('shortcut:close-session')
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

// Register system IPC handlers
function registerSystemHandlers(openCodeLaunchSpec: OpenCodeLaunchSpec | null): void {
  // Get log directory path
  ipcMain.handle('system:getLogDir', () => {
    return getLogDir()
  })

  // Get app version
  ipcMain.handle('system:getAppVersion', () => {
    return app.getVersion()
  })

  // Get app paths
  ipcMain.handle('system:getAppPaths', () => {
    return {
      userData: app.getPath('userData'),
      home: app.getPath('home'),
      logs: getLogDir()
    }
  })

  // Check if response logging is enabled
  ipcMain.handle('system:isLogMode', () => isLogMode)

  // Open a URL in Chrome (or default browser) with optional custom command
  ipcMain.handle(
    'system:openInChrome',
    async (_event, { url, customCommand }: { url: string; customCommand?: string }) => {
      try {
        if (customCommand) {
          // If the command contains {url}, substitute it; otherwise append the URL
          const cmd = customCommand.includes('{url}')
            ? customCommand.replace(/\{url\}/g, url)
            : `${customCommand} ${url}`
          await new Promise<void>((resolve, reject) => {
            exec(cmd, (error) => {
              if (error) reject(error)
              else resolve()
            })
          })
        } else {
          await shell.openExternal(url)
        }
        return { success: true }
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : String(error)
        }
      }
    }
  )

  // Open a path in an external app (Cursor, Ghostty) or copy to clipboard
  ipcMain.handle('system:openInApp', async (_, appName: string, path: string) => {
    try {
      switch (appName) {
        case 'cursor':
          if (process.platform === 'darwin') {
            spawn('open', ['-a', 'Cursor', path], { detached: true, stdio: 'ignore' })
          } else if (process.platform === 'win32') {
            spawn('cmd', ['/c', 'start', '', 'cursor', path], {
              detached: true,
              stdio: 'ignore'
            })
          } else {
            spawn('cursor', [path], { detached: true, stdio: 'ignore' })
          }
          break
        case 'ghostty':
          if (process.platform === 'win32') {
            return { success: false, error: 'Ghostty is not available on Windows' }
          }
          if (process.platform === 'darwin') {
            spawn('open', ['-a', 'Ghostty', path], { detached: true, stdio: 'ignore' })
          } else {
            spawn('ghostty', ['--working-directory=' + path], { detached: true, stdio: 'ignore' })
          }
          break
        case 'android-studio':
          if (process.platform === 'darwin') {
            spawn('open', ['-a', 'Android Studio', path], { detached: true, stdio: 'ignore' })
          } else if (process.platform === 'win32') {
            spawn('cmd', ['/c', 'start', '', 'studio64.exe', path], {
              detached: true,
              stdio: 'ignore'
            })
          } else {
            spawn('studio', [path], { detached: true, stdio: 'ignore' })
          }
          break
        case 'copy-path':
          clipboard.writeText(path)
          break
        default:
          return { success: false, error: `Unknown app: ${appName}` }
      }
      return { success: true }
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to open in app'
      }
    }
  })

  // Detect which agent SDKs are installed on the system (first-launch setup)
  ipcMain.handle('system:detectAgentSdks', () => {
    return detectAgentSdks(openCodeLaunchSpec)
  })

  // Quit the app (needed for macOS where window.close() doesn't quit)
  ipcMain.handle('system:quitApp', () => {
    app.quit()
  })

  // Check if the app is running in packaged mode (not dev)
  ipcMain.handle('system:isPackaged', () => {
    return app.isPackaged
  })

  // Get the current platform (darwin, win32, linux)
  ipcMain.handle('system:getPlatform', () => {
    return process.platform
  })

  // Prevent display sleep while renderer-driven sessions are active.
  // The renderer owns the decision of when to hold the blocker; this handler
  // simply forwards the desired state to the idempotent service.
  ipcMain.handle('system:setKeepAwake', (_event, active: boolean) => {
    setKeepAwake(Boolean(active))
  })

  // Mirror renderer-side follow-up message queue state into the main process so
  // notification-service can suppress session-complete notifications while more
  // queued messages are about to be auto-sent.
  ipcMain.handle(
    'notification:setSessionQueuedState',
    (_event, sessionId: string, hasQueued: boolean) => {
      notificationService.setSessionQueuedState(sessionId, hasQueued)
    }
  )
}

// Register response logging IPC handlers (only when --log is active)
function registerLoggingHandlers(): void {
  ipcMain.handle('logging:createResponseLog', (_, sessionId: string) => {
    return createResponseLog(sessionId)
  })

  ipcMain.handle('logging:appendResponseLog', (_, filePath: string, data: unknown) => {
    appendResponseLog(filePath, data)
  })
}

// This method will be called when Electron has finished
// initialization and is ready to create browser windows.
// Some APIs can only be used after this event occurs.
app.whenReady().then(async () => {
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

  // Set app user model id for windows
  electronApp.setAppUserModelId('com.hive')

  // Initialize database
  log.info('Initializing database')
  getDatabase()

  // Initialize telemetry (must come after DB init since it reads/writes settings)
  telemetryService.init()

  // Register IPC handlers
  log.info('Registering IPC handlers')
  registerDatabaseHandlers()
  registerProjectHandlers()
  registerWorktreeHandlers()
  registerSystemHandlers(openCodeLaunchSpec)
  registerSettingsHandlers()
  registerFileHandlers()
  registerAttachmentHandlers()
  registerConnectionHandlers()
  registerUsageHandlers()
  registerAccountHandlers()
  registerKanbanHandlers()
  initTicketProviderManager([new GitHubProvider(), new JiraProvider()])
  registerTicketImportHandlers()

  // Telemetry IPC
  ipcMain.handle(
    'telemetry:track',
    (_event, eventName: string, properties?: Record<string, unknown>) => {
      telemetryService.track(eventName, properties)
    }
  )

  ipcMain.handle('telemetry:setEnabled', (_event, enabled: boolean) => {
    return telemetryService.setEnabled(enabled)
  })

  ipcMain.handle('telemetry:isEnabled', () => {
    return telemetryService.isEnabled()
  })

  // Performance diagnostics IPC
  ipcMain.handle('perf-diagnostics:enable', (_event, enabled: boolean) => {
    if (enabled) {
      perfDiagnostics.start()
    } else {
      perfDiagnostics.stop()
    }
  })

  ipcMain.handle('perf-diagnostics:snapshot', () => {
    return perfDiagnostics.getSnapshot()
  })

  // Codex debug logger IPC
  ipcMain.handle('codex-debug-logger:configure', (_event, enabled: boolean, resetPerSession: boolean) => {
    configureCodexDebugLogger({ enabled, resetPerSession })
  })

  // Register response logging handlers only when --log is active
  if (isLogMode) {
    log.info('Registering response logging handlers')
    registerLoggingHandlers()
  }

  log.info('Creating main window')
  createWindow()
  log.info('Main window created, waiting for renderer to load')

  // Register OpenCode handlers after window is created
  if (mainWindow) {
    // Build the full application menu (File, Edit, Session, Git, View, Window, Help)
    log.info('Building application menu')
    buildMenu(mainWindow, is.dev)

    // Register menu state update handler (renderer tells main which items to enable/disable)
    ipcMain.handle('menu:updateState', (_event, state: MenuState) => {
      updateMenuState(state)
    })

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
        supportsPartialStreaming: true
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
      renameSession: async () => {},
      setMainWindow: () => {}
    } satisfies AgentSdkImplementer
    const codexImpl = new CodexImplementer()
    codexImpl.setDatabaseService(getDatabase())
    codexImpl.setCodexBinaryPath(codexBinaryPath)
    setRouterCodexBinaryPath(codexBinaryPath)
    const sdkManager = new AgentSdkManager([openCodePlaceholder, claudeImpl, codexImpl])
    sdkManager.setMainWindow(mainWindow)

    const databaseService = getDatabase()

    log.info('Registering OpenCode handlers')
    registerOpenCodeHandlers(mainWindow, sdkManager, databaseService)
    log.info('Registering FileTree handlers')
    registerFileTreeHandlers(mainWindow)
    log.info('Registering GitFile handlers')
    registerGitFileHandlers(mainWindow)
    log.info('Registering Script handlers')
    registerScriptHandlers(mainWindow)
    log.info('Registering Bash handlers')
    registerBashHandlers(mainWindow)
    log.info('Registering Terminal handlers')
    registerTerminalHandlers(mainWindow)

    // Set up notification service with main window reference
    notificationService.setMainWindow(mainWindow)

    // Register updater IPC handlers and initialize auto-updater
    registerUpdaterHandlers()
    updaterService.init(mainWindow)

    // Wire up performance diagnostics collectors and auto-start if enabled
    perfDiagnostics.setCollectors({
      getPtyCount: () => ptyService.getCount(),
      getScriptStats: () => scriptRunner.getStats(),
      getFileWatcherCount: () => getFileTreeWatcherCount(),
      getWorktreeWatcherCount: () => getWorktreeWatcherCount(),
      getBranchWatcherCount: () => getBranchWatcherCount(),
      getActiveSessionCount: () => {
        try {
          return getDatabase().countActiveSessions()
        } catch {
          return -1
        }
      }
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
    // On macOS it's common to re-create a window in the app when the
    // dock icon is clicked and there are no other windows open.
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
}).catch((error) => {
  log.error('Fatal error during app startup', error instanceof Error ? error : new Error(String(error)))
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

// Cleanup when app is about to quit
app.on('will-quit', async () => {
  // Prevent further menu mutations — must be first to avoid native WeakPtr errors
  shutdownMenu()
  // Cleanup performance diagnostics
  perfDiagnostics.cleanup()
  // Cleanup updater timers
  updaterService.cleanup()
  // Cleanup terminal PTYs
  cleanupTerminals()
  // Cleanup running scripts
  cleanupScripts()
  // Cleanup running bash runs (best-effort, no await)
  bashService.killAll()
  // Release any held power save blocker so the display can sleep again
  cleanupPowerSaveBlocker()
  // Cleanup file tree watchers
  await cleanupFileTreeWatchers()
  // Cleanup worktree watchers (git status monitoring)
  await cleanupWorktreeWatchers()
  // Cleanup branch watchers (sidebar branch names)
  await cleanupBranchWatchers()
  // Cleanup OpenCode connections
  await cleanupOpenCode()
  // Flush telemetry before closing database
  telemetryService.track('app_session_ended', {
    session_duration_ms: Date.now() - appStartTime
  })
  await telemetryService.shutdown()
  // Close database
  closeDatabase()
})
