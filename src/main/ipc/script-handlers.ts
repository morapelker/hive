import { ipcMain, BrowserWindow } from 'electron'
import { scriptRunner } from '../services/script-runner'
import { createLogger } from '../services/logger'

const log = createLogger({ component: 'ScriptHandlers' })

export function registerScriptHandlers(mainWindow: BrowserWindow): void {
  scriptRunner.setMainWindow(mainWindow)

  // Run setup script (sequential commands, streamed output)
  ipcMain.handle(
    'script:runSetup',
    async (_event, { commands, cwd, worktreeId }: { commands: string[]; cwd: string; worktreeId: string }) => {
      log.info('IPC: script:runSetup', { worktreeId, cwd, commandCount: commands.length })
      try {
        const result = await scriptRunner.runSequential(commands, cwd, `script:setup:${worktreeId}`)
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
    async (_event, { commands, cwd, worktreeId }: { commands: string[]; cwd: string; worktreeId: string }) => {
      log.info('IPC: script:runProject', { worktreeId, cwd, commandCount: commands.length })
      try {
        const handle = scriptRunner.runPersistent(commands, cwd, `script:run:${worktreeId}`)
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
  ipcMain.handle(
    'script:kill',
    async (_event, { worktreeId }: { worktreeId: string }) => {
      log.info('IPC: script:kill', { worktreeId })
      try {
        scriptRunner.killProcess(`script:run:${worktreeId}`)
        return { success: true }
      } catch (error) {
        log.error('IPC: script:kill failed', { error })
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Unknown error'
        }
      }
    }
  )

  // Run archive script (non-interactive, captures output)
  ipcMain.handle(
    'script:runArchive',
    async (_event, { commands, cwd }: { commands: string[]; cwd: string }) => {
      log.info('IPC: script:runArchive', { cwd, commandCount: commands.length })
      try {
        const result = await scriptRunner.runAndWait(commands, cwd, 30000)
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

  log.info('Script IPC handlers registered')
}

export function cleanupScripts(): void {
  log.info('Cleaning up script runner')
  scriptRunner.killAll()
}
