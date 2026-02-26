import { ipcMain } from 'electron'
import { existsSync } from 'fs'
import { spawn } from 'child_process'
import { platform } from 'os'
import { createLogger } from '../services'
import { telemetryService } from '../services/telemetry-service'
import { getDatabase } from '../db'
import { detectEditors, detectTerminals, type DetectedApp } from '../services/settings-detection'

const log = createLogger({ component: 'SettingsHandlers' })

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

  // Open a path with a specific editor command
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

        let command: string
        if (editorId === 'custom' && customCommand) {
          command = customCommand
        } else {
          const editors = detectEditors()
          const editor = editors.find((e) => e.id === editorId)
          if (!editor?.available) {
            return { success: false, error: `Editor ${editorId} not found` }
          }
          command = editor.command
        }

        spawn(command, [worktreePath], { detached: true, stdio: 'ignore' })
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
