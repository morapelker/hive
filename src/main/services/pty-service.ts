import * as pty from 'node-pty'
import { createLogger } from './logger'

const log = createLogger({ component: 'PtyService' })

/**
 * Terminal backend type.
 * - 'node-pty': Uses node-pty + xterm.js for terminal emulation (cross-platform)
 * - 'ghostty': Uses the native Ghostty module for Metal-rendered terminals (macOS only)
 *
 * When using the 'ghostty' backend, the native module handles both the PTY and
 * the terminal rendering. The PtyService is not used for I/O in that case —
 * surface lifecycle is managed entirely through GhosttyService.
 */
export type TerminalBackend = 'node-pty' | 'ghostty'

interface PtyInstance {
  pty: pty.IPty
  cwd: string
  backend: TerminalBackend
  dataListener: ((data: string) => void) | null
  exitListener: ((code: number, signal: number) => void) | null
  /** Debug: track listener registration order */
  listenerRegLog: string[]
}

export interface PtyCreateOpts {
  cwd: string
  shell?: string
  env?: Record<string, string>
  cols?: number
  rows?: number
  backend?: TerminalBackend
}

class PtyService {
  private ptys: Map<string, PtyInstance> = new Map()

  create(id: string, opts: PtyCreateOpts): { cols: number; rows: number } {
    // If using the ghostty backend, the native module handles the PTY internally.
    // We don't create a node-pty process — surface lifecycle is managed by GhosttyService.
    if (opts.backend === 'ghostty') {
      log.info('Skipping node-pty creation for ghostty backend', { id })
      return { cols: opts.cols || 80, rows: opts.rows || 24 }
    }

    // If a PTY already exists for this id, return its dimensions
    const existing = this.ptys.get(id)
    if (existing) {
      log.info('PTY already exists, reusing', { id })
      return {
        cols: existing.pty.cols,
        rows: existing.pty.rows
      }
    }

    const shell =
      opts.shell ||
      process.env.SHELL ||
      (process.platform === 'win32'
        ? 'powershell.exe'
        : process.platform === 'darwin'
          ? '/bin/zsh'
          : '/bin/bash')
    const cols = opts.cols || 80
    const rows = opts.rows || 24

    const env: Record<string, string> = {
      ...process.env,
      TERM: 'xterm-256color',
      COLORTERM: 'truecolor',
      ...opts.env
    } as Record<string, string>

    log.info('Creating PTY', { id, shell, cwd: opts.cwd, cols, rows })

    const ptyProcess = pty.spawn(shell, [], {
      name: 'xterm-256color',
      cols,
      rows,
      cwd: opts.cwd,
      env
    })

    const instance: PtyInstance = {
      pty: ptyProcess,
      cwd: opts.cwd,
      backend: opts.backend || 'node-pty',
      dataListener: null,
      exitListener: null,
      listenerRegLog: []
    }

    // Wire up data events
    ptyProcess.onData((data) => {
      if (instance.dataListener) {
        try {
          instance.dataListener(data)
        } catch (err) {
          log.error(
            'Error in PTY data listener',
            err instanceof Error ? err : new Error(String(err)),
            { id }
          )
        }
      }
    })

    // Wire up exit events
    ptyProcess.onExit(({ exitCode, signal }) => {
      const code = exitCode ?? -1
      const sig = signal ?? 0
      log.info('PTY exited', { id, exitCode: code, signal: sig })
      if (instance.exitListener) {
        try {
          instance.exitListener(code, sig)
        } catch (err) {
          log.error(
            'Error in PTY exit listener',
            err instanceof Error ? err : new Error(String(err)),
            { id }
          )
        }
      }
      this.ptys.delete(id)
    })

    this.ptys.set(id, instance)

    return { cols, rows }
  }

  write(id: string, data: string): void {
    const instance = this.ptys.get(id)
    if (!instance) {
      log.warn('PTY not found for write', { id })
      return
    }
    instance.pty.write(data)
  }

