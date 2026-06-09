import { describe, expect, it } from 'vitest'
import fs from 'fs'
import path from 'path'

const readOptionalSource = (root: string, relativePath: string): string => {
  const absolutePath = path.join(root, relativePath)
  return fs.existsSync(absolutePath) ? fs.readFileSync(absolutePath, 'utf-8') : ''
}

describe('final migrated IPC handler deletion', () => {
  it('keeps the migrated business IPC handler tree deleted', () => {
    const root = process.cwd()
    const mainIpcPath = path.join(root, 'src/main/ipc')
    const mainSource = fs.readFileSync(path.join(root, 'src/main/index.ts'), 'utf-8')
    const serverSource = fs.readFileSync(path.join(root, 'src/server/server.ts'), 'utf-8')
    const backendManagerSource = fs.readFileSync(
      path.join(root, 'src/main/desktop/backend-manager.ts'),
      'utf-8'
    )

    expect(fs.existsSync(mainIpcPath)).toBe(false)
    expect(mainSource).not.toContain("from './ipc")
    expect(mainSource).not.toContain('registerAllHandlers')
    expect(serverSource).not.toContain('main/ipc')
    expect(backendManagerSource).not.toContain('../ipc')
  })
})

describe('migrated shared IPC helper', () => {
  it('removes the old defineHandler ipcMain bridge and runtime', () => {
    const root = process.cwd()

    expect(fs.existsSync(path.join(root, 'src/main/ipc/_shared/define-handler.ts'))).toBe(false)
    expect(fs.existsSync(path.join(root, 'src/main/ipc/_shared/ipc-runtime.ts'))).toBe(false)
    expect(
      fs.existsSync(path.join(root, 'src/main/ipc/_shared/__tests__/define-handler.test.ts'))
    ).toBe(false)
  })
})

describe('migrated file IPC handlers', () => {
  it('removes the old empty file handler registrar from startup', () => {
    const root = process.cwd()
    const mainSource = fs.readFileSync(path.join(root, 'src/main/index.ts'), 'utf-8')
    const ipcIndexSource = readOptionalSource(root, 'src/main/ipc/index.ts')

    expect(fs.existsSync(path.join(root, 'src/main/ipc/file-handlers.ts'))).toBe(false)
    expect(mainSource).not.toContain('registerFileHandlers')
    expect(ipcIndexSource).not.toContain('registerFileHandlers')
    expect(ipcIndexSource).not.toContain('./file-handlers')
  })
})

describe('migrated attachment IPC handlers', () => {
  it('removes the old empty attachment handler registrar from startup', () => {
    const root = process.cwd()
    const mainSource = fs.readFileSync(path.join(root, 'src/main/index.ts'), 'utf-8')
    const ipcIndexSource = readOptionalSource(root, 'src/main/ipc/index.ts')

    expect(fs.existsSync(path.join(root, 'src/main/ipc/attachment-handlers.ts'))).toBe(false)
    expect(mainSource).not.toContain('registerAttachmentHandlers')
    expect(ipcIndexSource).not.toContain('registerAttachmentHandlers')
    expect(ipcIndexSource).not.toContain('./attachment-handlers')
  })
})

describe('migrated pet IPC handlers', () => {
  it('removes the old empty pet handler registrar from startup', () => {
    const root = process.cwd()
    const mainSource = fs.readFileSync(path.join(root, 'src/main/index.ts'), 'utf-8')
    const ipcIndexSource = readOptionalSource(root, 'src/main/ipc/index.ts')

    expect(fs.existsSync(path.join(root, 'src/main/ipc/pet-handlers.ts'))).toBe(false)
    expect(mainSource).not.toContain('registerPetHandlers')
    expect(ipcIndexSource).not.toContain('registerPetHandlers')
    expect(ipcIndexSource).not.toContain('./pet-handlers')
  })
})

describe('migrated updater IPC handlers', () => {
  it('removes the old empty updater handler registrar from startup', () => {
    const root = process.cwd()
    const mainSource = fs.readFileSync(path.join(root, 'src/main/index.ts'), 'utf-8')
    const ipcIndexSource = readOptionalSource(root, 'src/main/ipc/index.ts')

    expect(fs.existsSync(path.join(root, 'src/main/ipc/updater-handlers.ts'))).toBe(false)
    expect(mainSource).not.toContain('registerUpdaterHandlers')
    expect(ipcIndexSource).not.toContain('registerUpdaterHandlers')
    expect(ipcIndexSource).not.toContain('./updater-handlers')
  })
})

