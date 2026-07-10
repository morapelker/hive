import { Effect } from 'effect'
import { z } from 'zod'
import { killPid } from '../../../main/services/script-kill-pid'
import { assignPort, getAssignedPort } from '../../../main/services/port-registry'
import { scriptRunner } from '../../../main/services/script-runner'
import { telemetryService } from '../../../main/services/telemetry-service'
import { getDatabase } from '../../../main/db'
import {
  isDesktopCommandResult,
  makeDesktopCommandRequest,
  type KillScriptResult
} from '../../../shared/desktop-command'
import type { EventBus } from '../../events/event-bus'
import type { RpcHandler } from '../router'

export interface ScriptPortResult {
  readonly port: number | null
}

export interface ScriptKillPidResult {
  readonly killed: boolean
  readonly reason?: string
}

export interface ScriptRunArchiveResult {
  readonly success: boolean
  readonly output: string
  readonly error?: string
}

export interface ScriptRunSetupResult {
  readonly success: boolean
  readonly error?: string
}

export interface ScriptRunProjectResult {
  readonly success: boolean
  readonly pid?: number
  readonly error?: string
}

export type ScriptKillResult = KillScriptResult

export interface ScriptOpsRpcService {
  readonly getPort: (cwd: string) => Effect.Effect<ScriptPortResult, unknown, never>
  readonly killPid: (pid: number) => Effect.Effect<ScriptKillPidResult, unknown, never>
  readonly kill: (worktreeId: string) => Effect.Effect<ScriptKillResult, unknown, never>
  readonly runArchive: (
    commands: string[],
    cwd: string
  ) => Effect.Effect<ScriptRunArchiveResult, unknown, never>
  readonly runSetup: (
    commands: string[],
    cwd: string,
    worktreeId: string
  ) => Effect.Effect<ScriptRunSetupResult, unknown, never>
  readonly runProject: (
    commands: string[],
    cwd: string,
    worktreeId: string
  ) => Effect.Effect<ScriptRunProjectResult, unknown, never>
}

const getPortParamsSchema = z.object({ cwd: z.string().min(1) }).strict()
const killPidParamsSchema = z.object({ pid: z.number().int() }).strict()
const killParamsSchema = z.object({ worktreeId: z.string().min(1) }).strict()
const runScriptParamsSchema = z
  .object({
    commands: z.array(z.string()),
    cwd: z.string().min(1),
    worktreeId: z.string().min(1)
  })
  .strict()
const runArchiveParamsSchema = z
  .object({
    commands: z.array(z.string()),
    cwd: z.string().min(1)
  })
  .strict()

/** PORT env for a worktree's scripts when its project has auto-assign-port
 * on. Exported for remote-launch-ops so remote setup scripts get the same
 * injection as local `scriptOps.runSetup`. */
export const resolvePortEnv = (worktreeId: string, cwd: string): Record<string, string> => {
  const env: Record<string, string> = {}
  try {
    const db = getDatabase()
    const worktree = db.getWorktree(worktreeId)
    if (!worktree) return env

    const project = db.getProject(worktree.project_id)
    if (!project?.auto_assign_port) return env

    let port = getAssignedPort(cwd)
    if (port === null) {
      port = assignPort(cwd)
    }

    env.PORT = String(port)
  } catch {
    return env
  }
  return env
}

const isKillScriptResult = (value: unknown): value is KillScriptResult =>
  typeof value === 'object' &&
  value !== null &&
  'success' in value &&
  typeof value.success === 'boolean' &&
  (!('error' in value) || typeof value.error === 'string')

const requestDesktopKillScript = (worktreeId: string): Promise<KillScriptResult> => {
  const send = process.send
  if (!send) return Promise.resolve({ success: true })

  const id = `script-kill-${Date.now()}-${Math.random().toString(36).slice(2)}`
  const command = 'killScript'

  return new Promise<KillScriptResult>((resolve) => {
    let settled = false
    const cleanup = (): void => {
      clearTimeout(timeout)
      process.off('message', onMessage)
    }
    const finish = (value: KillScriptResult): void => {
      if (settled) return
      settled = true
      cleanup()
      resolve(value)
    }
    const timeout = setTimeout(() => {
      finish({
        success: false,
        error: `Timed out waiting for desktop command response: ${command}`
      })
    }, 5_000)

    const onMessage = (message: unknown): void => {
      if (!isDesktopCommandResult(message) || message.id !== id) return
      if (!message.ok) {
        finish({ success: false, error: message.error ?? `Desktop command failed: ${command}` })
        return
      }
      if (isKillScriptResult(message.value)) {
        finish(message.value)
        return
      }
      finish({ success: false, error: `Invalid desktop command response for ${command}` })
    }

    process.on('message', onMessage)
    send.call(process, makeDesktopCommandRequest(id, command, { worktreeId }), (error) => {
      if (!error) return
      finish({ success: false, error: error.message })
    })
  })
}

