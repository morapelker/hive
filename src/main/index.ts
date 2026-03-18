import { loadShellEnv } from './services/shell-env'
import { app, shell, BrowserWindow, screen, ipcMain, clipboard } from 'electron'
import { join } from 'path'
import { spawn, exec } from 'child_process'
import { promisify } from 'util'
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
  registerGitFileHandlers,
  cleanupWorktreeWatchers,
  cleanupBranchWatchers,
  registerSettingsHandlers,
  registerFileHandlers,
  registerScriptHandlers,
  cleanupScripts,
  registerTerminalHandlers,
  cleanupTerminals,
  registerUpdaterHandlers,
  registerConnectionHandlers,
  registerUsageHandlers
} from './ipc'
import { buildMenu, updateMenuState } from './menu'
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
import type { AgentSdkImplementer } from './services/agent-sdk-types'
import { telemetryService } from './services/telemetry-service'

const log = createLogger({ component: 'Main' })

const appStartTime = Date.now()

// Parse CLI flags
const cliArgs = process.argv.slice(2)
const isLogMode = cliArgs.includes('--log')
const isHeadless = cliArgs.includes('--headless')
const headlessPort = cliArgs.includes('--port')
  ? parseInt(cliArgs[cliArgs.indexOf('--port') + 1])
  : undefined
const headlessBind = cliArgs.includes('--bind') ? cliArgs[cliArgs.indexOf('--bind') + 1] : undefined
const isRotateKey = cliArgs.includes('--rotate-key')
const isRegenCerts = cliArgs.includes('--regen-certs')
const isShowStatus = cliArgs.includes('--show-status')
const isKill = cliArgs.includes('--kill')
const isUnlock = cliArgs.includes('--unlock')

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

  mainWindow.on('ready-to-show', () => {
    mainWindow.show()
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
  })

  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  // HMR for renderer based on electron-vite cli.
  // Load the remote URL for development or the local html file for production.
  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