describe('migrated telegram IPC handlers', () => {
  it('removes the old empty telegram handler registrar from startup', () => {
    const root = process.cwd()
    const mainSource = fs.readFileSync(path.join(root, 'src/main/index.ts'), 'utf-8')
    const ipcIndexSource = readOptionalSource(root, 'src/main/ipc/index.ts')

    expect(fs.existsSync(path.join(root, 'src/main/ipc/telegram-handlers.ts'))).toBe(false)
    expect(mainSource).not.toContain('registerTelegramHandlers')
    expect(ipcIndexSource).not.toContain('registerTelegramHandlers')
    expect(ipcIndexSource).not.toContain('./telegram-handlers')
  })
})

describe('migrated account IPC handlers', () => {
  it('removes the old empty account handler registrar from startup', () => {
    const root = process.cwd()
    const mainSource = fs.readFileSync(path.join(root, 'src/main/index.ts'), 'utf-8')
    const ipcIndexSource = readOptionalSource(root, 'src/main/ipc/index.ts')

    expect(fs.existsSync(path.join(root, 'src/main/ipc/account-handlers.ts'))).toBe(false)
    expect(mainSource).not.toContain('registerAccountHandlers')
    expect(ipcIndexSource).not.toContain('registerAccountHandlers')
    expect(ipcIndexSource).not.toContain('./account-handlers')
  })
})

describe('migrated connection IPC handlers', () => {
  it('removes the old empty connection handler registrar from startup', () => {
    const root = process.cwd()
    const mainSource = fs.readFileSync(path.join(root, 'src/main/index.ts'), 'utf-8')
    const ipcIndexSource = readOptionalSource(root, 'src/main/ipc/index.ts')

    expect(fs.existsSync(path.join(root, 'src/main/ipc/connection-handlers.ts'))).toBe(false)
    expect(mainSource).not.toContain('registerConnectionHandlers')
    expect(ipcIndexSource).not.toContain('registerConnectionHandlers')
    expect(ipcIndexSource).not.toContain('./connection-handlers')
  })
})

describe('migrated usage IPC handlers', () => {
  it('removes the old empty usage handler registrar from startup', () => {
    const root = process.cwd()
    const mainSource = fs.readFileSync(path.join(root, 'src/main/index.ts'), 'utf-8')
    const ipcIndexSource = readOptionalSource(root, 'src/main/ipc/index.ts')

    expect(fs.existsSync(path.join(root, 'src/main/ipc/usage-handlers.ts'))).toBe(false)
    expect(mainSource).not.toContain('registerUsageHandlers')
    expect(ipcIndexSource).not.toContain('registerUsageHandlers')
    expect(ipcIndexSource).not.toContain('./usage-handlers')
  })
})

describe('migrated project IPC handlers', () => {
  it('removes the old empty project handler registrar from startup', () => {
    const root = process.cwd()
    const mainSource = fs.readFileSync(path.join(root, 'src/main/index.ts'), 'utf-8')
    const ipcIndexSource = readOptionalSource(root, 'src/main/ipc/index.ts')

    expect(fs.existsSync(path.join(root, 'src/main/ipc/project-handlers.ts'))).toBe(false)
    expect(mainSource).not.toContain('registerProjectHandlers')
    expect(ipcIndexSource).not.toContain('registerProjectHandlers')
    expect(ipcIndexSource).not.toContain('./project-handlers')
  })
})

describe('migrated worktree IPC handlers', () => {
  it('removes the old empty worktree handler registrar from startup', () => {
    const root = process.cwd()
    const mainSource = fs.readFileSync(path.join(root, 'src/main/index.ts'), 'utf-8')
    const ipcIndexSource = readOptionalSource(root, 'src/main/ipc/index.ts')

    expect(fs.existsSync(path.join(root, 'src/main/ipc/worktree-handlers.ts'))).toBe(false)
    expect(mainSource).not.toContain('registerWorktreeHandlers')
    expect(ipcIndexSource).not.toContain('registerWorktreeHandlers')
    expect(ipcIndexSource).not.toContain('./worktree-handlers')
  })
})

describe('migrated database IPC handlers', () => {
  it('removes the old empty database handler registrar from startup', () => {
    const root = process.cwd()
    const mainSource = fs.readFileSync(path.join(root, 'src/main/index.ts'), 'utf-8')
    const ipcIndexSource = readOptionalSource(root, 'src/main/ipc/index.ts')

    expect(fs.existsSync(path.join(root, 'src/main/ipc/database-handlers.ts'))).toBe(false)
    expect(mainSource).not.toContain('registerDatabaseHandlers')
    expect(ipcIndexSource).not.toContain('registerDatabaseHandlers')
    expect(ipcIndexSource).not.toContain('./database-handlers')
  })
})

