import { getRendererRpcClient } from './rpc-client'

export interface PerfDiagnosticsSnapshot {
  perfVersion: string
  timestamp: string
  uptimeMs: number
  cpu: { userMs: number; systemMs: number; percentSinceLastSample: number }
  memory: {
    rss: number
    heapUsed: number
    heapTotal: number
    external: number
    arrayBuffers: number
    nativeEstimate: number
  }
  heap: {
    sizeLimit: number
    totalPhysical: number
    mallocedMemory: number
    numberOfGcContexts: number
  }
  processes: {
    ptyActive: number
    scriptsActive: number
    scriptsTotalOpened: number
    scriptsTotalClosed: number
  }
  watchers: { fileTree: number; worktree: number; branch: number }
  sessions: { active: number }
  handles: { active: number; requests: number; byType: Record<string, number> }
  electron: { windows: number; webContents: number }
  eventLoopLagMs: number
}

export const perfDiagnosticsApi = {
  enable: async (enabled: boolean): Promise<void> =>
    getRendererRpcClient().request<void>('perfDiagnosticsOps.enable', { enabled }),

  getSnapshot: async (): Promise<PerfDiagnosticsSnapshot> =>
    getRendererRpcClient().request<PerfDiagnosticsSnapshot>('perfDiagnosticsOps.getSnapshot', {})
}
