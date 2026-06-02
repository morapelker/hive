import type { ServerEvent } from '@shared/rpc/protocol'
import type { ScriptOutputEvent } from '@shared/types/script'
import { getRendererRpcClient } from './rpc-client'

type ScriptRunSetupResult = {
  success: boolean
  error?: string
}

type ScriptRunProjectResult = {
  success: boolean
  pid?: number
  error?: string
}

type ScriptPortResult = {
  port: number | null
}

type ScriptKillResult = {
  success: boolean
  error?: string
}

type ScriptKillPidResult = {
  killed: boolean
  reason?: string
}

const isScriptOutputEvent = (value: unknown): value is ScriptOutputEvent => {
  if (typeof value !== 'object' || value === null) return false
  if (!('type' in value) || typeof value.type !== 'string') return false
  if (!['command-start', 'output', 'error', 'done', 'long-running'].includes(value.type)) {
    return false
  }
  if ('command' in value && value.command !== undefined && typeof value.command !== 'string') {
    return false
  }
  if ('data' in value && value.data !== undefined && typeof value.data !== 'string') {
    return false
  }
  if ('exitCode' in value && value.exitCode !== undefined && typeof value.exitCode !== 'number') {
    return false
  }
  if ('elapsed' in value && value.elapsed !== undefined && typeof value.elapsed !== 'number') {
    return false
  }

  return true
}

export const scriptApi = {
  getPort: async (cwd: string): Promise<ScriptPortResult> =>
    getRendererRpcClient().request<ScriptPortResult>('scriptOps.getPort', { cwd }),
  runSetup: async (
    commands: string[],
    cwd: string,
    worktreeId: string
  ): Promise<ScriptRunSetupResult> =>
    getRendererRpcClient().request<ScriptRunSetupResult>('scriptOps.runSetup', {
      commands,
      cwd,
      worktreeId
    }),
  runProject: async (
    commands: string[],
    cwd: string,
    worktreeId: string
  ): Promise<ScriptRunProjectResult> =>
    getRendererRpcClient().request<ScriptRunProjectResult>('scriptOps.runProject', {
      commands,
      cwd,
      worktreeId
    }),
  killPid: async (pid: number): Promise<ScriptKillPidResult> =>
    getRendererRpcClient().request<ScriptKillPidResult>('scriptOps.killPid', { pid }),
  kill: async (worktreeId: string): Promise<ScriptKillResult> =>
    getRendererRpcClient().request<ScriptKillResult>('scriptOps.kill', { worktreeId }),
  onOutput: (channel: string, callback: (event: ScriptOutputEvent) => void): (() => void) =>
    getRendererRpcClient().subscribe(channel, (event: ServerEvent) => {
      if (isScriptOutputEvent(event.payload)) {
        callback(event.payload)
      }
    })
}