describe('migrated kanban IPC handlers', () => {
  it('removes the old empty kanban handler registrar from startup', () => {
    const root = process.cwd()
    const mainSource = fs.readFileSync(path.join(root, 'src/main/index.ts'), 'utf-8')
    const ipcIndexSource = readOptionalSource(root, 'src/main/ipc/index.ts')

    expect(fs.existsSync(path.join(root, 'src/main/ipc/kanban-handlers.ts'))).toBe(false)
    expect(mainSource).not.toContain('registerKanbanHandlers')
    expect(ipcIndexSource).not.toContain('registerKanbanHandlers')
    expect(ipcIndexSource).not.toContain('./kanban-handlers')
  })
})

describe('migrated ticket import IPC handlers', () => {
  it('removes the old empty ticket import handler registrar from startup', () => {
    const root = process.cwd()
    const mainSource = fs.readFileSync(path.join(root, 'src/main/index.ts'), 'utf-8')

    expect(fs.existsSync(path.join(root, 'src/main/ipc/ticket-import-handlers.ts'))).toBe(false)
    expect(mainSource).not.toContain('registerTicketImportHandlers')
    expect(mainSource).not.toContain('./ipc/ticket-import-handlers')
  })
})

describe('migrated system IPC handlers', () => {
  it('removes the old empty system handler registrar from startup', () => {
    const root = process.cwd()
    const mainSource = fs.readFileSync(path.join(root, 'src/main/index.ts'), 'utf-8')

    expect(mainSource).not.toContain('function registerSystemHandlers')
    expect(mainSource).not.toContain('registerSystemHandlers()')
    expect(mainSource).not.toContain('Notification queued-state IPC handlers migrated to RPC')
  })
})

describe('migrated response logging IPC handlers', () => {
  it('removes the old empty response logging handler registrar from startup', () => {
    const root = process.cwd()
    const mainSource = fs.readFileSync(path.join(root, 'src/main/index.ts'), 'utf-8')

    expect(mainSource).not.toContain('function registerLoggingHandlers')
    expect(mainSource).not.toContain('registerLoggingHandlers()')
    expect(mainSource).not.toContain('Response logging IPC handlers migrated to RPC')
    expect(mainSource).not.toContain('Registering response logging handlers')
  })
})

describe('migrated settings IPC handlers', () => {
  it('removes the old settings handler registrar while moving desktop openers out of ipc', () => {
    const root = process.cwd()
    const mainSource = fs.readFileSync(path.join(root, 'src/main/index.ts'), 'utf-8')
    const backendManagerSource = fs.readFileSync(
      path.join(root, 'src/main/desktop/backend-manager.ts'),
      'utf-8'
    )
    const ipcIndexSource = readOptionalSource(root, 'src/main/ipc/index.ts')
    const settingsOpenersSource = fs.readFileSync(
      path.join(root, 'src/main/services/settings-openers.ts'),
      'utf-8'
    )
    const settingsRpcSource = fs.readFileSync(
      path.join(root, 'src/server/rpc/domains/settings-ops.ts'),
      'utf-8'
    )
    const worktreeRpcSource = fs.readFileSync(
      path.join(root, 'src/server/rpc/domains/worktree-ops.ts'),
      'utf-8'
    )
    const connectionRpcSource = fs.readFileSync(
      path.join(root, 'src/server/rpc/domains/connection-ops.ts'),
      'utf-8'
    )
    const gitRpcSource = fs.readFileSync(
      path.join(root, 'src/server/rpc/domains/git-ops.ts'),
      'utf-8'
    )

    expect(fs.existsSync(path.join(root, 'src/main/ipc/settings-handlers.ts'))).toBe(false)
    expect(settingsOpenersSource).toContain('export function openPathWithEditor')
    expect(settingsOpenersSource).toContain('export function openPathWithTerminal')
    expect(settingsOpenersSource).toContain('export function getAllSettingsMap')
    expect(backendManagerSource).toContain("from '../services/settings-openers'")
    expect(backendManagerSource).not.toContain("from '../ipc/settings-handlers'")
    for (const source of [
      settingsRpcSource,
      worktreeRpcSource,
      connectionRpcSource,
      gitRpcSource
    ]) {
      expect(source).toContain('main/services/settings-openers')
      expect(source).not.toContain('main/ipc/settings-handlers')
    }
    expect(mainSource).not.toContain('registerSettingsHandlers')
    expect(ipcIndexSource).not.toContain('registerSettingsHandlers')
    expect(ipcIndexSource).not.toContain('settings-handlers')
  })
})

