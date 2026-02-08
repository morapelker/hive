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
  kill: () => void
}

interface RunAndWaitResult {
  success: boolean
  output: string
  error?: string
}

interface ScriptEvent {
  type: 'command-start' | 'output' | 'error' | 'done'
  command?: string
  data?: string
  exitCode?: number
}

export class ScriptRunner {
  private mainWindow: BrowserWindow | null = null
  private runningProcesses: Map<string, ChildProcess> = new Map()

  setMainWindow(window: BrowserWindow): void {
    this.mainWindow = window
  }

  private sendEvent(eventKey: string, event: ScriptEvent): void {
    if (!this.mainWindow || this.mainWindow.isDestroyed()) return
    this.mainWindow.webContents.send(eventKey, event)
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
    eventKey: string
  ): Promise<SequentialResult> {
    const parsed = this.parseCommands(commands)
    log.info('runSequential starting', { commandCount: parsed.length, cwd, eventKey })

    for (const command of parsed) {
      this.sendEvent(eventKey, { type: 'command-start', command })

      const result = await this.execCommand(command, cwd, eventKey)

      if (result.exitCode !== 0) {
        this.sendEvent(eventKey, { type: 'error', command, exitCode: result.exitCode })
        log.warn('runSequential command failed', { command, exitCode: result.exitCode })
        return { success: false, error: `Command "${command}" exited with code ${result.exitCode}` }
      }
    }

    this.sendEvent(eventKey, { type: 'done' })
    log.info('runSequential completed successfully', { eventKey })
    return { success: true }
  }

  private execCommand(
    command: string,
    cwd: string,
    eventKey: string
  ): Promise<{ exitCode: number }> {
    return new Promise((resolve) => {
      const proc = spawn('sh', ['-c', command], {
        cwd,
        env: process.env,
        stdio: ['ignore', 'pipe', 'pipe']
      })

      // Track process for cleanup
      this.runningProcesses.set(eventKey, proc)

      proc.stdout?.on('data', (chunk: Buffer) => {
        this.sendEvent(eventKey, { type: 'output', data: chunk.toString() })
      })

      proc.stderr?.on('data', (chunk: Buffer) => {
        this.sendEvent(eventKey, { type: 'output', data: chunk.toString() })
      })

      proc.on('error', (err) => {
        log.error('Process spawn error', { command, error: err.message })
        this.runningProcesses.delete(eventKey)
        resolve({ exitCode: 1 })
      })

      proc.on('close', (code) => {
        this.runningProcesses.delete(eventKey)
        resolve({ exitCode: code ?? 1 })
      })
    })
  }

  runPersistent(commands: string[], cwd: string, eventKey: string): PersistentHandle {
    const parsed = this.parseCommands(commands)
    const combined = parsed.join(' && ')
    log.info('runPersistent starting', { commandCount: parsed.length, cwd, eventKey })

    const proc = spawn('sh', ['-c', combined], {
      cwd,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: false
    })

    this.runningProcesses.set(eventKey, proc)

    proc.stdout?.on('data', (chunk: Buffer) => {
      this.sendEvent(eventKey, { type: 'output', data: chunk.toString() })
    })

    proc.stderr?.on('data', (chunk: Buffer) => {
      this.sendEvent(eventKey, { type: 'output', data: chunk.toString() })
    })

    proc.on('error', (err) => {
      log.error('Persistent process error', { eventKey, error: err.message })
      this.sendEvent(eventKey, { type: 'error', exitCode: 1 })
      this.runningProcesses.delete(eventKey)
    })

    proc.on('close', (code) => {
      log.info('Persistent process exited', { eventKey, code })
      if (code === 0) {
        this.sendEvent(eventKey, { type: 'done' })
      } else {
        this.sendEvent(eventKey, { type: 'error', exitCode: code ?? 1 })
      }
      this.runningProcesses.delete(eventKey)
    })

    const kill = (): void => {
      this.killProcess(eventKey)
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

      const proc = spawn('sh', ['-c', command], {
        cwd,
        env: process.env,
        stdio: ['ignore', 'pipe', 'pipe']
      })

      const timer = setTimeout(() => {
        if (!settled) {
          settled = true
          proc.kill('SIGTERM')
          setTimeout(() => {
            try { proc.kill('SIGKILL') } catch { /* already dead */ }
          }, 500)
          resolve({ success: false, output, error: `Command "${command}" timed out after ${timeout}ms` })
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
          resolve({ success: false, output, error: err.message })
        }
      })

      proc.on('close', (code) => {
        if (!settled) {
          settled = true
          clearTimeout(timer)
          if (code === 0) {
            resolve({ success: true, output })
          } else {
            resolve({ success: false, output, error: `Command "${command}" exited with code ${code}` })
          }
        }
      })
    })
  }

  killProcess(eventKey: string): void {
    const proc = this.runningProcesses.get(eventKey)
    if (!proc) {
      log.warn('killProcess: no process found', { eventKey })
      return
    }

    log.info('killProcess: sending SIGTERM', { eventKey, pid: proc.pid })
    try {
      proc.kill('SIGTERM')
    } catch {
      // already dead
    }

    // If still alive after 500ms, force kill
    setTimeout(() => {
      if (this.runningProcesses.has(eventKey)) {
        log.info('killProcess: sending SIGKILL', { eventKey })
        try {
          proc.kill('SIGKILL')
        } catch {
          // already dead
        }
        this.runningProcesses.delete(eventKey)
      }
    }, 500)
  }

  killAll(): void {
    log.info('killAll: cleaning up all running processes', { count: this.runningProcesses.size })
    for (const [key, proc] of this.runningProcesses) {
      log.info('killAll: killing process', { key, pid: proc.pid })
      try {
        proc.kill('SIGTERM')
      } catch {
        // already dead
      }
    }
    this.runningProcesses.clear()
  }
}

export const scriptRunner = new ScriptRunner()
