import '@testing-library/jest-dom'
import { beforeEach, vi } from 'vitest'
import type { RendererRpcClient } from '../src/renderer/src/api/rpc-client'
import { setRendererRpcClient } from '../src/renderer/src/api/rpc-client'

const electronMock = vi.hoisted(() => {
  const makeWebContents = () => ({
    send: vi.fn(),
    on: vi.fn(),
    once: vi.fn(),
    off: vi.fn(),
    removeListener: vi.fn(),
    setWindowOpenHandler: vi.fn(),
    openDevTools: vi.fn()
  })
  const BrowserWindow = vi.fn(function MockBrowserWindow() {
    return {
      loadURL: vi.fn(),
      loadFile: vi.fn(),
      on: vi.fn(),
      once: vi.fn(),
      off: vi.fn(),
      show: vi.fn(),
      hide: vi.fn(),
      close: vi.fn(),
      destroy: vi.fn(),
      isDestroyed: vi.fn(() => false),
      isVisible: vi.fn(() => true),
      setAlwaysOnTop: vi.fn(),
      setVisibleOnAllWorkspaces: vi.fn(),
      setPosition: vi.fn(),
      getPosition: vi.fn(() => [0, 0]),
      getBounds: vi.fn(() => ({ x: 0, y: 0, width: 800, height: 600 })),
      webContents: makeWebContents()
    }
  })
  Object.assign(BrowserWindow, {
    getAllWindows: vi.fn(() => []),
    getFocusedWindow: vi.fn(() => null),
    fromWebContents: vi.fn(() => null)
  })

  return {
    app: {
      getPath: vi.fn((name: string) =>
        name === 'home' ? '/tmp/hive-test-mock-home' : `/tmp/hive-test-mock-${name}`
      ),
      getVersion: vi.fn(() => '1.1.10'),
      isPackaged: false,
      quit: vi.fn(),
      on: vi.fn(),
      once: vi.fn(),
      whenReady: vi.fn(() => Promise.resolve()),
      setAppUserModelId: vi.fn(),
      requestSingleInstanceLock: vi.fn(() => true)
    },
    BrowserWindow,
    clipboard: {
      readText: vi.fn(() => ''),
      writeText: vi.fn()
    },
    dialog: {
      showMessageBox: vi.fn(() => Promise.resolve({ response: 0 })),
      showOpenDialog: vi.fn(() => Promise.resolve({ canceled: true, filePaths: [] })),
      showSaveDialog: vi.fn(() => Promise.resolve({ canceled: true }))
    },
    ipcMain: {
      handle: vi.fn(),
      on: vi.fn(),
      removeHandler: vi.fn(),
      removeAllListeners: vi.fn()
    },
    nativeImage: {
      createFromPath: vi.fn(() => ({ resize: vi.fn(() => ({})) }))
    },
    Notification: vi.fn(),
    screen: {
      getPrimaryDisplay: vi.fn(() => ({ workArea: { x: 0, y: 0, width: 1920, height: 1080 } }))
    },
    session: {
      defaultSession: {
        webRequest: {
          onHeadersReceived: vi.fn()
        }
      }
    },
    shell: {
      openExternal: vi.fn(() => Promise.resolve()),
      openPath: vi.fn(() => Promise.resolve('')),
      showItemInFolder: vi.fn()
    }
  }
})

vi.mock('electron', () => electronMock)

vi.mock('@electron-toolkit/utils', () => ({
  electronApp: {
    setAppUserModelId: vi.fn(),
    setAutoLaunch: vi.fn()
  },
  is: {
    dev: true,
    macOS: false,
    windows: false,
    linux: true
  },
  optimizer: {
    watchWindowShortcuts: vi.fn()
  }
}))

vi.mock('electron-updater', () => ({
  autoUpdater: {
    autoDownload: false,
    autoInstallOnAppQuit: true,
    logger: null,
    channel: 'latest',
    allowPrerelease: false,
    allowDowngrade: false,
    on: vi.fn(),
    checkForUpdates: vi.fn(),
    downloadUpdate: vi.fn(),
    quitAndInstall: vi.fn()
  }
}))

const makeDefaultRendererRpcClient = (): RendererRpcClient => ({
  request: async <T,>(method: string): Promise<T> => {
    switch (method) {
      case 'db.setting.get':
      case 'db.project.get':
      case 'db.project.getByPath':
        return null as T
      case 'db.setting.set':
      case 'db.setting.delete':
      case 'db.project.delete':
      case 'db.project.touch':
        return true as T
      case 'db.setting.getAll':
      case 'db.project.getAll':
      case 'db.space.list':
        return [] as T
      case 'settingsOps.getAll':
        return {} as T
      case 'settingsOps.loadCustomCommandsFile':
        return { success: true, commands: [], mtime: null } as T
      case 'settingsOps.saveCustomCommandsFile':
        return { success: true, mtime: null } as T
      case 'projectOps.loadLanguageIcons':
        return {} as T
      default:
        return undefined as T
    }
  },
  subscribe: () => () => {}
})

const installDefaultRendererRpcClient = (): void => {
  setRendererRpcClient(makeDefaultRendererRpcClient())
}

if (typeof window !== 'undefined') {
  installDefaultRendererRpcClient()

  // Synchronous rAF mock — fires the callback immediately so that
  // RAF-throttled store updates behave synchronously in tests.
  let rafId = 0
  window.requestAnimationFrame = (cb: FrameRequestCallback): number => {
    cb(performance.now())
    return ++rafId
  }
  window.cancelAnimationFrame = vi.fn()

  // Mock matchMedia for theme detection
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: query === '(prefers-color-scheme: dark)',
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn()
    }))
  })

  if (typeof window.localStorage?.getItem !== 'function') {
    const storage = new Map<string, string>()
    Object.defineProperty(window, 'localStorage', {
      writable: true,
      configurable: true,
      value: {
        getItem: vi.fn((key: string) => storage.get(key) ?? null),
        setItem: vi.fn((key: string, value: string) => {
          storage.set(key, value)
        }),
        removeItem: vi.fn((key: string) => {
          storage.delete(key)
        }),
        clear: vi.fn(() => {
          storage.clear()
        })
      }
    })
  }

  beforeEach(() => {
    window.localStorage?.clear?.()
  })

}