describe('migrated file tree IPC handlers', () => {
  it('removes the old empty file tree handler registrar while moving watchers out of ipc', () => {
    const root = process.cwd()
    const mainSource = fs.readFileSync(path.join(root, 'src/main/index.ts'), 'utf-8')
    const ipcIndexSource = readOptionalSource(root, 'src/main/ipc/index.ts')
    const backendManagerSource = fs.readFileSync(
      path.join(root, 'src/main/desktop/backend-manager.ts'),
      'utf-8'
    )
    const fileTreeWatcherSource = fs.readFileSync(
      path.join(root, 'src/main/services/file-tree-watcher.ts'),
      'utf-8'
    )
    const fileTreeRpcSource = fs.readFileSync(
      path.join(root, 'src/server/rpc/domains/file-tree-ops.ts'),
      'utf-8'
    )

    expect(fs.existsSync(path.join(root, 'src/main/ipc/file-tree-handlers.ts'))).toBe(false)
    expect(fileTreeWatcherSource).toContain('export function startFileTreeWatcher')
    expect(fileTreeWatcherSource).toContain('export async function stopFileTreeWatcher')
    expect(fileTreeWatcherSource).toContain('export async function cleanupFileTreeWatchers')
    expect(fileTreeWatcherSource).toContain('export function getFileTreeWatcherCount')
    expect(mainSource).toContain("from './services/file-tree-watcher'")
    expect(backendManagerSource).toContain("from '../services/file-tree-watcher'")
    expect(backendManagerSource).not.toContain("from '../ipc/file-tree-handlers'")
    expect(fileTreeRpcSource).toContain('main/services/file-tree-watcher')
    expect(fileTreeRpcSource).not.toContain('main/ipc/file-tree-handlers')
    expect(mainSource).not.toContain('registerFileTreeHandlers')
    expect(mainSource).not.toContain('Registering FileTree handlers')
    expect(ipcIndexSource).not.toContain('registerFileTreeHandlers')
    expect(ipcIndexSource).not.toContain('file-tree-handlers')
  })
})

describe('migrated terminal IPC handlers', () => {
  it('removes the old terminal handler registrar while moving PTY bridge helpers out of ipc', () => {
    const root = process.cwd()
    const mainSource = fs.readFileSync(path.join(root, 'src/main/index.ts'), 'utf-8')
    const ipcIndexSource = readOptionalSource(root, 'src/main/ipc/index.ts')
    const backendManagerSource = fs.readFileSync(
      path.join(root, 'src/main/desktop/backend-manager.ts'),
      'utf-8'
    )
    const terminalBridgeSource = fs.readFileSync(
      path.join(root, 'src/main/services/terminal-pty-bridge.ts'),
      'utf-8'
    )

    expect(fs.existsSync(path.join(root, 'src/main/ipc/terminal-handlers.ts'))).toBe(false)
    expect(terminalBridgeSource).toContain('export async function createClaudeCliTerminal')
    expect(terminalBridgeSource).toContain('export function destroyNodePtyTerminal')
    expect(terminalBridgeSource).toContain('export function cleanupTerminals')
    expect(mainSource).toContain("from './services/terminal-pty-bridge'")
    expect(backendManagerSource).toContain("from '../services/terminal-pty-bridge'")
    expect(backendManagerSource).not.toContain("from '../ipc/terminal-handlers'")
    expect(mainSource).not.toContain('registerTerminalHandlers')
    expect(ipcIndexSource).not.toContain('registerTerminalHandlers')
    expect(ipcIndexSource).not.toContain('terminal-handlers')
  })
})

describe('migrated bash IPC handlers', () => {
  it('removes the old bash handler registrar and BrowserWindow event sink wiring', () => {
    const root = process.cwd()
    const mainSource = fs.readFileSync(path.join(root, 'src/main/index.ts'), 'utf-8')
    const bashRuntimeSource = fs.readFileSync(
      path.join(root, 'src/main/effect/bash/runtime.ts'),
      'utf-8'
    )
    const bashLayersSource = fs.readFileSync(
      path.join(root, 'src/main/effect/bash/layers.ts'),
      'utf-8'
    )

    expect(fs.existsSync(path.join(root, 'src/main/ipc/bash-handlers.ts'))).toBe(false)
    expect(mainSource).not.toContain('registerBashHandlers')
    expect(mainSource).not.toContain('Registering Bash handlers')
    expect(bashRuntimeSource).not.toContain('setMainWindow')
    expect(bashRuntimeSource).not.toContain('BrowserWindow')
    expect(bashLayersSource).not.toContain('BrowserWindow')
  })
})

