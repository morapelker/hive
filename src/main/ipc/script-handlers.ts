import { ipcMain, BrowserWindow } from 'electron'
import { scriptRunner } from '../services/script-runner'
import { getAssignedPort, assignPort } from '../services/port-registry'
import { getDatabase } from '../db'
import { createLogger } from '../services/logger'
import { telemetryService } from '../services/telemetry-service'

const log = createLogger({ component: 'ScriptHandlers' })

function resolvePortEnv(worktreeId: string, cwd: string): Record<string, string> {
  const env: Record<string, string> = {}
  try {
    const db = getDatabase()
    const worktree = db.getWorktree(worktreeId)
    if (!worktree) return env

    const project = db.getProject(worktree.project_id)
    if (!project?.auto_assign_port) return env

    // Lazy assignment: if auto_assign_port is enabled but no port registered yet, assign one
    let port = getAssignedPort(cwd)
    if (port === null) {
      port = assignPort(cwd)
      log.info('Lazy-assigned port for worktree', { worktreeId, cwd, port })
    }

    env.PORT = String(port)
  } catch (error) {
    log.warn('Failed to resolve port env', {
      worktreeId,
      error: error instanceof Error ? error.message : String(error)
    })
  }
  return env
}

export function registerScriptHandlers(mainWindow: BrowserWindow): void {
  scriptRunner.setMainWindow(mainWindow)

  // Run setup script (sequential commands, streamed output)
  ipcMain.handle(
    'script:runSetup',
    async (
      _event,
      { commands, cwd, worktreeId }: { commands: string[]; cwd: string; worktreeId: string }
    ) => {
      log.info('IPC: script:runSetup', { worktreeId, cwd, commandCount: commands.length })
      try {
        const portEnv = resolvePortEnv(worktreeId, cwd)
        const result = await scriptRunner.runSequential(
          commands,
          cwd,
          `script:setup:${worktreeId}`,
          portEnv
        )
        if (result.success) {
          telemetryService.track('script_run', { type: 'setup' })
        }
        return result
      } catch (error) {
        log.error('IPC: script:runSetup failed', { error })
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Unknown error'
        }
      }
    }
  )

  // Run project script (persistent long-running process)
  ipcMain.handle(
    'script:runProject',
    async (
      _event,
      { commands, cwd, worktreeId }: { commands: string[]; cwd: string; worktreeId: string }
    ) => {
      log.info('IPC: script:runProject', { worktreeId, cwd, commandCount: commands.length })
      try {
        const portEnv = resolvePortEnv(worktreeId, cwd)
        const handle = await scriptRunner.runPersistent(
          commands,
          cwd,
          `script:run:${worktreeId}`,
          portEnv
        )
        telemetryService.track('script_run', { type: 'run' })
        return { success: true, pid: handle.pid }
      } catch (error) {
        log.error('IPC: script:runProject failed', { error })
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Unknown error'
        }
      }
    }
  )

  // Kill a running project script
  ipcMain.handle('script:kill', async (_event, { worktreeId }: { worktreeId: string }) => {
    log.info('IPC: script:kill', { worktreeId })
    try {
      await scriptRunner.killProcess(`script:run:${worktreeId}`)
      return { success: true }
    } catch (error) {
      log.error('IPC: script:kill failed', { error })
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error'
      }
    }
  })

  // Run archive script (non-interactive, captures output)
  ipcMain.handle(
    'script:runArchive',
    async (_event, { commands, cwd }: { commands: string[]; cwd: string }) => {
      log.info('IPC: script:runArchive', { cwd, commandCount: commands.length })
      try {
        const result = await scriptRunner.runAndWait(commands, cwd, 30000)
        if (result.success) {
          telemetryService.track('script_run', { type: 'archive' })
        }
        return result
      } catch (error) {
        log.error('IPC: script:runArchive failed', { error })
        return {
          success: false,
          output: '',
          error: error instanceof Error ? error.message : 'Unknown error'
        }
      }
    }
  )

  ipcMain.handle('port:get', async (_event, { cwd }: { cwd: string }) => {
    const { getAssignedPort } = await import('../services/port-registry')
    return { port: getAssignedPort(cwd) }
  })

  log.info('Script IPC handlers registered')
}

export function cleanupScripts(): void {
  log.info('Cleaning up script runner')
  scriptRunner.killAll()
}