  resize(id: string, cols: number, rows: number): void {
    const instance = this.ptys.get(id)
    if (!instance) {
      log.warn('PTY not found for resize', { id })
      return
    }
    try {
      instance.pty.resize(cols, rows)
    } catch (err) {
      log.error('Error resizing PTY', err instanceof Error ? err : new Error(String(err)), {
        id,
        cols,
        rows
      })
    }
  }

  destroy(id: string): void {
    const instance = this.ptys.get(id)
    if (!instance) {
      log.warn('PTY not found for destroy', { id })
      return
    }
    log.info('Destroying PTY', { id })
    try {
      instance.pty.kill()
    } catch (err) {
      log.error('Error killing PTY', err instanceof Error ? err : new Error(String(err)), { id })
    }
    this.ptys.delete(id)
  }

  destroyAll(): void {
    log.info('Destroying all PTYs', { count: this.ptys.size })
    for (const [id] of this.ptys) {
      this.destroy(id)
    }
  }

  onData(id: string, callback: (data: string) => void): () => void {
    const instance = this.ptys.get(id)
    if (!instance) {
      log.warn('PTY not found for onData', { id })
      return () => {}
    }
    const stack = new Error().stack?.split('\n')[2]?.trim() || 'unknown'
    const regId = `[reg_${Date.now()}_${Math.random().toString(36).substr(2, 4)}]`
    instance.listenerRegLog.push(`${regId} REGISTER onData, hadPrevious=${instance.dataListener !== null}, caller=${stack}`)
    log.info(`[PTY onData REGISTER] id=${id} ${regId} hadPrevious=${instance.dataListener !== null} caller=${stack}`)
    instance.dataListener = callback
    return () => {
      if (instance.dataListener === callback) {
        instance.dataListener = null
        log.info(`[PTY onData REMOVE] id=${id} ${regId} cleared`)
        instance.listenerRegLog.push(`${regId} REMOVE onData`)
      } else {
        log.warn(`[PTY onData REMOVE] id=${id} ${regId} callback already replaced`)
      }
    }
  }

  onExit(id: string, callback: (code: number, signal: number) => void): () => void {
    const instance = this.ptys.get(id)
    if (!instance) {
      log.warn('PTY not found for onExit', { id })
      return () => {}
    }
    log.info(`[PTY onExit REGISTER] id=${id} hadPrevious=${instance.exitListener !== null}`)
    instance.exitListener = callback
    return () => {
      if (instance.exitListener === callback) {
        instance.exitListener = null
        log.info(`[PTY onExit REMOVE] id=${id} cleared`)
      }
    }
  }

  /**
   * Get an existing PTY or create a new one. Alias for `create()` which
   * already returns existing PTY dimensions if one exists for this id.
   */
  getOrCreate(id: string, opts: PtyCreateOpts): { cols: number; rows: number } {
    return this.create(id, opts)
  }

  has(id: string): boolean {
    return this.ptys.has(id)
  }

  /** Debug: get listener stats for a PTY */
  getListenerStats(id: string): { hasDataListener: boolean; hasExitListener: boolean; log: string[] } | null {
    const instance = this.ptys.get(id)
    if (!instance) return null
    return {
      hasDataListener: instance.dataListener !== null,
      hasExitListener: instance.exitListener !== null,
      log: instance.listenerRegLog.slice(-10) // last 10 entries
    }
  }

  getBackend(id: string): TerminalBackend | undefined {
    return this.ptys.get(id)?.backend
  }

  getIds(): string[] {
    return Array.from(this.ptys.keys())
  }

  /**
   * Destroy all PTYs whose IDs are NOT in the given set of valid IDs.
   * Useful for cleaning up terminals when worktrees are deleted.
   */
  destroyExcept(validIds: Set<string>): void {
    for (const [id] of this.ptys) {
      if (!validIds.has(id)) {
        log.info('Destroying orphaned PTY', { id })
        this.destroy(id)
      }
    }
  }
}

export const ptyService = new PtyService()