describe('migrated script IPC handlers', () => {
  it('removes the old script handler registrar while keeping cleanup exports', () => {
    const root = process.cwd()
    const mainSource = fs.readFileSync(path.join(root, 'src/main/index.ts'), 'utf-8')
    const ipcIndexSource = readOptionalSource(root, 'src/main/ipc/index.ts')
    const scriptRunnerSource = fs.readFileSync(
      path.join(root, 'src/main/services/script-runner.ts'),
      'utf-8'
    )
    const scriptCleanupSource = fs.readFileSync(
      path.join(root, 'src/main/services/script-cleanup.ts'),
      'utf-8'
    )

    expect(fs.existsSync(path.join(root, 'src/main/ipc/script-handlers.ts'))).toBe(false)
    expect(scriptCleanupSource).toContain('export function cleanupScripts')
    expect(mainSource).toContain("from './services/script-cleanup'")
    expect(scriptRunnerSource).not.toContain('setMainWindow')
    expect(scriptRunnerSource).not.toContain('BrowserWindow')
    expect(mainSource).not.toContain('registerScriptHandlers')
    expect(mainSource).not.toContain('Registering Script handlers')
    expect(ipcIndexSource).not.toContain('registerScriptHandlers')
    expect(ipcIndexSource).not.toContain('script-handlers')
  })
})

describe('migrated git watcher IPC handlers', () => {
  it('removes the old git watcher registrar and BrowserWindow watcher wiring', () => {
    const root = process.cwd()
    const mainSource = fs.readFileSync(path.join(root, 'src/main/index.ts'), 'utf-8')
    const ipcIndexSource = readOptionalSource(root, 'src/main/ipc/index.ts')
    const worktreeWatcherSource = fs.readFileSync(
      path.join(root, 'src/main/services/worktree-watcher.ts'),
      'utf-8'
    )
    const branchWatcherSource = fs.readFileSync(
      path.join(root, 'src/main/services/branch-watcher.ts'),
      'utf-8'
    )
    const serverSource = fs.readFileSync(path.join(root, 'src/server/server.ts'), 'utf-8')

    expect(fs.existsSync(path.join(root, 'src/main/ipc/git-file-handlers.ts'))).toBe(false)
    expect(worktreeWatcherSource).not.toContain('initWorktreeWatcher')
    expect(worktreeWatcherSource).not.toContain('BrowserWindow')
    expect(worktreeWatcherSource).not.toContain('mainWindow')
    expect(branchWatcherSource).not.toContain('initBranchWatcher')
    expect(branchWatcherSource).not.toContain('BrowserWindow')
    expect(branchWatcherSource).not.toContain('mainWindow')
    expect(mainSource).not.toContain("from './services/worktree-watcher'")
    expect(mainSource).not.toContain("from './services/branch-watcher'")
    expect(serverSource).toContain("from '../main/services/worktree-watcher'")
    expect(serverSource).toContain("from '../main/services/branch-watcher'")
    expect(serverSource).toContain('await cleanupWorktreeWatchers()')
    expect(serverSource).toContain('await cleanupBranchWatchers()')
    expect(mainSource).not.toContain('registerGitFileHandlers')
    expect(mainSource).not.toContain('Registering GitFile handlers')
    expect(ipcIndexSource).not.toContain('registerGitFileHandlers')
    expect(ipcIndexSource).not.toContain('git-file-handlers')
  })
})

describe('migrated OpenCode IPC helpers', () => {
  it('moves OpenCode desktop command helpers out of the IPC barrel', () => {
    const root = process.cwd()
    const mainSource = fs.readFileSync(path.join(root, 'src/main/index.ts'), 'utf-8')
    const ipcIndexSource = readOptionalSource(root, 'src/main/ipc/index.ts')
    const opencodeCommandsSource = fs.readFileSync(
      path.join(root, 'src/main/services/opencode-session-commands.ts'),
      'utf-8'
    )

    expect(fs.existsSync(path.join(root, 'src/main/ipc/opencode-handlers.ts'))).toBe(false)
    expect(opencodeCommandsSource).toContain('export async function connectOpenCodeSession')
    expect(opencodeCommandsSource).toContain('export async function cleanupOpenCode')
    expect(opencodeCommandsSource).not.toContain('IPC: opencode')
    expect(mainSource).toContain("from './services/opencode-session-commands'")
    expect(mainSource).not.toContain("from './ipc'")
    expect(ipcIndexSource).not.toContain('opencode-handlers')
    expect(ipcIndexSource).not.toContain('connectOpenCodeSession')
  })
})
