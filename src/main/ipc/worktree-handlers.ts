import { ipcMain } from 'electron'
import { spawn } from 'child_process'
import { existsSync } from 'fs'
import { platform } from 'os'
import { openPathWithPreferredEditor } from './settings-handlers'
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
  ipcMain.handle('worktree:create', async (_event, params: CreateWorktreeParams) => {
    const result = await createWorktreeOp(getDatabase(), params)
    if (result.success) {
      telemetryService.track('worktree_created')
    }
    return result
  })

  // Delete/Archive a worktree
  ipcMain.handle('worktree:delete', async (_event, params: DeleteWorktreeParams) => {
    return deleteWorktreeOp(getDatabase(), params)
  })

  // Sync worktrees with actual git state
  ipcMain.handle('worktree:sync', async (_event, params: SyncWorktreesParams) => {
    return syncWorktreesOp(getDatabase(), params)
  })

  // Duplicate a worktree (clone branch with uncommitted state)
  ipcMain.handle('worktree:duplicate', async (_event, params: DuplicateWorktreeParams) => {
    return duplicateWorktreeOp(getDatabase(), params)
  })

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

  // Open worktree in user's preferred editor (from Settings)
  ipcMain.handle(
    'worktree:openInEditor',
    async (
      _event,
      worktreePath: string
    ): Promise<{
      success: boolean
      error?: string
    }> => openPathWithPreferredEditor(worktreePath)
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
  ipcMain.handle('worktree:renameBranch', async (_event, params: RenameBranchParams) => {
    return renameWorktreeBranchOp(getDatabase(), params)
  })

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
  ipcMain.handle('worktree:createFromBranch', async (_event, params: CreateFromBranchParams) => {
    return createWorktreeFromBranchOp(getDatabase(), params)
  })

  // Get worktree context
  ipcMain.handle('worktree:getContext', async (_event, worktreeId: string) => {
    try {
      const db = getDatabase()
      const worktree = db.getWorktree(worktreeId)
      if (!worktree) {
        return { success: false, error: 'Worktree not found' }
      }
      return { success: true, context: worktree.context }
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error'
      }
    }
  })

  // Update worktree context
  ipcMain.handle(
    'worktree:updateContext',
    async (_event, worktreeId: string, context: string | null) => {
      try {
        const db = getDatabase()
        db.updateWorktreeContext(worktreeId, context)
        return { success: true }
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Unknown error'
        }
      }
    }
  )

  // Toggle Docker sandbox for a worktree
  ipcMain.handle(
    'worktree:toggleDockerSandbox',
    async (_event, worktreeId: string, enabled: boolean) => {
      try {
        const db = getDatabase()
        db.updateWorktreeDockerSandbox(worktreeId, enabled)

        // If disabling, clean up the sandbox and wrapper script (best-effort)
        if (!enabled) {
          const worktree = db.getWorktree(worktreeId)
          if (worktree) {
            try {
              const { stopAndRemoveSandbox, removeSandboxWrapper } = await import(
                '../services/docker-sandbox-service'
              )
              const safeBranch = worktree.branch_name.replace(/[^a-zA-Z0-9_.-]/g, '-')
              const sandboxName = `hive-${safeBranch}`
              stopAndRemoveSandbox(sandboxName)
              removeSandboxWrapper(sandboxName)
            } catch (cleanupError) {
              log.warn('Sandbox cleanup failed during disable', {
                worktreeId,
                error: cleanupError instanceof Error
                  ? cleanupError.message
                  : String(cleanupError)
              })
            }
          }
        }

        return { success: true }
      } catch (error) {
        log.error('Failed to toggle Docker sandbox', {
          worktreeId,
          enabled,
          error: error instanceof Error ? error.message : String(error)
        })
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Unknown error'
        }
      }
    }
  )

  // Detect Docker sandbox availability
  ipcMain.handle('worktree:detectDockerSandbox', async () => {
    try {
      const { detectDockerSandbox } = await import('../services/docker-sandbox-service')
      return detectDockerSandbox()
    } catch (error) {
      log.error('Failed to detect Docker sandbox', {
        error: error instanceof Error ? error.message : String(error)
      })
      return { dockerAvailable: false, sandboxAvailable: false }
    }
  })

  // List all running Docker sandboxes
  ipcMain.handle('worktree:listSandboxes', async () => {
    try {
      const { listSandboxes } = await import('../services/docker-sandbox-service')
      return { success: true, sandboxes: listSandboxes() }
    } catch (error) {
      log.error('Failed to list Docker sandboxes', {
        error: error instanceof Error ? error.message : String(error)
      })
      return {
        success: false,
        sandboxes: [],
        error: error instanceof Error ? error.message : 'Unknown error'
      }
    }
  })

  // Stop and remove a Docker sandbox
  ipcMain.handle('worktree:stopSandbox', async (_event, name: string) => {
    try {
      const { stopAndRemoveSandbox } = await import('../services/docker-sandbox-service')
      stopAndRemoveSandbox(name)
      return { success: true }
    } catch (error) {
      log.error('Failed to stop Docker sandbox', {
        name,
        error: error instanceof Error ? error.message : String(error)
      })
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error'
      }
    }
  })

  // Check if a sandbox setup token exists
  ipcMain.handle('sandbox:hasToken', async () => {
    try {
      const db = getDatabase()
      const token = db.getSandboxToken()
      return { success: true, hasToken: !!token }
    } catch (error) {
      log.error('Failed to check sandbox token', {
        error: error instanceof Error ? error.message : String(error)
      })
      return {
        success: false,
        hasToken: false,
        error: error instanceof Error ? error.message : 'Unknown error'
      }
    }
  })

  // Generate a sandbox setup token via claude setup-token.
  //
  // claude setup-token uses Ink (React terminal UI) which requires a TTY with
  // raw mode support. Plain execFile/spawn don't allocate a PTY, so Ink crashes
  // with "Raw mode is not supported on the current process.stdin". We use
  // node-pty to give the command a proper pseudo-terminal.
  ipcMain.handle('sandbox:generateToken', async () => {
    try {
      const { resolveClaudeBinaryPath } = await import('../services/claude-binary-resolver')
      const claudeBinary = resolveClaudeBinaryPath()
      if (!claudeBinary) {
        return {
          success: false,
          error: 'Claude CLI not found. Please install Claude Code first.'
        }
      }

      log.info('Starting sandbox token generation via claude setup-token (pty)')

      const ptyMod = await import('node-pty')
      const TOKEN_TIMEOUT_MS = 120_000

      const token = await new Promise<string>((resolve, reject) => {
        let output = ''
        let settled = false

        const ptyProc = ptyMod.spawn(claudeBinary, ['setup-token'], {
          name: 'xterm-256color',
          cols: 120,
          rows: 30,
          cwd: process.env.HOME || '/',
          env: { ...process.env } as Record<string, string>
        })

        // Strip ANSI escape codes so we can reliably match token patterns
        const stripAnsi = (str: string): string =>
          str.replace(
            // eslint-disable-next-line no-control-regex
            /[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nq-uy=><~]/g,
            ''
          )

        const timer = setTimeout(() => {
          if (!settled) {
            settled = true
            try { ptyProc.kill() } catch { /* ignore */ }
            log.error('Sandbox token generation timed out', {
              outputLength: output.length
            })
            reject(new Error('Token generation timed out. Please try again.'))
          }
        }, TOKEN_TIMEOUT_MS)

        ptyProc.onData((data: string) => {
          output += data
          // Check accumulated output for the token pattern after stripping ANSI codes
          const clean = stripAnsi(output)
          const match = clean.match(/\bsk-ant-[A-Za-z0-9_-]+\b/)
          if (match && !settled) {
            settled = true
            clearTimeout(timer)
            log.info('Token found in pty output, killing process')
            try { ptyProc.kill() } catch { /* ignore */ }
            resolve(match[0])
          }
        })

        ptyProc.onExit(({ exitCode }) => {
          if (!settled) {
            settled = true
            clearTimeout(timer)
            // One final check of the full output
            const clean = stripAnsi(output)
            const match = clean.match(/\bsk-ant-[A-Za-z0-9_-]+\b/)
            if (match) {
              resolve(match[0])
            } else {
              log.error('claude setup-token exited without producing a token', {
                exitCode,
                cleanOutputLength: clean.length
              })
              reject(new Error(
                'claude setup-token exited without producing a token. Please try again.'
              ))
            }
          }
        })
      })

      const db = getDatabase()
      db.setSandboxToken(token)
      log.info('Sandbox setup token stored successfully')

      return { success: true }
    } catch (error) {
      log.error('Failed to generate sandbox token', {
        error: error instanceof Error ? error.message : String(error)
      })
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error'
      }
    }
  })

  // Clear the stored sandbox setup token
  ipcMain.handle('sandbox:clearToken', async () => {
    try {
      const db = getDatabase()
      db.deleteSandboxToken()
      log.info('Sandbox setup token cleared')
      return { success: true }
    } catch (error) {
      log.error('Failed to clear sandbox token', {
        error: error instanceof Error ? error.message : String(error)
      })
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error'
      }
    }
  })

  // Pre-create Docker sandbox (async, non-blocking)
  ipcMain.handle(
    'sandbox:ensureExists',
    async (
      _event,
      params: {
        worktreeId: string
        worktreePath: string
        projectGitPath: string
      }
    ) => {
      try {
        const { ensureSandboxExistsAsync, getSandboxNameForWorktree } = await import(
          '../services/docker-sandbox-service'
        )
        const sandboxName = getSandboxNameForWorktree(params.worktreeId)
        const result = await ensureSandboxExistsAsync({
          sandboxName,
          worktreePath: params.worktreePath,
          projectGitPath: params.projectGitPath
        })
        return { success: true, created: result.created }
      } catch (error) {
        log.error('Failed to ensure sandbox exists', {
          worktreeId: params.worktreeId,
          error: error instanceof Error ? error.message : String(error)
        })
        return {
          success: false,
          created: false,
          error: error instanceof Error ? error.message : 'Unknown error'
        }
      }
    }
  )

  ipcMain.handle('sandbox:exists', async (_event, params: { worktreeId: string }) => {
    try {
      const { sandboxExistsAsync, getSandboxNameForWorktree } = await import(
        '../services/docker-sandbox-service'
      )
      const sandboxName = getSandboxNameForWorktree(params.worktreeId)
      const exists = await sandboxExistsAsync(sandboxName)
      return { success: true, exists }
    } catch (error) {
      return {
        success: false,
        exists: false,
        error: error instanceof Error ? error.message : String(error)
      }
    }
  })
}
