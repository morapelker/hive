import { BASH_STREAM_CHANNEL } from '@shared/bash-events'
import type { ServerEvent } from '@shared/rpc/protocol'
import type { Envelope } from '@shared/types/ipc-envelope'
import { getRendererRpcClient } from './rpc-client'

export type BashRunStatus = 'running' | 'exited' | 'killed' | 'truncated' | 'error'

export interface BashRunSnapshot {
  readonly sessionId: string
  readonly id: string
  readonly command: string
  readonly cwd: string
  readonly startedAt: number
  readonly status: BashRunStatus
  readonly outputBuffer: string
  readonly outputBytes: number
  readonly exitCode?: number
}

export interface BashRunResult {
  readonly runId: string
}

export type BashStreamEvent =
  | {
      readonly type: 'start'
      readonly sessionId: string
      readonly runId: string
      readonly command: string
      readonly cwd: string
      readonly startedAt: number
    }
  | {
      readonly type: 'output'
      readonly sessionId: string
      readonly runId: string
      readonly data: string
    }
  | {
      readonly type: 'end'
      readonly sessionId: string
      readonly runId: string
      readonly status: 'exited' | 'killed' | 'truncated' | 'error'
      readonly exitCode?: number
    }

const isBashStreamEvent = (value: unknown): value is BashStreamEvent => {
  if (typeof value !== 'object' || value === null) return false
  if (!('type' in value) || typeof value.type !== 'string') return false
  if (!('sessionId' in value) || typeof value.sessionId !== 'string') return false
  if (!('runId' in value) || typeof value.runId !== 'string') return false

  if (value.type === 'start') {
    return (
      'command' in value &&
      typeof value.command === 'string' &&
      'cwd' in value &&
      typeof value.cwd === 'string' &&
      'startedAt' in value &&
      typeof value.startedAt === 'number'
    )
  }

  if (value.type === 'output') {
    return 'data' in value && typeof value.data === 'string'
  }

  if (value.type === 'end') {
    return (
      'status' in value &&
      typeof value.status === 'string' &&
      ['exited', 'killed', 'truncated', 'error'].includes(value.status) &&
      (!('exitCode' in value) || typeof value.exitCode === 'number')
    )
  }

  return false
}

const toEnvelope = async <A>(request: Promise<A>): Promise<Envelope<A>> => {
  try {
    return { success: true, value: await request }
  } catch (cause) {
    const error = cause instanceof Error ? cause : new Error(String(cause))
    const maybeDetails = error as Error & { details?: unknown }
    return {
      success: false,
      errorCode: error.name || 'INTERNAL_ERROR',
      error: error.message,
      ...(maybeDetails.details === undefined ? {} : { details: maybeDetails.details })
    }
  }
}

export const bashApi = {
  run: (sessionId: string, command: string, cwd: string): Promise<Envelope<BashRunResult>> =>
    toEnvelope(
      getRendererRpcClient().request<BashRunResult>('bash.run', { sessionId, command, cwd })
    ),
  abort: (sessionId: string): Promise<Envelope<boolean>> =>
    toEnvelope(getRendererRpcClient().request<boolean>('bash.abort', { sessionId })),
  getRun: async (sessionId: string): Promise<BashRunSnapshot | null> =>
    getRendererRpcClient().request<BashRunSnapshot | null>('bash.getRun', { sessionId }),
  onStream: (callback: (event: BashStreamEvent) => void): (() => void) =>
    getRendererRpcClient().subscribe(BASH_STREAM_CHANNEL, (event: ServerEvent) => {
      if (isBashStreamEvent(event.payload)) callback(event.payload)
    })
}
