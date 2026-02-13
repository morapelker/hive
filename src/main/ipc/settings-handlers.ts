import { ipcMain } from 'electron'
import { existsSync } from 'fs'
import { execSync, spawn } from 'child_process'
import { platform } from 'os'
import { createLogger } from '../services'
import { getDatabase } from '../db'

const log = createLogger({ component: 'SettingsHandlers' })

interface DetectedApp {
  id: string
  name: string
  command: string
  available: boolean
}

function detectEditors(): DetectedApp[] {
  const currentPlatform = platform()
  const editors: DetectedApp[] = []

  const editorDefs = [
    {
      id: 'vscode',
      name: 'Visual Studio Code',
      commands:
        currentPlatform === 'darwin'
          ? [
              '/usr/local/bin/code',
              '/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code'
            ]
          : currentPlatform === 'win32'
            ? ['code.cmd', 'code']
            : ['code']
    },
    {
      id: 'cursor',
      name: 'Cursor',
      commands:
        currentPlatform === 'darwin'
          ? ['/usr/local/bin/cursor', '/Applications/Cursor.app/Contents/Resources/app/bin/cursor']
          : ['cursor']
    },
    {
      id: 'sublime',
      name: 'Sublime Text',
      commands:
        currentPlatform === 'darwin'
          ? [
              '/usr/local/bin/subl',
              '/Applications/Sublime Text.app/Contents/SharedSupport/bin/subl'
            ]
          : currentPlatform === 'win32'
            ? ['subl.exe']
            : ['subl']
    },
    {
      id: 'webstorm',
      name: 'WebStorm',
      commands:
        currentPlatform === 'darwin'
          ? ['/usr/local/bin/webstorm', '/Applications/WebStorm.app/Contents/MacOS/webstorm']
          : ['webstorm']
    },
    {
      id: 'zed',
      name: 'Zed',
      commands:
        currentPlatform === 'darwin'
          ? ['/usr/local/bin/zed', '/Applications/Zed.app/Contents/MacOS/zed']
          : ['zed']
    }
  ]

  for (const def of editorDefs) {
    let available = false
    let resolvedCommand = ''

    for (const cmd of def.commands) {
      if (existsSync(cmd)) {
        available = true
        resolvedCommand = cmd
        break
      }
      // Try which/where
      try {
        const result = execSync(currentPlatform === 'win32' ? `where ${cmd}` : `which ${cmd}`, {
          encoding: 'utf-8',
          timeout: 2000
        }).trim()
        if (result) {
          available = true
          resolvedCommand = result.split('\n')[0]
          break
        }
      } catch {
        // Not found
      }
    }

    editors.push({
      id: def.id,
      name: def.name,
      command: resolvedCommand || def.commands[0],
      available
    })
  }

  return editors
}

function detectTerminals(): DetectedApp[] {
  const currentPlatform = platform()
  const terminals: DetectedApp[] = []

  const terminalDefs =
    currentPlatform === 'darwin'
      ? [
          {
            id: 'terminal',
            name: 'Terminal',
            commands: ['/System/Applications/Utilities/Terminal.app']
          },
          { id: 'iterm', name: 'iTerm2', commands: ['/Applications/iTerm.app'] },
          { id: 'warp', name: 'Warp', commands: ['/Applications/Warp.app'] },
          {
            id: 'alacritty',
            name: 'Alacritty',
            commands: ['/Applications/Alacritty.app', '/usr/local/bin/alacritty']
          },
          {
            id: 'kitty',
            name: 'kitty',
            commands: ['/Applications/kitty.app', '/usr/local/bin/kitty']
          }
        ]
      : currentPlatform === 'win32'
        ? [
            { id: 'terminal', name: 'Windows Terminal', commands: ['wt.exe'] },
            { id: 'cmd', name: 'Command Prompt', commands: ['cmd.exe'] }
          ]
        : [
            { id: 'terminal', name: 'Default Terminal', commands: ['x-terminal-emulator'] },
            { id: 'alacritty', name: 'Alacritty', commands: ['alacritty'] },
            { id: 'kitty', name: 'kitty', commands: ['kitty'] }
          ]

  for (const def of terminalDefs) {
    let available = false
    let resolvedCommand = ''

    for (const cmd of def.commands) {
      if (existsSync(cmd)) {
        available = true
        resolvedCommand = cmd
        break
      }
      try {
        const result = execSync(currentPlatform === 'win32' ? `where ${cmd}` : `which ${cmd}`, {
          encoding: 'utf-8',
          timeout: 2000
        }).trim()
        if (result) {
          available = true
          resolvedCommand = result.split('\n')[0]
          break
        }
      } catch {
        // Not found
      }
    }

    terminals.push({
      id: def.id,
      name: def.name,
      command: resolvedCommand || def.commands[0],
      available
    })
  }

  return terminals
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
