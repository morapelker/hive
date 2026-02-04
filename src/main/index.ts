import { app, shell, BrowserWindow, screen, ipcMain } from 'electron'
import { join } from 'path'
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import { getDatabase, closeDatabase } from './db'
import { registerDatabaseHandlers, registerProjectHandlers, registerWorktreeHandlers, registerOpenCodeHandlers, cleanupOpenCode, registerFileTreeHandlers, cleanupFileTreeWatchers } from './ipc'
import { createLogger, getLogDir } from './services/logger'

const log = createLogger({ component: 'Main' })

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
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 15, y: 10 },
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

  // Save window bounds on resize and move
  mainWindow.on('resize', () => saveWindowBounds(mainWindow))
  mainWindow.on('move', () => saveWindowBounds(mainWindow))
  mainWindow.on('close', () => saveWindowBounds(mainWindow))

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
}

// This method will be called when Electron has finished
// initialization and is ready to create browser windows.
// Some APIs can only be used after this event occurs.
app.whenReady().then(() => {
  log.info('App starting', { version: app.getVersion(), platform: process.platform })

  // Set app user model id for windows
  electronApp.setAppUserModelId('com.hive')

  // Initialize database
  log.info('Initializing database')
  getDatabase()

  // Register IPC handlers
  log.info('Registering IPC handlers')
  registerDatabaseHandlers()
  registerProjectHandlers()
  registerWorktreeHandlers()
  registerSystemHandlers()

  // Default open or close DevTools by F12 in development
  // and ignore CommandOrControl + R in production.
  // see https://github.com/alex8088/electron-toolkit/tree/master/packages/utils
  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  createWindow()

  // Register OpenCode handlers after window is created
  if (mainWindow) {
    log.info('Registering OpenCode handlers')
    registerOpenCodeHandlers(mainWindow)
    log.info('Registering FileTree handlers')
    registerFileTreeHandlers(mainWindow)
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
  // Cleanup file tree watchers
  await cleanupFileTreeWatchers()
  // Cleanup OpenCode connections
  await cleanupOpenCode()
  // Close database
  closeDatabase()
})