export const makeLiveScriptOpsRpcService = (eventBus?: EventBus): ScriptOpsRpcService => {
  if (eventBus) {
    scriptRunner.setEventPublisher((channel, payload) =>
      Effect.runPromise(eventBus.publish({ channel, payload })).then(() => undefined)
    )
  }

  return {
    getPort: (cwd) =>
      Effect.try({
        try: () => ({ port: getAssignedPort(cwd) }),
        catch: (cause) => cause
      }),
    killPid: (pid) =>
      Effect.tryPromise({
        try: () => killPid(pid),
        catch: (cause) => cause
      }),
    kill: (worktreeId) =>
      Effect.tryPromise({
        try: async () => {
          const killedBackendProcess = await scriptRunner.killProcess(`script:run:${worktreeId}`)
          if (killedBackendProcess) return { success: true }
          return requestDesktopKillScript(worktreeId)
        },
        catch: (cause) => cause
      }),
    runArchive: (commands, cwd) =>
      Effect.tryPromise({
        try: async () => {
          const result = await scriptRunner.runAndWait(commands, cwd, 30000)
          if (result.success) {
            telemetryService.track('script_run', { type: 'archive' })
          }
          return result
        },
        catch: (cause) => cause
      }),
    runSetup: (commands, cwd, worktreeId) =>
      Effect.tryPromise({
        try: async () => {
          const result = await scriptRunner.runSequential(
            commands,
            cwd,
            `script:setup:${worktreeId}`,
            resolvePortEnv(worktreeId, cwd)
          )
          if (result.success) {
            telemetryService.track('script_run', { type: 'setup' })
          }
          return result
        },
        catch: (cause) => cause
      }),
    runProject: (commands, cwd, worktreeId) =>
      Effect.tryPromise({
        try: async () => {
          const handle = await scriptRunner.runPersistent(
            commands,
            cwd,
            `script:run:${worktreeId}`,
            resolvePortEnv(worktreeId, cwd)
          )
          telemetryService.track('script_run', { type: 'run' })
          return { success: true, pid: handle.pid }
        },
        catch: (cause) => cause
      })
  }
}

export const makeScriptOpsRpcHandlers = (
  service: ScriptOpsRpcService = makeLiveScriptOpsRpcService()
): ReadonlyMap<string, RpcHandler> =>
  new Map<string, RpcHandler>([
    [
      'scriptOps.getPort',
      (params) =>
        Effect.gen(function* () {
          const { cwd } = yield* Effect.try({
            try: () => getPortParamsSchema.parse(params),
            catch: (cause) => cause
          })
          return yield* service.getPort(cwd)
        })
    ],
    [
      'scriptOps.killPid',
      (params) =>
        Effect.gen(function* () {
          const { pid } = yield* Effect.try({
            try: () => killPidParamsSchema.parse(params),
            catch: (cause) => cause
          })
          return yield* service.killPid(pid)
        })
    ],
    [
      'scriptOps.kill',
      (params) =>
        Effect.gen(function* () {
          const { worktreeId } = yield* Effect.try({
            try: () => killParamsSchema.parse(params),
            catch: (cause) => cause
          })
          return yield* service.kill(worktreeId)
        })
    ],
    [
      'scriptOps.runArchive',
      (params) =>
        Effect.gen(function* () {
          const { commands, cwd } = yield* Effect.try({
            try: () => runArchiveParamsSchema.parse(params),
            catch: (cause) => cause
          })
          return yield* service.runArchive(commands, cwd)
        })
    ],
    [
      'scriptOps.runSetup',
      (params) =>
        Effect.gen(function* () {
          const { commands, cwd, worktreeId } = yield* Effect.try({
            try: () => runScriptParamsSchema.parse(params),
            catch: (cause) => cause
          })
          return yield* service.runSetup(commands, cwd, worktreeId)
        })
    ],
    [
      'scriptOps.runProject',
      (params) =>
        Effect.gen(function* () {
          const { commands, cwd, worktreeId } = yield* Effect.try({
            try: () => runScriptParamsSchema.parse(params),
            catch: (cause) => cause
          })
          return yield* service.runProject(commands, cwd, worktreeId)
        })
    ]
  ])
