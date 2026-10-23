// Electron-main side of the data-project desktop commands (the server child asks over the
// private IPC pipe; see shared/desktop-command.ts and main/services/data-projects/secrets.ts,
// desktop-dialogs.ts):
//
//   dataSecretAvailable  → { available }   safeStorage usable (after app ready)
//   dataSecretEncrypt    → { ciphertext }  `v1:` + base64(safeStorage.encryptString(json))
//   dataSecretDecrypt    → { plaintext }   the reverse; refuses anything without the prefix
//   dataSaveFileDialog   → { filePath }    export target (null = cancelled / headless)
//   dataOpenFileDialog   → { filePath }    SQLite file, TLS certificate/key, SSH private key
//
// safeStorage binds the ciphertext to this app's Keychain item ("<app> Safe Storage"), so a
// copied database or a re-signed build cannot read it; the server then marks the project's
// credentials 'unavailable' and asks again — it never falls back to plaintext. Error texts
// sent back are fixed strings: neither a plaintext nor a ciphertext ever appears in a message
// or a log line.

import { app, BrowserWindow, dialog, safeStorage } from 'electron'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import {
  DATA_SECRET_CIPHERTEXT_PREFIX,
  type DataFileDialogResult,
  type DataOpenFileDialogPayload,
  type DataSaveFileDialogPayload,
  type DataSecretAvailableResult,
  type DataSecretDecryptResult,
  type DataSecretEncryptResult,
  type DesktopCommandRequest
} from '../../shared/desktop-command'

type DataProjectDesktopCommandRequest = Extract<
  DesktopCommandRequest,
  {
    readonly command:
      | 'dataSecretAvailable'
      | 'dataSecretEncrypt'
      | 'dataSecretDecrypt'
      | 'dataSaveFileDialog'
      | 'dataOpenFileDialog'
  }
>

const DATA_PROJECT_COMMANDS: ReadonlySet<string> = new Set([
  'dataSecretAvailable',
  'dataSecretEncrypt',
  'dataSecretDecrypt',
  'dataSaveFileDialog',
  'dataOpenFileDialog'
])

export const isDataProjectDesktopCommand = (
  request: DesktopCommandRequest
): request is DataProjectDesktopCommandRequest => DATA_PROJECT_COMMANDS.has(request.command)

interface SafeStorageLike {
  isEncryptionAvailable(): boolean
  encryptString(plainText: string): Buffer
  decryptString(encrypted: Buffer): string
}

interface DialogParent {
  isDestroyed(): boolean
  isVisible(): boolean
  getBounds(): { width: number; height: number }
}

interface DialogLike {
  showSaveDialog(...args: unknown[]): Promise<{ canceled: boolean; filePath?: string }>
  showOpenDialog(...args: unknown[]): Promise<{ canceled: boolean; filePaths: string[] }>
}

export interface DataProjectCommandDeps {
  readonly whenReady: () => Promise<void>
  readonly isReady: () => boolean
  readonly safeStorage: () => SafeStorageLike | undefined
  readonly dialog: DialogLike
  /** The window the dialog sheets onto (null = free-floating dialog). */
  readonly parentWindow: () => DialogParent | null
  readonly downloadsDir: () => string
  readonly homeDir: () => string
}

/**
 * The focused window, else the largest visible one: the main window (the pet and voice HUD
 * windows are small), so a dialog opened while focus sits elsewhere still sheets onto it.
 */
const defaultParentWindow = (): DialogParent | null => {
  const focused = BrowserWindow.getFocusedWindow()
  if (focused && !focused.isDestroyed()) return focused
  let best: DialogParent | null = null
  let bestArea = -1
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed() || !win.isVisible()) continue
    const { width, height } = win.getBounds()
    if (width * height > bestArea) {
      best = win
      bestArea = width * height
    }
  }
  return best
}

const defaultDeps = (): DataProjectCommandDeps => ({
  whenReady: () => app.whenReady().then(() => undefined),
  isReady: () => app.isReady(),
  safeStorage: () => safeStorage as SafeStorageLike | undefined,
  dialog: dialog as unknown as DialogLike,
  parentWindow: defaultParentWindow,
  downloadsDir: () => {
    try {
      return app.getPath('downloads')
    } catch {
      return join(homedir(), 'Downloads')
    }
  },
  homeDir: () => {
    try {
      return app.getPath('home')
    } catch {
      return homedir()
    }
  }
})

const VAULT_UNAVAILABLE = 'Secure storage (safeStorage) is not available on this system'

const usableSafeStorage = (deps: DataProjectCommandDeps): SafeStorageLike => {
  const storage = deps.safeStorage()
  if (!storage || !storage.isEncryptionAvailable()) throw new Error(VAULT_UNAVAILABLE)
  return storage
}

const ALL_FILES = { name: 'All Files', extensions: ['*'] }
const SQLITE_FILTER = { name: 'SQLite Database', extensions: ['db', 'sqlite', 'sqlite3', 'db3'] }
const CERTIFICATE_FILTER = {
  name: 'Certificates and Keys',
  extensions: ['pem', 'crt', 'cer', 'key', 'der', 'p12', 'pfx']
}

