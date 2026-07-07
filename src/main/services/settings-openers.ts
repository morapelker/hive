import { spawn } from 'child_process'
import { existsSync } from 'fs'
import { platform } from 'os'

import { getDatabase } from '../db'
import { APP_SETTINGS_DB_KEY } from '@shared/types/settings'
import { detectEditors, detectTerminals } from './settings-detection'
import { createLogger } from './logger'
import { telemetryService } from './telemetry-service'

const log = createLogger({ component: 'SettingsOpeners' })

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

/** Fire-and-forget spawn: suppress errors and fully detach from parent event loop. */
function spawnDetached(...args: Parameters<typeof spawn>): void {
  const child = spawn(...args)
  child.on('error', () => {})
  child.unref()
}

function launchTerminal(
  targetPath: string,
  terminalId: string,
  customCommand?: string
): { success: boolean; error?: string } {
  const currentPlatform = platform()

  if (terminalId === 'custom' && customCommand) {
    spawnDetached(customCommand, [targetPath], { detached: true, stdio: 'ignore' })
    return { success: true }
  }

  if (currentPlatform === 'darwin') {
    switch (terminalId) {
      case 'terminal':
        spawnDetached('open', ['-a', 'Terminal', targetPath], { detached: true })
        break
      case 'iterm':
        spawnDetached('open', ['-a', 'iTerm', targetPath], { detached: true })
        break
      case 'warp':
        spawnDetached('open', ['-a', 'Warp', targetPath], { detached: true })
        break
      case 'alacritty':
        spawnDetached('alacritty', ['--working-directory', targetPath], {
          detached: true,
          stdio: 'ignore'
        })
        break
      case 'kitty':
        spawnDetached('kitty', ['--directory', targetPath], { detached: true, stdio: 'ignore' })
        break
      case 'ghostty':
        spawnDetached('open', ['-a', 'Ghostty', targetPath], { detached: true })
        break
      case 'cmux':
        spawnDetached('open', ['-a', 'cmux', targetPath], { detached: true })
        break
      default:
        spawnDetached('open', ['-a', 'Terminal', targetPath], { detached: true })
    }
  } else if (currentPlatform === 'win32') {
    switch (terminalId) {
      case 'terminal': {
        const terminals = detectTerminals()
        const wt = terminals.find((t) => t.id === 'terminal')
        if (wt?.available) {
          spawnDetached('wt.exe', ['-d', targetPath], { detached: true, stdio: 'ignore' })
        } else {
          spawnDetached(
            'powershell.exe',
            ['-NoExit', '-Command', `Set-Location '${targetPath.replace(/'/g, "''")}'`],
            {
              detached: true,
              stdio: 'ignore'
            }
          )
        }
        break
      }
      case 'powershell':
        spawnDetached(
          'powershell.exe',
          ['-NoExit', '-Command', `Set-Location '${targetPath.replace(/'/g, "''")}'`],
          {
            detached: true,
            stdio: 'ignore'
          }
        )
        break
      case 'cmd':
        spawnDetached('cmd.exe', ['/k', `cd /d "${targetPath}"`], {
          detached: true,
          stdio: 'ignore'
        })
        break
      default: {
        const terminals = detectTerminals()
        const terminal = terminals.find((t) => t.id === terminalId)
        if (terminal?.available) {
          spawnDetached(terminal.command, [], { cwd: targetPath, detached: true, stdio: 'ignore' })
        } else {
          return { success: false, error: 'Terminal not found' }
        }
      }
    }
  } else {
    const terminals = detectTerminals()
    const terminal = terminals.find((t) => t.id === terminalId)
    if (terminal?.available) {
      spawnDetached(terminal.command, [], { cwd: targetPath, detached: true, stdio: 'ignore' })
    } else {
      return { success: false, error: 'Terminal not found' }
    }
  }

  return { success: true }
}

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

export function openPathWithPreferredTerminal(
  path: string
): Promise<{ success: boolean; error?: string }> {
  if (!existsSync(path)) {
    return Promise.resolve({ success: false, error: 'Path does not exist' })
  }
  let terminalId = 'terminal'
  let customCommand = ''
  try {
    const raw = getDatabase().getSetting(APP_SETTINGS_DB_KEY)
    if (raw) {
      const settings = JSON.parse(raw) as {
        defaultTerminal?: string
        customTerminalCommand?: string
      }
      if (settings.defaultTerminal) terminalId = settings.defaultTerminal
      if (settings.customTerminalCommand != null) customCommand = settings.customTerminalCommand
    }
  } catch {
    // Use defaults
  }
  try {
    return Promise.resolve(launchTerminal(path, terminalId, customCommand || undefined))
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error'
    return Promise.resolve({ success: false, error: message })
  }
}

export function openPathWithEditor(
  worktreePath: string,
  editorId: string,
  customCommand?: string
): { success: boolean; error?: string } {
  if (!existsSync(worktreePath)) {
    return { success: false, error: 'Path does not exist' }
  }
  const resolved = resolveEditorCommand(editorId, customCommand)
  if ('error' in resolved) {
    return { success: false, error: resolved.error }
  }

  spawn(resolved.command, [worktreePath], { detached: true, stdio: 'ignore' })
  telemetryService.track('worktree_opened_in_editor')
  return { success: true }
}

export function openPathWithTerminal(
  worktreePath: string,
  terminalId: string,
  customCommand?: string
): { success: boolean; error?: string } {
  if (!existsSync(worktreePath)) {
    return { success: false, error: 'Path does not exist' }
  }
  return launchTerminal(worktreePath, terminalId, customCommand)
}

export function getAllSettingsMap(): Record<string, string> {
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
}
