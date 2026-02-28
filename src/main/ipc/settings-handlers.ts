import { ipcMain } from 'electron'
import { existsSync } from 'fs'
import { spawn } from 'child_process'
import { platform } from 'os'
import { createLogger } from '../services'
import { telemetryService } from '../services/telemetry-service'
import { getDatabase } from '../db'
import { detectEditors, detectTerminals, type DetectedApp } from '../services/settings-detection'
import { APP_SETTINGS_DB_KEY } from '@shared/types/settings'

const log = createLogger({ component: 'SettingsHandlers' })

function resolveEditorCommand(
  editorId: string,
  customCommand?: string
): { command: string } | { error: string } {
  if (editorId === 'custom' && customCommand) {
    return { command: customCommand }
  }
  const editors = detectEditors()
  const editor = editors.find((e) => e.id === editorId)
  if (!editor?.available) {
    return { error: `Editor ${editorId} not found` }
  }
  return { command: editor.command }
}

/**
 * Open a path with the user's preferred editor (reads defaultEditor and customEditorCommand from DB).
 * Used by worktree, connection, and git "Open in Editor" handlers.
 */
export function openPathWithPreferredEditor(
  path: string
): Promise<{ success: boolean; error?: string }> {
  if (!existsSync(path)) {
    return Promise.resolve({ success: false, error: 'Path does not exist' })
  }
  let editorId = 'vscode'
  let customCommand = ''
  try {
    const raw = getDatabase().getSetting(APP_SETTINGS_DB_KEY)
    if (raw) {
      const settings = JSON.parse(raw) as { defaultEditor?: string; customEditorCommand?: string }
      if (settings.defaultEditor) editorId = settings.defaultEditor
      if (settings.customEditorCommand != null) customCommand = settings.customEditorCommand
    }
  } catch {
    // Use defaults
  }
  const resolved = resolveEditorCommand(editorId, customCommand || undefined)
  if ('error' in resolved) {
    return Promise.resolve({ success: false, error: resolved.error })
  }
  try {
    spawn(resolved.command, [path], { detached: true, stdio: 'ignore' })
    return Promise.resolve({ success: true })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error'
    return Promise.resolve({ success: false, error: message })
  }
}

export function registerSettingsHandlers(): void {
  log.info('Registering settings handlers')

  // Detect installed editors
  ipcMain.handle('settings:detectEditors', async (): Promise<DetectedApp[]> => {
    try {
      return detectEditors()
    } catch (error) {
      log.error(
        'Failed to detect editors',
        error instanceof Error ? error : new Error(String(error))
      )
      return []
    }
  })

  // Detect installed terminals
  ipcMain.handle('settings:detectTerminals', async (): Promise<DetectedApp[]> => {
    try {
      return detectTerminals()
    } catch (error) {
      log.error(
        'Failed to detect terminals',
        error instanceof Error ? error : new Error(String(error))
      )
      return []
    }
  })

  // Open a path with a specific editor command (explicit editorId/customCommand from renderer)
  ipcMain.handle(
    'settings:openWithEditor',
    async (
      _event,
      worktreePath: string,
      editorId: string,
      customCommand?: string
    ): Promise<{ success: boolean; error?: string }> => {
      try {
        if (!existsSync(worktreePath)) {
          return { success: false, error: 'Path does not exist' }
        }
        const resolved = resolveEditorCommand(editorId, customCommand)
        if ('error' in resolved) {
          return { success: false, error: resolved.error }
        }
        // spawn(resolved.command, [worktreePath], { detached: true, stdio: 'ignore' })
        //   command = editor.command

        spawn(resolved.command, [worktreePath], { detached: true, stdio: 'ignore' })
        telemetryService.track('worktree_opened_in_editor')
        return { success: true }
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error'
        return { success: false, error: message }
      }
    }
  )

  // Open a path with a specific terminal
  ipcMain.handle(
    'settings:openWithTerminal',
    async (
      _event,
      worktreePath: string,
      terminalId: string,
      customCommand?: string
    ): Promise<{ success: boolean; error?: string }> => {
      try {
        if (!existsSync(worktreePath)) {
          return { success: false, error: 'Path does not exist' }
        }

        const currentPlatform = platform()

        if (terminalId === 'custom' && customCommand) {
          spawn(customCommand, [worktreePath], { detached: true, stdio: 'ignore' })
          return { success: true }
        }

        if (currentPlatform === 'darwin') {
          switch (terminalId) {
            case 'terminal':
              spawn('open', ['-a', 'Terminal', worktreePath], { detached: true })
              break
            case 'iterm':
              spawn('open', ['-a', 'iTerm', worktreePath], { detached: true })
              break
            case 'warp':
              spawn('open', ['-a', 'Warp', worktreePath], { detached: true })
              break
            case 'alacritty':
              spawn('alacritty', ['--working-directory', worktreePath], {
                detached: true,
                stdio: 'ignore'
              })
              break
            case 'kitty':
              spawn('kitty', ['--directory', worktreePath], { detached: true, stdio: 'ignore' })
              break
            case 'ghostty':
              spawn('open', ['-a', 'Ghostty', worktreePath], { detached: true })
              break
            default:
              spawn('open', ['-a', 'Terminal', worktreePath], { detached: true })
          }
        } else {
          // Fallback for other platforms
          const terminals = detectTerminals()
          const terminal = terminals.find((t) => t.id === terminalId)
          if (terminal?.available) {
            spawn(terminal.command, [], { cwd: worktreePath, detached: true, stdio: 'ignore' })
          } else {
            return { success: false, error: 'Terminal not found' }
          }
        }

        return { success: true }
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error'
        return { success: false, error: message }
      }
    }
  )

  // Get all settings as a batch
  ipcMain.handle('settings:getAll', async (): Promise<Record<string, string>> => {
    try {
      const db = getDatabase()
      const allSettings = db.getAllSettings()
      const result: Record<string, string> = {}
      for (const setting of allSettings) {
        result[setting.key] = setting.value
      }
      return result
    } catch (error) {
      log.error(
        'Failed to get all settings',
        error instanceof Error ? error : new Error(String(error))
      )
      return {}
    }
  })
}
