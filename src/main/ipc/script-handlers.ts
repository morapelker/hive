import { BrowserWindow } from 'electron'
import { Data, Effect } from 'effect'
import { z } from 'zod'

import { scriptRunner } from '../services/script-runner'
import { getAssignedPort, assignPort } from '../services/port-registry'
import { getDatabase } from '../db'
import { createLogger } from '../services/logger'
import { telemetryService } from '../services/telemetry-service'
import { defineHandler } from './_shared/define-handler'

const log = createLogger({ component: 'ScriptHandlers' })

class ScriptHandlerFailed extends Data.TaggedError('ScriptHandlerFailed')<{
  readonly operation: string
  readonly reason: string
  readonly message: string
}> {}

const scriptFailed = (operation: string, cause: unknown): ScriptHandlerFailed => {
  const reason = cause instanceof Error ? cause.message : String(cause)
  return new ScriptHandlerFailed({ operation, reason, message: reason })
}

const runScriptSchema = z.object({
  commands: z.array(z.string()),
  cwd: z.string().min(1),
  worktreeId: z.string().min(1)
})

const runArchiveSchema = z.object({
  commands: z.array(z.string()),
  cwd: z.string().min(1)
})

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
  defineHandler('script:runSetup', runScriptSchema, ({ commands, cwd, worktreeId }) => {
    log.info('IPC: script:runSetup', { worktreeId, cwd, commandCount: commands.length })
    return Effect.tryPromise({
      try: async () => {
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
      },
      catch: (error) => {
        log.error(
          'IPC: script:runSetup failed',
          error instanceof Error ? error : new Error(String(error))
        )
        return scriptFailed('script:runSetup', error)
      }
    })
  })

  // Run project script (persistent long-running process)
  defineHandler('script:runProject', runScriptSchema, ({ commands, cwd, worktreeId }) => {
    log.info('IPC: script:runProject', { worktreeId, cwd, commandCount: commands.length })
    return Effect.tryPromise({
      try: async () => {
        const portEnv = resolvePortEnv(worktreeId, cwd)
        const handle = await scriptRunner.runPersistent(
          commands,
          cwd,
          `script:run:${worktreeId}`,
          portEnv
        )
        telemetryService.track('script_run', { type: 'run' })
        return { success: true, pid: handle.pid }
      },
      catch: (error) => {
        log.error(
          'IPC: script:runProject failed',
          error instanceof Error ? error : new Error(String(error))
        )
        return scriptFailed('script:runProject', error)
      }
    })
  })

  // Kill a running project script
  defineHandler('script:kill', z.object({ worktreeId: z.string().min(1) }), ({ worktreeId }) => {
    log.info('IPC: script:kill', { worktreeId })
    return Effect.tryPromise({
      try: async () => {
        await scriptRunner.killProcess(`script:run:${worktreeId}`)
        return { success: true }
      },
      catch: (error) => {
        log.error(
          'IPC: script:kill failed',
          error instanceof Error ? error : new Error(String(error))
        )
        return scriptFailed('script:kill', error)
      }
    })
  })

  defineHandler('script:killPid', z.object({ pid: z.number().int() }), ({ pid }) => {
    log.info('IPC: script:killPid', { pid })
    return Effect.tryPromise({
      try: () => scriptRunner.killPid(pid),
      catch: (error) => scriptFailed('script:killPid', error)
    })
  })

  // Run archive script (non-interactive, captures output)
  defineHandler('script:runArchive', runArchiveSchema, ({ commands, cwd }) => {
    log.info('IPC: script:runArchive', { cwd, commandCount: commands.length })
    return Effect.tryPromise({
      try: async () => {
        const result = await scriptRunner.runAndWait(commands, cwd, 30000)
        if (result.success) {
          telemetryService.track('script_run', { type: 'archive' })
        }
        return result
      },
      catch: (error) => {
        log.error(
          'IPC: script:runArchive failed',
          error instanceof Error ? error : new Error(String(error))
        )
        return scriptFailed('script:runArchive', error)
      }
    })
  })

  defineHandler('port:get', z.object({ cwd: z.string().min(1) }), ({ cwd }) =>
    Effect.tryPromise({
      try: async () => {
        const { getAssignedPort } = await import('../services/port-registry')
        return { port: getAssignedPort(cwd) }
      },
      catch: (error) => scriptFailed('port:get', error)
    })
  )

  log.info('Script IPC handlers registered')
}

export function cleanupScripts(): void {
  log.info('Cleaning up script runner')
  scriptRunner.killAll()
}
