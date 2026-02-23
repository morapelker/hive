import { existsSync } from 'fs'
import { execSync } from 'child_process'
import { platform } from 'os'

export interface DetectedApp {
  id: string
  name: string
  command: string
  available: boolean
}

export function detectEditors(): DetectedApp[] {
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

export function detectTerminals(): DetectedApp[] {
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
          },
          {
            id: 'ghostty',
            name: 'Ghostty',
            commands: ['/Applications/Ghostty.app', '/usr/local/bin/ghostty']
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
