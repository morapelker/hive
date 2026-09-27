import { spawn as spawnProcess } from 'child_process'
import { closeSync, openSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import {
  MACOS_PRIVACY_PANES,
  type MacosPermissionStatus,
  type MacosPrivacyPane,
  type OpenMacosPrivacySettingsResult
} from '../../shared/system-types'

/**
 * macOS privacy (TCC) helpers for the folder-access prompts agent sessions
 * trigger: "Hive wants to access files in your Documents folder".
 *
 * Every claude / codex / terminal process is a descendant of the app bundle,
 * so macOS attributes its file access to Hive. Folder grants can persist,
 * but access to other apps' protected data resets when the app quits.
 * These grants cannot be enabled from code. Full Disk Access, which only the user
 * can flip in System Settings; these helpers report whether it is on and open
 * the right pane so they do not have to hunt for it.
 */

/**
 * Best-effort Full Disk Access probe. Use only TCC's own database: falling
 * back to Safari or Messages data can itself request access to another app's
 * data, and reading such a file does not prove a blanket Full Disk Access grant.
 * A missing/unreadable database is conservatively reported as not granted.
 */
const FULL_DISK_ACCESS_PROBE_PATHS: ReadonlyArray<ReadonlyArray<string>> = [
  ['Library', 'Application Support', 'com.apple.TCC', 'TCC.db']
]

/** Deep links into System Settings › Privacy & Security (Ventura and later). */
export const MACOS_PRIVACY_PANE_URLS: Readonly<Record<MacosPrivacyPane, string>> = {
  fullDiskAccess:
    'x-apple.systempreferences:com.apple.settings.PrivacySecurity.extension?Privacy_AllFiles',
  filesAndFolders:
    'x-apple.systempreferences:com.apple.settings.PrivacySecurity.extension?Privacy_FilesAndFolders'
}

type SpawnDetached = (
  command: string,
  args: readonly string[],
  options: { readonly detached: true; readonly stdio: 'ignore' }
) => { on?: (event: 'error', listener: (error: Error) => void) => unknown; unref?: () => void }

export interface MacosPermissionsDeps {
  readonly platform?: NodeJS.Platform
  readonly homeDirectory?: string
  /** Opens a file for reading and throws an errno error when it cannot. */
  readonly readProbe?: (path: string) => void
  readonly spawn?: SpawnDetached
}

const openForRead = (path: string): void => {
  closeSync(openSync(path, 'r'))
}

const isMissingPathError = (error: unknown): boolean => {
  const code = (error as NodeJS.ErrnoException | undefined)?.code
  return code === 'ENOENT' || code === 'ENOTDIR'
}

export const getFullDiskAccessProbePaths = (homeDirectory: string): string[] =>
  FULL_DISK_ACCESS_PROBE_PATHS.map((segments) => join(homeDirectory, ...segments))

/**
 * Whether this process (and so every session it spawns) has Full Disk Access.
 * Off macOS there is no such grant and the answer is always false.
 */
export function checkFullDiskAccess(deps: MacosPermissionsDeps = {}): boolean {
  if ((deps.platform ?? process.platform) !== 'darwin') return false
  const readProbe = deps.readProbe ?? openForRead
  for (const probePath of getFullDiskAccessProbePaths(deps.homeDirectory ?? homedir())) {
    try {
      readProbe(probePath)
      return true
    } catch (error) {
      if (isMissingPathError(error)) continue
      // EPERM is how a TCC denial surfaces; anything else unexpected is
      // treated the same way rather than reported as granted.
      return false
    }
  }
  return false
}

export function getMacosPermissionStatus(deps: MacosPermissionsDeps = {}): MacosPermissionStatus {
  const supported = (deps.platform ?? process.platform) === 'darwin'
  return {
    supported,
    fullDiskAccess: supported && checkFullDiskAccess(deps)
  }
}

/** Opens System Settings on the requested Privacy & Security pane. */
export function openMacosPrivacySettings(
  pane: MacosPrivacyPane,
  deps: MacosPermissionsDeps = {}
): OpenMacosPrivacySettingsResult {
  if ((deps.platform ?? process.platform) !== 'darwin') {
    return { success: false, error: 'System Settings privacy panes exist on macOS only' }
  }
  if (!MACOS_PRIVACY_PANES.includes(pane)) {
    return { success: false, error: `Unknown privacy pane: ${String(pane)}` }
  }
  const spawn: SpawnDetached = deps.spawn ?? spawnProcess
  try {
    const child = spawn('open', [MACOS_PRIVACY_PANE_URLS[pane]], {
      detached: true,
      stdio: 'ignore'
    })
    child.on?.('error', () => {})
    child.unref?.()
    return { success: true }
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) }
  }
}