const showSave = async (deps: DataProjectCommandDeps, options: object): Promise<string | null> => {
  const parent = deps.parentWindow()
  const result = await (parent
    ? deps.dialog.showSaveDialog(parent, options)
    : deps.dialog.showSaveDialog(options))
  return result.canceled || !result.filePath ? null : result.filePath
}

const showOpen = async (deps: DataProjectCommandDeps, options: object): Promise<string | null> => {
  const parent = deps.parentWindow()
  const result = await (parent
    ? deps.dialog.showOpenDialog(parent, options)
    : deps.dialog.showOpenDialog(options))
  return result.canceled || result.filePaths.length === 0 ? null : result.filePaths[0]
}

const runSaveDialog = async (
  deps: DataProjectCommandDeps,
  payload: DataSaveFileDialogPayload
): Promise<DataFileDialogResult> => {
  // The name comes from the renderer: keep only a file name, never a path.
  const defaultName = basename(payload.defaultName.trim()) || 'export'
  const extensions = payload.extensions.filter((ext) => ext.length > 0)
  const options = {
    title: 'Export',
    defaultPath: join(deps.downloadsDir(), defaultName),
    filters:
      extensions.length > 0
        ? [{ name: extensions.map((ext) => ext.toUpperCase()).join(', '), extensions }, ALL_FILES]
        : [ALL_FILES],
    properties: ['createDirectory', 'showOverwriteConfirmation']
  }
  return { filePath: await showSave(deps, options) }
}

const runOpenDialog = async (
  deps: DataProjectCommandDeps,
  payload: DataOpenFileDialogPayload
): Promise<DataFileDialogResult> => {
  if (payload.purpose === 'sqlite' && payload.allowCreate) {
    // A new database file: a save dialog picks the name; the driver creates the file on open.
    const options = {
      title: 'New SQLite Database',
      buttonLabel: 'Create',
      defaultPath: join(deps.homeDir(), 'database.sqlite'),
      filters: [SQLITE_FILTER, ALL_FILES],
      properties: ['createDirectory', 'showOverwriteConfirmation']
    }
    return { filePath: await showSave(deps, options) }
  }

  const options =
    payload.purpose === 'sqlite'
      ? {
          title: 'Open SQLite Database',
          buttonLabel: 'Open',
          filters: [SQLITE_FILTER, ALL_FILES],
          properties: ['openFile']
        }
      : payload.purpose === 'certificate'
        ? {
            title: 'Select Certificate or Key',
            buttonLabel: 'Select',
            filters: [CERTIFICATE_FILTER, ALL_FILES],
            properties: ['openFile', 'showHiddenFiles']
          }
        : {
            // id_rsa / id_ed25519 have no extension: no filter, start in ~/.ssh.
            title: 'Select SSH Private Key',
            buttonLabel: 'Select',
            defaultPath: join(deps.homeDir(), '.ssh'),
            filters: [ALL_FILES],
            properties: ['openFile', 'showHiddenFiles']
          }
  return { filePath: await showOpen(deps, options) }
}

/**
 * Runs one data-project command and resolves its result value (the caller wraps it in a
 * DesktopCommandResult). Rejections carry fixed, secret-free messages.
 */
export const runDataProjectDesktopCommand = async (
  request: DataProjectDesktopCommandRequest,
  options: { readonly headless?: boolean } = {},
  deps: DataProjectCommandDeps = defaultDeps()
): Promise<
  | DataSecretAvailableResult
  | DataSecretEncryptResult
  | DataSecretDecryptResult
  | DataFileDialogResult
> => {
  switch (request.command) {
    case 'dataSecretAvailable': {
      if (!deps.isReady()) return { available: false }
      const storage = deps.safeStorage()
      return { available: Boolean(storage?.isEncryptionAvailable()) }
    }
    case 'dataSecretEncrypt': {
      // safeStorage needs the app to be ready (macOS reads the Keychain key lazily).
      await deps.whenReady()
      const storage = usableSafeStorage(deps)
      let encrypted: Buffer
      try {
        encrypted = storage.encryptString(request.payload.plaintext)
      } catch {
        throw new Error('Could not encrypt the secret with safeStorage')
      }
      return { ciphertext: `${DATA_SECRET_CIPHERTEXT_PREFIX}${encrypted.toString('base64')}` }
    }
    case 'dataSecretDecrypt': {
      await deps.whenReady()
      const storage = usableSafeStorage(deps)
      const body = request.payload.ciphertext.slice(DATA_SECRET_CIPHERTEXT_PREFIX.length)
      if (!request.payload.ciphertext.startsWith(DATA_SECRET_CIPHERTEXT_PREFIX) || !body) {
        throw new Error('Unsupported secret format')
      }
      try {
        return { plaintext: storage.decryptString(Buffer.from(body, 'base64')) }
      } catch {
        // Keychain item reset, re-signed build, or a database copied from another Mac.
        throw new Error('The stored secret could not be decrypted on this machine')
      }
    }
    case 'dataSaveFileDialog':
      if (options.headless) return { filePath: null }
      return runSaveDialog(deps, request.payload)
    case 'dataOpenFileDialog':
      if (options.headless) return { filePath: null }
      return runOpenDialog(deps, request.payload)
  }
}
