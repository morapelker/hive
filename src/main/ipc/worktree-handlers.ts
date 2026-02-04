import { ipcMain, shell } from 'electron'
import { spawn } from 'child_process'
import { existsSync } from 'fs'
import { platform } from 'os'
import { createGitService } from '../services'
import { getDatabase } from '../db'

export interface CreateWorktreeParams {
  projectId: string
  projectPath: string
  projectName: string
}

export interface DeleteWorktreeParams {
  worktreeId: string
  worktreePath: string
  branchName: string
  projectPath: string
  archive: boolean // true = Archive (delete branch), false = Unbranch (keep branch)
}

export interface SyncWorktreesParams {
  projectId: string
  projectPath: string
}

export function registerWorktreeHandlers(): void {
  // Create a new worktree
  ipcMain.handle(
    'worktree:create',
    async (
      _event,
      params: CreateWorktreeParams
    ): Promise<{
      success: boolean
      worktree?: {
        id: string
        project_id: string
        name: string
        branch_name: string
        path: string
        status: string
        created_at: string
        last_accessed_at: string
      }
      error?: string
    }> => {
      try {
        const gitService = createGitService(params.projectPath)
        const result = await gitService.createWorktree(params.projectName)

        if (!result.success || !result.name || !result.path || !result.branchName) {
          return {
            success: false,
            error: result.error || 'Failed to create worktree'
          }
        }

        // Create database entry
        const worktree = getDatabase().createWorktree({
          project_id: params.projectId,
          name: result.name,
          branch_name: result.branchName,
          path: result.path
        })

        return {
          success: true,
          worktree
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

  // Delete/Archive a worktree
  ipcMain.handle(
    'worktree:delete',
    async (
      _event,
      params: DeleteWorktreeParams
    ): Promise<{
      success: boolean
      error?: string
    }> => {
      try {
        const gitService = createGitService(params.projectPath)

        let result
        if (params.archive) {
          // Archive: remove worktree AND delete branch
          result = await gitService.archiveWorktree(params.worktreePath, params.branchName)
        } else {
          // Unbranch: remove worktree but keep branch
          result = await gitService.removeWorktree(params.worktreePath)
        }

        if (!result.success) {
          return result
        }

        // Update database - archive the worktree record
        getDatabase().archiveWorktree(params.worktreeId)

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

  // Sync worktrees with actual git state
  ipcMain.handle(
    'worktree:sync',
    async (
      _event,
      params: SyncWorktreesParams
    ): Promise<{
      success: boolean
      error?: string
    }> => {
      try {
        const gitService = createGitService(params.projectPath)
        const db = getDatabase()

        // Get actual worktrees from git
        const gitWorktrees = await gitService.listWorktrees()
        const gitWorktreePaths = new Set(gitWorktrees.map((w) => w.path))

        // Get database worktrees
        const dbWorktrees = db.getActiveWorktreesByProject(params.projectId)

        // Check each database worktree
        for (const dbWorktree of dbWorktrees) {
          // If worktree path doesn't exist in git worktrees or on disk
          if (!gitWorktreePaths.has(dbWorktree.path) && !existsSync(dbWorktree.path)) {
            // Mark as archived (worktree was removed outside of Hive)
            db.archiveWorktree(dbWorktree.id)
          }
        }

        // Prune any stale git worktree entries
        await gitService.pruneWorktrees()

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
            ? ['/usr/local/bin/code', '/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code']
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
}
