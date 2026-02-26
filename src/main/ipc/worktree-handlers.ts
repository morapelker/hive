import { ipcMain, shell } from 'electron'
import { spawn } from 'child_process'
import { existsSync } from 'fs'
import { platform } from 'os'
import { createGitService, createLogger } from '../services'
import { telemetryService } from '../services/telemetry-service'
import {
  createWorktreeOp,
  deleteWorktreeOp,
  syncWorktreesOp,
  duplicateWorktreeOp,
  renameWorktreeBranchOp,
  createWorktreeFromBranchOp,
  type CreateWorktreeParams,
  type DeleteWorktreeParams,
  type SyncWorktreesParams,
  type DuplicateWorktreeParams,
  type RenameBranchParams,
  type CreateFromBranchParams
} from '../services/worktree-ops'
import { getDatabase } from '../db'

export type {
  CreateWorktreeParams,
  DeleteWorktreeParams,
  SyncWorktreesParams
} from '../services/worktree-ops'

const log = createLogger({ component: 'WorktreeHandlers' })

export function registerWorktreeHandlers(): void {
  log.info('Registering worktree handlers')

  // Check if a repository has any commits
  ipcMain.handle('worktree:hasCommits', async (_event, projectPath: string): Promise<boolean> => {
    try {
      const gitService = createGitService(projectPath)
      return await gitService.hasCommits()
    } catch {
      return false
    }
  })

  // Create a new worktree
  ipcMain.handle(
    'worktree:create',
    async (_event, params: CreateWorktreeParams) => {
      const result = await createWorktreeOp(getDatabase(), params)
      if (result.success) {
        telemetryService.track('worktree_created')
      }
      return result
    }
  )

  // Delete/Archive a worktree
  ipcMain.handle(
    'worktree:delete',
    async (_event, params: DeleteWorktreeParams) => {
      return deleteWorktreeOp(getDatabase(), params)
    }
  )

  // Sync worktrees with actual git state
  ipcMain.handle(
    'worktree:sync',
    async (_event, params: SyncWorktreesParams) => {
      return syncWorktreesOp(getDatabase(), params)
    }
  )

  // Duplicate a worktree (clone branch with uncommitted state)
  ipcMain.handle(
    'worktree:duplicate',
    async (_event, params: DuplicateWorktreeParams) => {
      return duplicateWorktreeOp(getDatabase(), params)
    }
  )

  // Check if worktree path exists on disk
  ipcMain.handle('worktree:exists', (_event, worktreePath: string): boolean => {
    return existsSync(worktreePath)
  })

  // Open worktree in terminal
  ipcMain.handle(
    'worktree:openInTerminal',
    async (
      _event,
      worktreePath: string
    ): Promise<{
      success: boolean
      error?: string
    }> => {
      try {
        if (!existsSync(worktreePath)) {
          return {
            success: false,
            error: 'Worktree directory does not exist'
          }
        }

        const currentPlatform = platform()

        if (currentPlatform === 'darwin') {
          // macOS: Open Terminal.app
          spawn('open', ['-a', 'Terminal', worktreePath], { detached: true })
        } else if (currentPlatform === 'win32') {
          // Windows: Open cmd or PowerShell
          spawn('cmd.exe', ['/c', 'start', 'cmd.exe', '/K', `cd /d "${worktreePath}"`], {
            detached: true,
            shell: true
          })
        } else {
          // Linux: Try common terminal emulators
          const terminals = [
            'gnome-terminal',
            'konsole',
            'xfce4-terminal',
            'xterm',
            'terminator',
            'alacritty',
            'kitty'
          ]

          let launched = false
          for (const terminal of terminals) {
            try {
              if (terminal === 'gnome-terminal') {
                spawn(terminal, ['--working-directory', worktreePath], { detached: true })
              } else {
                spawn(terminal, [], { cwd: worktreePath, detached: true })
              }
              launched = true
              break
            } catch {
              // Try next terminal
            }
          }

          if (!launched) {
            return {
              success: false,
              error: 'No supported terminal emulator found'
            }
          }
        }

        return { success: true }
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error'
        return {
          success: false,
          error: message
        }
      }
    }
  )

  // Open worktree in default editor (VS Code)
  ipcMain.handle(
    'worktree:openInEditor',
    async (
      _event,
      worktreePath: string
    ): Promise<{
      success: boolean
      error?: string
    }> => {
      try {
        if (!existsSync(worktreePath)) {
          return {
            success: false,
            error: 'Worktree directory does not exist'
          }
        }

        const currentPlatform = platform()

        // Try VS Code first
        const vsCodeCommands =
          currentPlatform === 'darwin'
            ? [
                '/usr/local/bin/code',
                '/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code'
              ]
            : currentPlatform === 'win32'
              ? ['code.cmd', 'code']
              : ['code']

        let launched = false
        for (const codeCmd of vsCodeCommands) {
          try {
            spawn(codeCmd, [worktreePath], { detached: true, stdio: 'ignore' })
            launched = true
            break
          } catch {
            // Try next command
          }
        }

        if (!launched) {
          // Fallback: open in default file manager
          await shell.openPath(worktreePath)
        }

        return { success: true }
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error'
        return {
          success: false,
          error: message
        }
      }
    }
  )

  // Get git branches for a project
  ipcMain.handle(
    'git:branches',
    async (
      _event,
      projectPath: string
    ): Promise<{
      success: boolean
      branches?: string[]
      currentBranch?: string
      error?: string
    }> => {
      try {
        const gitService = createGitService(projectPath)
        const branches = await gitService.getAllBranches()
        const currentBranch = await gitService.getCurrentBranch()

        return {
          success: true,
          branches,
          currentBranch
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error'
        return {
          success: false,
          error: message
        }
      }
    }
  )

  // Check if a branch exists
  ipcMain.handle(
    'git:branchExists',
    async (_event, projectPath: string, branchName: string): Promise<boolean> => {
      try {
        const gitService = createGitService(projectPath)
        return await gitService.branchExists(branchName)
      } catch {
        return false
      }
    }
  )

  // Rename a branch in a worktree
  ipcMain.handle(
    'worktree:renameBranch',
    async (_event, params: RenameBranchParams) => {
      return renameWorktreeBranchOp(getDatabase(), params)
    }
  )

  // List all branches with checkout status
  ipcMain.handle(
    'git:listBranchesWithStatus',
    async (_event, { projectPath }: { projectPath: string }) => {
      try {
        const gitService = createGitService(projectPath)
        const branches = await gitService.listBranchesWithStatus()
        return { success: true, branches }
      } catch (error) {
        return {
          success: false,
          branches: [],
          error: error instanceof Error ? error.message : 'Unknown error'
        }
      }
    }
  )

  // Create a worktree from a specific existing branch
  ipcMain.handle(
    'worktree:createFromBranch',
    async (_event, params: CreateFromBranchParams) => {
      return createWorktreeFromBranchOp(getDatabase(), params)
    }
  )
}
