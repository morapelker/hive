import { spawn, ChildProcess } from 'child_process'
import { BrowserWindow } from 'electron'
import { createLogger } from './logger'

const log = createLogger({ component: 'ScriptRunner' })

interface SequentialResult {
  success: boolean
  error?: string
}

interface PersistentHandle {
  pid: number
  kill: () => Promise<void>
}

interface RunAndWaitResult {
  success: boolean
  output: string
  error?: string
}

interface ScriptEvent {
  type: 'command-start' | 'output' | 'error' | 'done' | 'long-running'
  command?: string
  data?: string
  exitCode?: number
  elapsed?: number  // For long-running events
}

function getColorEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    FORCE_COLOR: '3',
    TERM: 'xterm-256color',
    COLORTERM: 'truecolor'
  }
}

export class ScriptRunner {
  private mainWindow: BrowserWindow | null = null
  private runningProcesses: Map<string, ChildProcess> = new Map()
  private outputBuffers: Map<string, string> = new Map()
  private outputFlushTimers: Map<string, NodeJS.Timeout> = new Map()

  private static readonly OUTPUT_FLUSH_MS = 16

  private isCurrentProcess(eventKey: string, proc: ChildProcess): boolean {
    return this.runningProcesses.get(eventKey) === proc
  }

  private clearCurrentProcess(eventKey: string, proc: ChildProcess): void {
    if (this.isCurrentProcess(eventKey, proc)) {
      this.runningProcesses.delete(eventKey)
      this.clearBufferedOutput(eventKey)
    }
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

  setMainWindow(window: BrowserWindow): void {
    this.mainWindow = window
  }

  private sendEvent(eventKey: string, event: ScriptEvent): void {
    if (!this.mainWindow || this.mainWindow.isDestroyed()) return
    this.mainWindow.webContents.send(eventKey, event)
  }

  private scheduleOutputFlush(eventKey: string): void {
    if (this.outputFlushTimers.has(eventKey)) return

    const timer = setTimeout(() => {
      this.outputFlushTimers.delete(eventKey)
      this.flushOutputBuffer(eventKey)
    }, ScriptRunner.OUTPUT_FLUSH_MS)

    this.outputFlushTimers.set(eventKey, timer)
  }

  private queueOutput(eventKey: string, data: string): void {
    const existing = this.outputBuffers.get(eventKey)
    this.outputBuffers.set(eventKey, existing ? existing + data : data)
    this.scheduleOutputFlush(eventKey)
  }

  private flushOutputBuffer(eventKey: string): void {
    const buffered = this.outputBuffers.get(eventKey)
    if (!buffered) return

    this.outputBuffers.delete(eventKey)
    this.sendEvent(eventKey, { type: 'output', data: buffered })
  }

  private clearBufferedOutput(eventKey: string): void {
    const timer = this.outputFlushTimers.get(eventKey)
    if (timer) {
      clearTimeout(timer)
      this.outputFlushTimers.delete(eventKey)
    }
    this.outputBuffers.delete(eventKey)
  }

  private parseCommands(commands: string[]): string[] {
    return commands
      .flatMap((cmd) => cmd.split('\n'))
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith('#'))
  }

  async runSequential(
    commands: string[],
    cwd: string,
    eventKey: string,
    extraEnv?: Record<string, string>
  ): Promise<SequentialResult> {
    const parsed = this.parseCommands(commands)
    log.info('runSequential starting', { commandCount: parsed.length, cwd, eventKey })

    for (const command of parsed) {
      this.sendEvent(eventKey, { type: 'command-start', command })

      const result = await this.execCommand(command, cwd, eventKey, extraEnv)

      if (result.exitCode !== 0) {
        this.flushOutputBuffer(eventKey)
        this.sendEvent(eventKey, { type: 'error', command, exitCode: result.exitCode })
        log.warn('runSequential command failed', { command, exitCode: result.exitCode })
        return { success: false, error: `Command "${command}" exited with code ${result.exitCode}` }
      }
    }

    this.flushOutputBuffer(eventKey)
    this.sendEvent(eventKey, { type: 'done' })
    log.info('runSequential completed successfully', { eventKey })
    return { success: true }
  }

