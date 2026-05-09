export type BashRunStatus = 'running' | 'exited' | 'killed' | 'truncated' | 'error'

export interface BashRunSnapshot {
  sessionId: string
  id: string
  command: string
  cwd: string
  startedAt: number
  status: BashRunStatus
  outputBuffer: string
  outputBytes: number
  exitCode?: number
}

export type BashStreamEvent =
  | {
      type: 'start'
      sessionId: string
      runId: string
      command: string
      cwd: string
      startedAt: number
    }
  | {
      type: 'output'
      sessionId: string
      runId: string
      data: string
    }
  | {
      type: 'end'
      sessionId: string
      runId: string
      status: 'exited' | 'killed' | 'truncated' | 'error'
      exitCode?: number
    }
