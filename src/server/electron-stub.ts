// Electron stub for the standalone Hive server build.
//
// The HTTP backend runs as a plain Node process (the Electron binary in
// ELECTRON_RUN_AS_NODE mode, or `node`), where the real `electron` module does
// not resolve. The server needs no Electron runtime — every genuine Electron
// operation (windows, dialogs, menus, open-in-app, version/isPackaged, ...) is
// proxied to the main process over the spawn's `ipc` channel via
// `requestDesktopCommand`. A handful of shared `src/main` modules still carry a
// top-level `import ... from 'electron'`, though, and those imports execute at
// module load and would crash the process.
//
// `electron.vite.server.config.ts` aliases `electron` to this file so those
// imports resolve. We provide electron-free equivalents for the few trivial,
// pure APIs the server can legitimately reach (`app.getPath`, `getVersion`,
// `isPackaged`), and throw loudly for anything that genuinely requires a live
// Electron runtime — such a call reaching the server is a bug, not a silent
// no-op.

import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

const unavailable = (api: string): never => {
  throw new Error(
    `electron.${api} is not available in the standalone Hive server process. ` +
      `Electron operations must be proxied to the main process via requestDesktopCommand.`
  )
}

const home = homedir()
const appData = process.env.APPDATA ?? join(home, '.config')

export const app = {
  getPath(name: string): string {
    switch (name) {
      case 'home':
        return home
      case 'temp':
        return tmpdir()
      case 'appData':
        return appData
      case 'userData':
      case 'sessionData':
        // Best-effort fallback. Server storage paths are driven by the
        // HIVE_SERVER_* env config, not by Electron's userData directory.
        return join(appData, app.getName())
      default:
        return home
    }
  },
  getName(): string {
    return process.env.HIVE_APP_NAME ?? 'hive'
  },
  getVersion(): string {
    return process.env.HIVE_APP_VERSION ?? process.env.npm_package_version ?? '0.0.0'
  },
  getAppPath(): string {
    return process.cwd()
  },
  get isPackaged(): boolean {
    return process.env.HIVE_APP_PACKAGED === 'true'
  }
}

// Anything below requires a live Electron runtime; reaching it in the server is
// a programming error. Export callable/constructable proxies so both
// `dialog.showOpenDialog(...)` and `new BrowserWindow(...)` fail with a clear
// message rather than an opaque "X is not a function/constructor".
const live = (name: string): never =>
  new Proxy(function () {} as unknown as () => never, {
    get: () => unavailable(name),
    apply: () => unavailable(name),
    construct: () => unavailable(name)
  }) as unknown as never

export const BrowserWindow = live('BrowserWindow')
export const Notification = live('Notification')
export const Menu = live('Menu')
export const dialog = live('dialog')
export const shell = live('shell')
export const clipboard = live('clipboard')
export const screen = live('screen')
export const webContents = live('webContents')
export const powerSaveBlocker = live('powerSaveBlocker')
export const contextBridge = live('contextBridge')
export const webFrame = live('webFrame')
export const webUtils = live('webUtils')

export default {
  app,
  BrowserWindow,
  Notification,
  Menu,
  dialog,
  shell,
  clipboard,
  screen,
  webContents,
  powerSaveBlocker,
  contextBridge,
  webFrame,
  webUtils
}