  private execCommand(
    command: string,
    cwd: string,
    eventKey: string,
    extraEnv?: Record<string, string>
  ): Promise<{ exitCode: number }> {
    return new Promise((resolve) => {
      let settled = false
      let notificationSent = false

      const proc = spawn('sh', ['-c', command], {
        cwd,
        env: { ...getColorEnv(), ...extraEnv },
        stdio: ['pipe', 'pipe', 'pipe']  // Fixed: Allow piped commands to work
      })

      // Immediately close stdin to prevent hanging on commands that wait for input
      if (proc.stdin) {
        proc.stdin.end()
      }

      // Track process for cleanup
      this.runningProcesses.set(eventKey, proc)

      // Add 5-second notification timer for long-running commands
      const notificationTimer = setTimeout(() => {
        if (!settled && !notificationSent) {
          notificationSent = true
          log.info('Command is taking longer than expected', {
            command,
            elapsed: 5000,
            eventKey
          })
          // Send dedicated long-running event (not mixed with output)
          this.sendEvent(eventKey, {
            type: 'long-running',
            command,
            elapsed: 5000
          })
        }
      }, 5000)

      proc.stdout?.on('data', (chunk: Buffer) => {
        this.queueOutput(eventKey, chunk.toString())
      })

      proc.stderr?.on('data', (chunk: Buffer) => {
        this.queueOutput(eventKey, chunk.toString())
      })

      proc.on('error', (err) => {
        if (!settled) {
          settled = true
          clearTimeout(notificationTimer)
        }
        log.error('Process spawn error', err, { command })
        this.flushOutputBuffer(eventKey)
        this.clearCurrentProcess(eventKey, proc)
        resolve({ exitCode: 1 })
      })

      proc.on('close', (code) => {
        if (!settled) {
          settled = true
          clearTimeout(notificationTimer)
        }
        this.flushOutputBuffer(eventKey)
        this.clearCurrentProcess(eventKey, proc)
        resolve({ exitCode: code ?? 1 })
      })
    })
  }

  async runPersistent(
    commands: string[],
    cwd: string,
    eventKey: string,
    extraEnv?: Record<string, string>
  ): Promise<PersistentHandle> {
    if (this.runningProcesses.has(eventKey)) {
      log.warn('runPersistent: process already running for key, killing it first', { eventKey })
      await this.killProcess(eventKey)
    }

    const parsed = this.parseCommands(commands)
    const combined = parsed.join(' && ')
    log.info('runPersistent starting', { commandCount: parsed.length, cwd, eventKey })

    const proc = spawn('sh', ['-c', combined], {
      cwd,
      env: { ...getColorEnv(), ...extraEnv },
      stdio: ['pipe', 'pipe', 'pipe'],  // Fixed: Allow piped commands to work
      detached: process.platform !== 'win32'
    })

    // Immediately close stdin to prevent hanging on commands that wait for input
    if (proc.stdin) {
      proc.stdin.end()
    }

    this.runningProcesses.set(eventKey, proc)

    proc.stdout?.on('data', (chunk: Buffer) => {
      this.queueOutput(eventKey, chunk.toString())
    })

    proc.stderr?.on('data', (chunk: Buffer) => {
      this.queueOutput(eventKey, chunk.toString())
    })

    proc.on('error', (err) => {
      if (!this.isCurrentProcess(eventKey, proc)) return
      log.error('Persistent process error', err, { eventKey })
      this.flushOutputBuffer(eventKey)
      this.sendEvent(eventKey, { type: 'error', exitCode: 1 })
      this.clearCurrentProcess(eventKey, proc)
    })

    proc.on('close', (code) => {
      if (!this.isCurrentProcess(eventKey, proc)) return
      log.info('Persistent process exited', { eventKey, code })
      this.flushOutputBuffer(eventKey)
      if (code === 0) {
        this.sendEvent(eventKey, { type: 'done' })
      } else {
        this.sendEvent(eventKey, { type: 'error', exitCode: code ?? 1 })
      }
      this.clearCurrentProcess(eventKey, proc)
    })

    const kill = async (): Promise<void> => {
      await this.killProcess(eventKey)
    }

    return { pid: proc.pid ?? -1, kill }
  }

