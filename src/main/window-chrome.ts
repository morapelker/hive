import { app, BrowserWindow, ipcMain, screen } from 'electron'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import type { IpcMainInvokeEvent } from 'electron'

const TRANSPARENT_TITLE_BAR_OVERLAY = '#00000000'
const HEADER_HEIGHT = 48
const DEFAULT_SYMBOL_COLOR = '#fafafa'

interface WindowBounds {
  x: number
  y: number
  width: number
  height: number
  isMaximized?: boolean
}

type MainWindowGetter = () => BrowserWindow | null

const boundsFile = (): string => join(app.getPath('userData'), 'window-bounds.json')

function withMainWindow(
  getMainWindow: MainWindowGetter,
  event: IpcMainInvokeEvent,
  run: (window: BrowserWindow) => void
): void {
  const window = getMainWindow()
  if (!window || window.isDestroyed() || event.sender !== window.webContents) return
  run(window)
}

export function loadWindowBounds(): WindowBounds | null {
  try {
    const file = boundsFile()
    if (existsSync(file)) {
      const raw: unknown = JSON.parse(readFileSync(file, 'utf-8'))
      if (typeof raw !== 'object' || raw === null) return null
      const o = raw as Record<string, unknown>
      const { x, y, width, height } = o
      if (
        typeof x !== 'number' ||
        !Number.isFinite(x) ||
        typeof y !== 'number' ||
        !Number.isFinite(y) ||
        typeof width !== 'number' ||
        !Number.isFinite(width) ||
        width < 0 ||
        typeof height !== 'number' ||
        !Number.isFinite(height) ||
        height < 0
      ) {
        return null
      }
      // ponytail: rebuild after checks — kills `as WindowBounds`
      const bounds: WindowBounds = {
        x,
        y,
        width,
        height,
        ...(typeof o.isMaximized === 'boolean' ? { isMaximized: o.isMaximized } : {})
      }
      const displays = screen.getAllDisplays()
      const isOnScreen = displays.some((display) => {
        const { x: dx, y: dy, width: dw, height: dh } = display.bounds
        return (
          bounds.x >= dx &&
          bounds.y >= dy &&
          bounds.x + bounds.width <= dx + dw &&
          bounds.y + bounds.height <= dy + dh
        )
      })
      if (isOnScreen) return bounds
    }
  } catch {
    // Ignore errors, use defaults
  }
  return null
}

function saveWindowBounds(window: BrowserWindow): void {
  if (window.isDestroyed()) return
  try {
    const bounds = window.isMaximized() ? window.getNormalBounds() : window.getBounds()
    const isMaximized = window.isMaximized()
    const dir = app.getPath('userData')
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true })
    }
    writeFileSync(boundsFile(), JSON.stringify({ ...bounds, isMaximized }))
  } catch {
    // Ignore save errors
  }
}

export function getMainWindowChromeOptions(): Electron.BrowserWindowConstructorOptions {
  if (process.platform === 'darwin') {
    return {
      titleBarStyle: 'hiddenInset',
      trafficLightPosition: { x: 15, y: 10 }
    }
  }
  if (process.platform === 'win32') {
    return {
      titleBarStyle: 'hidden',
      titleBarOverlay: {
        color: TRANSPARENT_TITLE_BAR_OVERLAY,
        symbolColor: DEFAULT_SYMBOL_COLOR,
        height: HEADER_HEIGHT
      }
    }
  }
  return { frame: false }
}

export function registerWindowChromeHandlers(getMainWindow: MainWindowGetter): void {
  if (process.platform !== 'darwin') {
    ipcMain.handle('window:close', (event) => {
      withMainWindow(getMainWindow, event, (window) => {
        window.close()
      })
    })
  }

  if (process.platform === 'linux') {
    ipcMain.handle('window:minimize', (event) => {
      withMainWindow(getMainWindow, event, (window) => {
        window.minimize()
      })
    })
    ipcMain.handle('window:maximize', (event) => {
      withMainWindow(getMainWindow, event, (window) => {
        if (window.isMaximized()) {
          window.unmaximize()
        } else {
          window.maximize()
        }
      })
    })
    ipcMain.handle('window:isMaximized', (event) => {
      const window = getMainWindow()
      if (!window || window.isDestroyed() || event.sender !== window.webContents) return false
      return window.isMaximized()
    })
  }

  if (process.platform === 'win32') {
    ipcMain.handle(
      'window:setTitleBarOverlay',
      (event, options: { color: string; symbolColor: string }) => {
        withMainWindow(getMainWindow, event, (window) => {
          window.setTitleBarOverlay({
            color: options.color || TRANSPARENT_TITLE_BAR_OVERLAY,
            symbolColor: options.symbolColor,
            height: HEADER_HEIGHT
          })
        })
      }
    )
  }
}

export function wireWindowChromeEvents(window: BrowserWindow): void {
  const emitMaximizedChanged = (): void => {
    if (window.isDestroyed()) return
    window.webContents.send('window:maximized-changed', window.isMaximized())
  }

  let saveTimer: ReturnType<typeof setTimeout> | null = null
  const scheduleSave = (): void => {
    if (saveTimer) clearTimeout(saveTimer)
    saveTimer = setTimeout(() => {
      saveTimer = null
      saveWindowBounds(window)
    }, 250)
  }

  window.on('maximize', emitMaximizedChanged)
  window.on('unmaximize', emitMaximizedChanged)
  window.on('resize', scheduleSave)
  window.on('move', scheduleSave)
  window.on('close', () => {
    if (saveTimer) clearTimeout(saveTimer)
    saveTimer = null
    saveWindowBounds(window)
  })
}
