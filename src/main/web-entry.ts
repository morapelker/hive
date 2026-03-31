/**
 * Web mode entry point - mocks Electron, then runs headless server.
 * Usage: node out/main/web-entry.js --web [--insecure] [--port 59999]
 */
import { homedir } from 'os'
import { join } from 'path'
import { existsSync, readFileSync } from 'fs'

// Get version from package.json
function getVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(join(__dirname, '..', '..', 'package.json'), 'utf-8'))
    return pkg.version
  } catch {
    return '0.0.0'
  }
}

// Mock electron module before anything imports it
const mockElectron = {
  app: {
    isPackaged: true,
    whenReady: () => Promise.resolve(),
    getPath: (name: string) => {
      const home = homedir()
      switch (name) {
        case 'userData': return join(home, '.hive')
        case 'home': return home
        case 'logs': return join(home, '.hive', 'logs')
        default: return join(home, '.hive')
      }
    },
    getAppPath: () => process.cwd(),
    getVersion: getVersion,
    getName: () => 'Hive',
    getLocale: () => 'en',
    quit: () => process.exit(0),
    on: () => {},
    once: () => {},
    dock: { setBadgeCount: () => {} },
    setBadgeCount: () => {}
  },
  BrowserWindow: class {
    static getAllWindows() { return [] }
    constructor() {}
    loadURL() {}
    loadFile() {}
    on() {}
    once() {}
    close() {}
    show() {}
    hide() {}
    minimize() {}
    maximize() {}
    isMaximized() { return false }
    getBounds() { return { x: 0, y: 0, width: 800, height: 600 } }
    webContents = {
      send: () => {},
      setWindowOpenHandler: () => {},
      on: () => {},
      executeJavaScript: () => Promise.resolve()
    }
  },
  shell: {
    openExternal: () => Promise.resolve(),
    openPath: () => Promise.resolve(''),
    trashItem: () => Promise.resolve({ success: true })
  },
  screen: {
    getAllDisplays: () => [],
    getPrimaryDisplay: () => ({ bounds: { x: 0, y: 0, width: 1920, height: 1080 } })
  },
  ipcMain: {
    handle: () => {},
    on: () => {},
    removeHandler: () => {}
  },
  clipboard: {
    writeText: () => {},
    readText: () => ''
  },
  Notification: class {
    static isSupported() { return false }
    constructor() {}
    on() {}
    show() {}
  },
  Menu: {
    buildFromTemplate: () => ({ popup: () => {} }),
    setApplicationMenu: () => {},
    getApplicationMenu: () => null
  },
  dialog: {
    showOpenDialog: () => Promise.resolve({ canceled: false, filePaths: [] }),
    showSaveDialog: () => Promise.resolve({ canceled: false, filePath: '' }),
    showMessageBox: () => Promise.resolve({ response: 0 })
  }
}

// Inject mock into require cache
const electronPath = require.resolve('electron')
require.cache[electronPath] = {
  id: electronPath,
  filename: electronPath,
  loaded: true,
  exports: mockElectron
} as NodeModule

// Mock @electron-toolkit/utils
try {
  const utilsPath = require.resolve('@electron-toolkit/utils')
  require.cache[utilsPath] = {
    id: utilsPath,
    filename: utilsPath,
    loaded: true,
    exports: {
      electronApp: { setAppUserModelId: () => {} },
      is: { dev: false, Packaged: true }
    }
  } as NodeModule
} catch {}

// Parse CLI args
const cliArgs = process.argv.slice(2)
const port = cliArgs.includes('--port') ? parseInt(cliArgs[cliArgs.indexOf('--port') + 1]) : undefined
const bind = cliArgs.includes('--bind') ? cliArgs[cliArgs.indexOf('--bind') + 1] : undefined
const insecure = cliArgs.includes('--insecure')
const isRotateKey = cliArgs.includes('--rotate-key')
const isRegenCerts = cliArgs.includes('--regen-certs')
const isShowStatus = cliArgs.includes('--show-status')
const isKill = cliArgs.includes('--kill')
const isUnlock = cliArgs.includes('--unlock')

async function main(): Promise<void> {
  const { headlessBootstrap, handleManagementCommand } = await import('../server/headless-bootstrap')

  // Handle one-shot management commands
  if (isRotateKey || isRegenCerts || isShowStatus || isKill || isUnlock) {
    await handleManagementCommand({
      rotateKey: isRotateKey,
      regenCerts: isRegenCerts,
      showStatus: isShowStatus,
      kill: isKill,
      unlock: isUnlock
    })
    process.exit(0)
    return
  }

  console.log('Starting Hive in web mode...')
  await headlessBootstrap({ port, bind, insecure })

  process.on('SIGTERM', () => {
    console.log('Shutting down web server')
    process.exit(0)
  })
  process.on('SIGINT', () => {
    console.log('Shutting down web server')
    process.exit(0)
  })
}

main().catch((err) => {
  console.error('Failed to start web mode:', err)
  process.exit(1)
})