// Register system IPC handlers
function registerSystemHandlers(): void {
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
          spawn('open', ['-a', 'Ghostty', path], { detached: true, stdio: 'ignore' })
          break
        case 'android-studio':
          spawn('open', ['-a', 'Android Studio', path], { detached: true, stdio: 'ignore' })
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
    return detectAgentSdks()
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

  // Install hive-server shell wrapper to PATH
  ipcMain.handle('system:installServerToPath', async () => {
    const execAsync = promisify(exec)
    const execPath = process.execPath

    if (process.platform === 'win32') {
      try {
        const installDir = join(process.env.LOCALAPPDATA || join(app.getPath('home'), 'AppData', 'Local'), 'Hive')
        mkdirSync(installDir, { recursive: true })
        const targetPath = join(installDir, 'hive-server.cmd')
        const scriptContent = `@echo off\r\n"${execPath}" --headless %*\r\n`
        writeFileSync(targetPath, scriptContent)

        // Add to user PATH via PowerShell (escape single quotes for safe interpolation)
        const escapedDir = installDir.replace(/'/g, "''")
        const psCmd = `$d='${escapedDir}'; [Environment]::SetEnvironmentVariable('Path', [Environment]::GetEnvironmentVariable('Path','User')+';'+$d,'User')`
        await execAsync(`powershell -Command "${psCmd}"`, { timeout: 15000 })

        return { success: true, path: targetPath }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        return { success: false, error: message }
      }
    }

    // macOS / Linux
    const targetPath = '/usr/local/bin/hive-server'
    try {
      const scriptContent =
        [
          '#!/bin/bash',
          '# hive-server — Hive headless mode launcher',
          '# Installed by Hive.app',
          `exec "${execPath}" --headless "$@"`
        ].join('\n') + '\n'

      // Write to a temp file first (no admin needed), then move with elevation
      const tmpPath = join(app.getPath('temp'), 'hive-server-install')
      writeFileSync(tmpPath, scriptContent, { mode: 0o755 })

      const osascript = `do shell script "mv '${tmpPath}' '${targetPath}' && chmod +x '${targetPath}'" with administrator privileges`
      await execAsync(`osascript -e '${osascript}'`, { timeout: 30000 })

      return { success: true, path: targetPath }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (message.includes('User canceled') || message.includes('-128')) {
        return { success: false, error: 'Installation cancelled' }
      }
      return { success: false, error: message }
    }
  })

  // Uninstall hive-server from PATH
  ipcMain.handle('system:uninstallServerFromPath', async () => {
    const execAsync = promisify(exec)

    if (process.platform === 'win32') {
      try {
        const installDir = join(process.env.LOCALAPPDATA || join(app.getPath('home'), 'AppData', 'Local'), 'Hive')
        const targetPath = join(installDir, 'hive-server.cmd')
        if (!existsSync(targetPath)) {
          return { success: false, error: 'hive-server is not installed' }
        }

        const { unlinkSync } = await import('fs')
        unlinkSync(targetPath)

        // Remove from user PATH via PowerShell (escape single quotes for safe interpolation)
        const escapedDir = installDir.replace(/'/g, "''")
        const psCmd = `$d='${escapedDir}'; $p = [Environment]::GetEnvironmentVariable('Path','User'); [Environment]::SetEnvironmentVariable('Path', ($p -split ';' | Where-Object { $_ -ne $d }) -join ';','User')`
        await execAsync(`powershell -Command "${psCmd}"`, { timeout: 15000 })

        return { success: true }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        return { success: false, error: message }
      }
    }

    // macOS / Linux
    const targetPath = '/usr/local/bin/hive-server'
    try {
      if (!existsSync(targetPath)) {
        return { success: false, error: 'hive-server is not installed' }
      }

      const osascript = `do shell script "rm '${targetPath}'" with administrator privileges`
      await execAsync(`osascript -e '${osascript}'`, { timeout: 30000 })

      return { success: true }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (message.includes('User canceled') || message.includes('-128')) {
        return { success: false, error: 'Uninstall cancelled' }
      }
      return { success: false, error: message }
    }
  })
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

  log.info('App starting', {
    version: app.getVersion(),
    platform: process.platform,
    claudeBinary: claudeBinaryPath ?? 'not found'
  })

  if (isLogMode) {
    log.info('Response logging enabled via --log flag')
  }

  // Set app user model id for windows
  electronApp.setAppUserModelId('com.hive')

  // --- Headless mode ---
  if (isHeadless) {
    log.info('Starting in headless mode')

    // Handle one-shot management commands
    if (isRotateKey || isRegenCerts || isShowStatus || isKill || isUnlock) {
      const { handleManagementCommand } = await import('../server/headless-bootstrap')
      await handleManagementCommand({
        rotateKey: isRotateKey,
        regenCerts: isRegenCerts,
        showStatus: isShowStatus,
        kill: isKill,
        unlock: isUnlock
      })
      app.quit()
      return
    }

    // Normal headless startup
    const { headlessBootstrap } = await import('../server/headless-bootstrap')
    await headlessBootstrap({ port: headlessPort, bind: headlessBind })
    return
  }
  // --- End headless mode ---

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
  registerSystemHandlers()
  registerSettingsHandlers()
  registerFileHandlers()
  registerConnectionHandlers()
  registerUsageHandlers()

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

  // Register response logging handlers only when --log is active
  if (isLogMode) {
    log.info('Registering response logging handlers')
    registerLoggingHandlers()
  }

  createWindow()

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
    log.info('Registering Terminal handlers')
    registerTerminalHandlers(mainWindow)

    // Set up notification service with main window reference
    notificationService.setMainWindow(mainWindow)

    // Register updater IPC handlers and initialize auto-updater
    registerUpdaterHandlers()
    updaterService.init(mainWindow)

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
  // Cleanup updater timers
  updaterService.cleanup()
  // Cleanup terminal PTYs
  cleanupTerminals()
  // Cleanup running scripts
  cleanupScripts()
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