  async runAndWait(
    commands: string[],
    cwd: string,
    timeout: number = 30000
  ): Promise<RunAndWaitResult> {
    const parsed = this.parseCommands(commands)
    log.info('runAndWait starting', { commandCount: parsed.length, cwd, timeout })

    let combinedOutput = ''

    for (const command of parsed) {
      const result = await this.execCommandWithCapture(command, cwd, timeout)
      combinedOutput += result.output

      if (!result.success) {
        log.warn('runAndWait command failed', { command, error: result.error })
        return { success: false, output: combinedOutput, error: result.error }
      }
    }

    log.info('runAndWait completed successfully')
    return { success: true, output: combinedOutput }
  }

  private execCommandWithCapture(
    command: string,
    cwd: string,
    timeout: number
  ): Promise<{ success: boolean; output: string; error?: string }> {
    return new Promise((resolve) => {
      let output = ''
      let settled = false
      let notificationSent = false

      const proc = spawn('sh', ['-c', command], {
        cwd,
        env: getColorEnv(),
        stdio: ['pipe', 'pipe', 'pipe']  // Fixed: Allow piped commands to work
      })

      // Immediately close stdin to prevent hanging on commands that wait for input
      if (proc.stdin) {
        proc.stdin.end()
      }

      // Add 5-second notification timer for long-running commands
      const notificationTimer = setTimeout(() => {
        if (!settled && !notificationSent) {
          notificationSent = true
          // Just log for this method since we can't emit events without eventKey
          log.info('Command is taking longer than expected (execCommandWithCapture)', {
            command,
            elapsed: 5000,
            cwd
          })
        }
      }, 5000)

      const timer = setTimeout(() => {
        if (!settled) {
          settled = true
          clearTimeout(notificationTimer)
          proc.kill('SIGTERM')
          setTimeout(() => {
            try {
              proc.kill('SIGKILL')
            } catch {
              /* already dead */
            }
          }, 500)
          resolve({
            success: false,
            output,
            error: `Command "${command}" timed out after ${timeout}ms`
          })
        }
      }, timeout)

      proc.stdout?.on('data', (chunk: Buffer) => {
        output += chunk.toString()
      })

      proc.stderr?.on('data', (chunk: Buffer) => {
        output += chunk.toString()
      })

      proc.on('error', (err) => {
        if (!settled) {
          settled = true
          clearTimeout(timer)
          clearTimeout(notificationTimer)
          resolve({ success: false, output, error: err.message })
        }
      })

      proc.on('close', (code) => {
        if (!settled) {
          settled = true
          clearTimeout(timer)
          clearTimeout(notificationTimer)
          if (code === 0) {
            resolve({ success: true, output })
          } else {
            resolve({
              success: false,
              output,
              error: `Command "${command}" exited with code ${code}`
            })
          }
        }
      })
    })
  }

  async killProcess(eventKey: string): Promise<boolean> {
    const proc = this.runningProcesses.get(eventKey)
    if (!proc) {
      log.warn('killProcess: no process found', { eventKey })
      return false
    }

    if (proc.exitCode !== null || proc.signalCode !== null) {
      this.flushOutputBuffer(eventKey)
      this.clearCurrentProcess(eventKey, proc)
      return true
    }

    log.info('killProcess: sending SIGTERM', { eventKey, pid: proc.pid })

    this.signalProcessTree(proc, 'SIGTERM', eventKey)
    const exitedGracefully = await this.waitForProcessExit(proc, 800)
    if (exitedGracefully) {
      this.flushOutputBuffer(eventKey)
      this.clearCurrentProcess(eventKey, proc)
      return true
    }

    log.info('killProcess: sending SIGKILL', { eventKey, pid: proc.pid })
    this.signalProcessTree(proc, 'SIGKILL', eventKey)
    const exitedAfterForceKill = await this.waitForProcessExit(proc, 2500)
    if (!exitedAfterForceKill && this.isCurrentProcess(eventKey, proc)) {
      this.flushOutputBuffer(eventKey)
      this.runningProcesses.delete(eventKey)
      this.clearBufferedOutput(eventKey)
    }

    return true
  }

  killAll(): void {
    log.info('killAll: cleaning up all running processes', { count: this.runningProcesses.size })
    for (const [key, proc] of this.runningProcesses) {
      log.info('killAll: killing process', { key, pid: proc.pid })
      this.signalProcessTree(proc, 'SIGTERM', key)
      this.clearBufferedOutput(key)
    }
    this.runningProcesses.clear()
  }
}

export const scriptRunner = new ScriptRunner()
