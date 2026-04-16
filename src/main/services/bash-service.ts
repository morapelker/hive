import { spawn, ChildProcess } from 'child_process'
import { randomUUID } from 'crypto'
import { BrowserWindow } from 'electron'
import { createLogger } from './logger'

const log = createLogger({ component: 'BashService' })

const OUTPUT_FLUSH_MS = 16
const OUTPUT_BYTES_LIMIT = 1 * 1024 * 1024 // 1 MB
const TRUNCATION_SENTINEL = '\n\n[output truncated at 1 MB — process killed]\n'

export type BashRunStatus = 'running' | 'exited' | 'killed' | 'truncated' | 'error'

interface BashRun {
  sessionId: string
  id: string
  command: string
  cwd: string
  startedAt: number
  status: BashRunStatus
  outputBuffer: string
  outputBytes: number
  exitCode?: number
  proc?: ChildProcess
  abortRequested?: boolean
}

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

function getColorEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    FORCE_COLOR: '3',
    TERM: 'xterm-256color',
    COLORTERM: 'truecolor',
    CLICOLOR_FORCE: '1'
  }
}

export class BashService {
  private mainWindow: BrowserWindow | null = null
  private runs: Map<string, BashRun> = new Map()
  private outputBuffers: Map<string, string> = new Map()
  private outputFlushTimers: Map<string, NodeJS.Timeout> = new Map()

  setMainWindow(window: BrowserWindow): void {
    this.mainWindow = window
  }

  private sendEvent(event: BashStreamEvent): void {
    if (!this.mainWindow || this.mainWindow.isDestroyed()) return
    this.mainWindow.webContents.send('bash:stream', event)
  }

  private scheduleOutputFlush(sessionId: string): void {
    if (this.outputFlushTimers.has(sessionId)) return

    const timer = setTimeout(() => {
      this.outputFlushTimers.delete(sessionId)
      this.flushOutputBuffer(sessionId)
    }, OUTPUT_FLUSH_MS)

    this.outputFlushTimers.set(sessionId, timer)
  }

  private queueOutput(sessionId: string, data: string): void {
    const existing = this.outputBuffers.get(sessionId)
    this.outputBuffers.set(sessionId, existing ? existing + data : data)
    this.scheduleOutputFlush(sessionId)
  }

  private flushOutputBuffer(sessionId: string): void {
    const buffered = this.outputBuffers.get(sessionId)
    if (!buffered) return

    this.outputBuffers.delete(sessionId)
    const run = this.runs.get(sessionId)
    if (!run) return

    this.sendEvent({
      type: 'output',
      sessionId,
      runId: run.id,
      data: buffered
    })
  }

  private clearBufferedOutput(sessionId: string): void {
    const timer = this.outputFlushTimers.get(sessionId)
    if (timer) {
      clearTimeout(timer)
      this.outputFlushTimers.delete(sessionId)
    }
    this.outputBuffers.delete(sessionId)
  }

