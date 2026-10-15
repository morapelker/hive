import { getRendererRpcClient } from './rpc-client'

/**
 * Performance logging (Settings → Advanced). The RPC domain keeps its historical name
 * (`perfDiagnosticsOps`); records land in `~/.hive/logs/perf/perf-<process>.jsonl`.
 */

export type PerfProcessRole = 'server' | 'electron-main' | 'renderer'

export interface PerfLoggerStatus {
  enabled: boolean
  role: PerfProcessRole
  pid: number
  logDir: string
  filePath: string | null
  startedAt: string | null
  samples: number
  alerts: number
  captures: string[]
}

export interface PerfLoggingStatus {
  server: PerfLoggerStatus
  logDir: string
  files: Array<{ name: string; bytes: number; modifiedAt: string }>
}

export interface PerfCaptureResult {
  files: string[]
}

/** Kept for older callers; `getStatus` is the same call. */
export type PerfDiagnosticsSnapshot = PerfLoggingStatus

export const perfDiagnosticsApi = {
  enable: async (enabled: boolean): Promise<void> =>
    getRendererRpcClient().request<void>('perfDiagnosticsOps.enable', { enabled }),

  getSnapshot: async (): Promise<PerfLoggingStatus> =>
    getRendererRpcClient().request<PerfLoggingStatus>('perfDiagnosticsOps.getSnapshot', {}),

  getStatus: async (): Promise<PerfLoggingStatus> =>
    getRendererRpcClient().request<PerfLoggingStatus>('perfDiagnosticsOps.getStatus', {}),

  appendRecords: async (
    role: PerfProcessRole,
    records: Array<Record<string, unknown>>
  ): Promise<void> =>
    getRendererRpcClient().request<void>('perfDiagnosticsOps.appendRecords', { role, records }),

  captureNow: async (reason: string): Promise<PerfCaptureResult> =>
    getRendererRpcClient().request<PerfCaptureResult>('perfDiagnosticsOps.captureNow', { reason })
}
