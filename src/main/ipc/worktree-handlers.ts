import { ipcMain, shell } from 'electron'
import { spawn } from 'child_process'
import { existsSync } from 'fs'
import { platform } from 'os'
import { createGitService, createLogger } from '../services'
import { CITY_NAMES } from '../services/city-names'
import { scriptRunner } from '../services/script-runner'
import { getDatabase } from '../db'

const log = createLogger({ component: 'WorktreeHandlers' })

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
  log.info('Registering worktree handlers')

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
      log.info('Creating worktree', {
        projectName: params.projectName,
        projectId: params.projectId
      })
      try {
        const gitService = createGitService(params.projectPath)
        const result = await gitService.createWorktree(params.projectName)

        if (!result.success || !result.name || !result.path || !result.branchName) {
          log.warn('Worktree creation failed', {
            error: result.error,
            projectName: params.projectName
          })
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

        log.info('Worktree created successfully', { name: result.name, path: result.path })
        return {
          success: true,
          worktree
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error'
        log.error('Worktree creation error', error instanceof Error ? error : new Error(message), {
          params
        })
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
        const db = getDatabase()

        // Guard: block delete/archive of default worktrees
        const worktree = db.getWorktree(params.worktreeId)
        if (worktree?.is_default) {
          return {
            success: false,
            error: 'Cannot archive or delete the default worktree'
          }
        }

        // Run archive script if configured (before git operations)
        const project = worktree?.project_id ? db.getProject(worktree.project_id) : null
        if (project?.archive_script) {
          // Pass raw script lines — scriptRunner.parseCommands handles splitting/filtering
          const commands = [project.archive_script]
          log.info('Running archive script before worktree deletion', {
            worktreeId: params.worktreeId
          })
          const scriptResult = await scriptRunner.runAndWait(commands, params.worktreePath, 30000)
          if (scriptResult.success) {
            log.info('Archive script completed successfully', { output: scriptResult.output })
          } else {
            log.warn('Archive script failed, proceeding with archival anyway', {
              error: scriptResult.error,
              output: scriptResult.output
            })
          }
        }

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
        db.archiveWorktree(params.worktreeId)

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

        // Build a map of git worktree path -> branch for quick lookup
        const gitBranchByPath = new Map(gitWorktrees.map((w) => [w.path, w.branch]))

        // Check each database worktree
        for (const dbWorktree of dbWorktrees) {
          // If worktree path doesn't exist in git worktrees or on disk
          if (!gitWorktreePaths.has(dbWorktree.path) && !existsSync(dbWorktree.path)) {
            // Mark as archived (worktree was removed outside of Hive)
            db.archiveWorktree(dbWorktree.id)
            continue
          }

          // Sync branch name if it was renamed outside of Hive
          const gitBranch = gitBranchByPath.get(dbWorktree.path)
          if (gitBranch && gitBranch !== dbWorktree.branch_name) {
            log.info('Branch renamed externally, updating DB', {
              worktreeId: dbWorktree.id,
              oldBranch: dbWorktree.branch_name,
              newBranch: gitBranch
            })
            // Update branch_name always. Also update display name if it still matches
            // the old branch name OR is a city placeholder name (never meaningfully customized).
            const nameMatchesBranch = dbWorktree.name === dbWorktree.branch_name
            const isCityName = CITY_NAMES.some(
              (city) => city.toLowerCase() === dbWorktree.name.toLowerCase()
            )
            const shouldUpdateName = nameMatchesBranch || isCityName
            db.updateWorktree(dbWorktree.id, {
              branch_name: gitBranch,
              ...(shouldUpdateName ? { name: gitBranch } : {})
            })
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

  // Duplicate a worktree (clone branch with uncommitted state)
  ipcMain.handle(
    'worktree:duplicate',
    async (
      _event,
      params: {
        projectId: string
        projectPath: string
        projectName: string
        sourceBranch: string
        sourceWorktreePath: string
      }
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
      log.info('Duplicating worktree', {
        sourceBranch: params.sourceBranch,
        projectName: params.projectName
      })
      try {
        const gitService = createGitService(params.projectPath)
        const result = await gitService.duplicateWorktree(
          params.sourceBranch,
          params.sourceWorktreePath,
          params.projectName
        )

        if (!result.success || !result.name || !result.path || !result.branchName) {
          log.warn('Worktree duplication failed', { error: result.error })
          return {
            success: false,
            error: result.error || 'Failed to duplicate worktree'
          }
        }

        // Create database entry
        const worktree = getDatabase().createWorktree({
          project_id: params.projectId,
          name: result.name,
          branch_name: result.branchName,
          path: result.path
        })

        log.info('Worktree duplicated successfully', { name: result.name, path: result.path })
        return {
          success: true,
          worktree
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error'
        log.error(
          'Worktree duplication error',
          error instanceof Error ? error : new Error(message),
          { params }
        )
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
    async (
      _event,
      {
        worktreeId,
        worktreePath,
        oldBranch,
        newBranch
      }: { worktreeId: string; worktreePath: string; oldBranch: string; newBranch: string }
    ) => {
      log.info('IPC: worktree:renameBranch', { worktreePath, oldBranch, newBranch })
      try {
        const gitService = createGitService(worktreePath)
        const result = await gitService.renameBranch(worktreePath, oldBranch, newBranch)
        if (result.success) {
          const db = getDatabase()
          db.updateWorktree(worktreeId, { branch_name: newBranch, branch_renamed: 1 })
        }
        return result
      } catch (error) {
        log.error(
          'IPC: worktree:renameBranch failed',
          error instanceof Error ? error : new Error('Unknown error')
        )
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Unknown error'
        }
      }
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
    async (
      _event,
      {
        projectId,
        projectPath,
        projectName,
        branchName
      }: { projectId: string; projectPath: string; projectName: string; branchName: string }
    ) => {
      log.info('IPC: worktree:createFromBranch', { projectName, branchName })
      try {
        const gitService = createGitService(projectPath)
        const result = await gitService.createWorktreeFromBranch(projectName, branchName)
        if (!result.success || !result.path) {
          return { success: false, error: result.error || 'Failed to create worktree from branch' }
        }
        const db = getDatabase()
        const worktree = db.createWorktree({
          project_id: projectId,
          name: result.name || branchName,
          branch_name: result.branchName || branchName,
          path: result.path
        })
        return { success: true, worktree }
      } catch (error) {
        log.error(
          'IPC: worktree:createFromBranch failed',
          error instanceof Error ? error : new Error('Unknown error')
        )
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Unknown error'
        }
      }
    }
  )
}