  private async waitForProcessExit(proc: ChildProcess, timeoutMs: number): Promise<boolean> {
    if (proc.exitCode !== null || proc.signalCode !== null) {
      return true
    }

    return new Promise((resolve) => {
      let settled = false

      const cleanup = (): void => {
        proc.off('close', onExit)
        proc.off('exit', onExit)
      }

      const onExit = (): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        cleanup()
        resolve(true)
      }

      const timer = setTimeout(() => {
        if (settled) return
        settled = true
        cleanup()
        resolve(false)
      }, timeoutMs)

      proc.once('close', onExit)
      proc.once('exit', onExit)
    })
  }

  private signalProcessTree(proc: ChildProcess, signal: NodeJS.Signals, eventKey: string): void {
    const pid = proc.pid
    if (!pid) {
      try {
        proc.kill(signal)
      } catch {
        // already dead
      }
      return
    }

    if (process.platform === 'win32') {
      const args = ['/pid', String(pid), '/t']
      if (signal === 'SIGKILL') {
        args.push('/f')
      }
      const taskkill = spawn('taskkill', args, { stdio: 'ignore' })
      taskkill.on('error', () => {
        try {
          proc.kill(signal)
        } catch {
          // already dead
        }
      })
      return
    }

    try {
      // Detached processes on Unix become a process group leader; negative PID
      // targets the full tree so child dev servers are terminated too.
      process.kill(-pid, signal)
    } catch {
      log.warn('Failed to signal process group; falling back to direct process kill', {
        eventKey,
        pid,
        signal
      })
      try {
        proc.kill(signal)
      } catch {
        // already dead
      }
    }
  }

  private appendOutput(run: BashRun, chunk: string): void {
    if (run.status === 'truncated') {
      // Already truncated — drop the chunk entirely.
      return
    }

    const chunkBytes = Buffer.byteLength(chunk, 'utf-8')
    const remaining = OUTPUT_BYTES_LIMIT - run.outputBytes
    if (chunkBytes <= remaining) {
      run.outputBuffer += chunk
      run.outputBytes += chunkBytes
      this.queueOutput(run.sessionId, chunk)
      return
    }

    // Append only enough to reach exactly 1 MB, then add the truncation sentinel
    // and kill the process tree.
    const allowed = remaining > 0 ? Buffer.from(chunk, 'utf-8').subarray(0, remaining).toString('utf-8') : ''
    if (allowed.length > 0) {
      run.outputBuffer += allowed
      run.outputBytes += Buffer.byteLength(allowed, 'utf-8')
      this.queueOutput(run.sessionId, allowed)
    }

    run.outputBuffer += TRUNCATION_SENTINEL
    run.outputBytes += Buffer.byteLength(TRUNCATION_SENTINEL, 'utf-8')
    this.queueOutput(run.sessionId, TRUNCATION_SENTINEL)

    run.status = 'truncated'
    run.abortRequested = true

    if (run.proc) {
      log.info('Output cap reached, killing process tree', {
        sessionId: run.sessionId,
        runId: run.id,
        pid: run.proc.pid
      })
      this.signalProcessTree(run.proc, 'SIGKILL', run.sessionId)
    }
  }

  async run(
    sessionId: string,
    command: string,
    cwd: string
  ): Promise<{ runId: string }> {
    const existing = this.runs.get(sessionId)
    if (existing && existing.status === 'running') {
      throw new Error(
        `A bash command is already running for session ${sessionId}`
      )
    }

    // A new run replaces any prior completed run for this session.
    this.clearBufferedOutput(sessionId)

    const runId = randomUUID()
    const startedAt = Date.now()

    const proc = spawn('sh', ['-c', command], {
      cwd,
      env: getColorEnv(),
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: process.platform !== 'win32'
    })

    proc.stdin?.end()

    const run: BashRun = {
      sessionId,
      id: runId,
      command,
      cwd,
      startedAt,
      status: 'running',
      outputBuffer: '',
      outputBytes: 0,
      proc
    }
    this.runs.set(sessionId, run)

    log.info('Bash run started', { sessionId, runId, command, cwd, pid: proc.pid })

    this.sendEvent({
      type: 'start',
      sessionId,
      runId,
      command,
      cwd,
      startedAt
    })

    proc.stdout?.on('data', (chunk: Buffer) => {
      this.appendOutput(run, chunk.toString())
    })

    proc.stderr?.on('data', (chunk: Buffer) => {
      this.appendOutput(run, chunk.toString())
    })

    let finalized = false

    proc.on('error', (err) => {
      if (finalized) return
      finalized = true

      log.error('Bash process spawn error', err, { sessionId, runId, command })

      const message = err.message ?? String(err)
      // Use appendOutput so the buffer cap is still respected.
      this.appendOutput(run, message)
      run.status = 'error'
      // Detach proc handle and clear timer state.
      run.proc = undefined

      this.flushOutputBuffer(sessionId)
      this.clearBufferedOutput(sessionId)

      this.sendEvent({
        type: 'end',
        sessionId,
        runId,
        status: 'error',
        exitCode: run.exitCode
      })
    })

    proc.on('close', (code) => {
      if (finalized) return
      finalized = true

      // Determine final status.
      let finalStatus: 'exited' | 'killed' | 'truncated' = 'exited'
      if (run.status === 'truncated') {
        finalStatus = 'truncated'
      } else if (run.abortRequested) {
        finalStatus = 'killed'
      }

      run.status = finalStatus
      run.exitCode = code ?? undefined
      run.proc = undefined

      this.flushOutputBuffer(sessionId)
      this.clearBufferedOutput(sessionId)

      log.info('Bash run finished', {
        sessionId,
        runId,
        status: finalStatus,
        exitCode: run.exitCode
      })

      this.sendEvent({
        type: 'end',
        sessionId,
        runId,
        status: finalStatus,
        exitCode: run.exitCode
      })
    })

    return { runId }
  }

  async abort(sessionId: string): Promise<boolean> {
    const run = this.runs.get(sessionId)
    if (!run) return false
    if (run.status !== 'running') return false
    if (!run.proc) return false

    log.info('Bash abort requested', {
      sessionId,
      runId: run.id,
      pid: run.proc.pid
    })

    run.abortRequested = true
    this.signalProcessTree(run.proc, 'SIGTERM', sessionId)

    const exitedGracefully = await this.waitForProcessExit(run.proc, 2000)
    if (!exitedGracefully && run.proc) {
      log.info('Bash abort: SIGTERM grace expired, sending SIGKILL', {
        sessionId,
        runId: run.id,
        pid: run.proc.pid
      })
      this.signalProcessTree(run.proc, 'SIGKILL', sessionId)
    }

    return true
  }

  getRun(sessionId: string): BashRunSnapshot | null {
    const run = this.runs.get(sessionId)
    if (!run) return null
    return {
      sessionId: run.sessionId,
      id: run.id,
      command: run.command,
      cwd: run.cwd,
      startedAt: run.startedAt,
      status: run.status,
      outputBuffer: run.outputBuffer,
      outputBytes: run.outputBytes,
      exitCode: run.exitCode
    }
  }

  killAll(): void {
    log.info('killAll: cleaning up all running bash runs', { count: this.runs.size })
    for (const [sessionId, run] of this.runs) {
      if (run.proc && run.status === 'running') {
        log.info('killAll: killing run', { sessionId, runId: run.id, pid: run.proc.pid })
        run.abortRequested = true
        this.signalProcessTree(run.proc, 'SIGKILL', sessionId)
      }
      this.clearBufferedOutput(sessionId)
    }
    this.runs.clear()
  }
}

export const bashService = new BashService()
