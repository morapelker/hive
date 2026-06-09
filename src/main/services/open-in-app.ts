import { spawn as spawnProcess } from 'child_process'
import type { OpenInAppResult } from '../../shared/desktop-command'

type SpawnProcess = (
  command: string,
  args: readonly string[],
  options: { readonly detached: true; readonly stdio: 'ignore' }
) => unknown

interface ClipboardWriter {
  readonly writeText: (text: string) => void
}

export interface OpenInAppDeps {
  readonly platform?: NodeJS.Platform
  readonly spawn?: SpawnProcess
  readonly clipboard?: ClipboardWriter
}

export const openInApp = async (
  appName: string,
  path: string,
  deps: OpenInAppDeps = {}
): Promise<OpenInAppResult> => {
  const platform = deps.platform ?? process.platform
  const spawn = deps.spawn ?? spawnProcess

  try {
    switch (appName) {
      case 'cursor':
        if (platform === 'darwin') {
          spawn('open', ['-a', 'Cursor', path], { detached: true, stdio: 'ignore' })
        } else if (platform === 'win32') {
          spawn('cmd', ['/c', 'start', '', 'cursor', path], {
            detached: true,
            stdio: 'ignore'
          })
        } else {
          spawn('cursor', [path], { detached: true, stdio: 'ignore' })
        }
        break
      case 'ghostty':
        if (platform === 'win32') {
          return { success: false, error: 'Ghostty is not available on Windows' }
        }
        if (platform === 'darwin') {
          spawn('open', ['-a', 'Ghostty', path], { detached: true, stdio: 'ignore' })
        } else {
          spawn('ghostty', ['--working-directory=' + path], { detached: true, stdio: 'ignore' })
        }
        break
      case 'android-studio':
        if (platform === 'darwin') {
          spawn('open', ['-a', 'Android Studio', path], { detached: true, stdio: 'ignore' })
        } else if (platform === 'win32') {
          spawn('cmd', ['/c', 'start', '', 'studio64.exe', path], {
            detached: true,
            stdio: 'ignore'
          })
        } else {
          spawn('studio', [path], { detached: true, stdio: 'ignore' })
        }
        break
      case 'copy-path':
        if (!deps.clipboard) {
          return { success: false, error: 'No clipboard writer is available' }
        }
        deps.clipboard.writeText(path)
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
}
