import { execFileSync } from 'node:child_process'
import { closeSync, constants, mkdirSync, openSync } from 'node:fs'
import { join } from 'node:path'
import { createLogger } from './logger'
import { ptyService } from './pty-service'
import { SHELL_COMMAND_RUN_FILES } from './shell-command-paths'
import type { ShellCommandRunHost, ShellCommandRunHostOptions } from './shell-command-run-host'
import { buildShellCommandPtySpawn } from './shell-command-spawner'

const log = createLogger({ component: 'ShellCommandInAppHost' })

/**
 * A shell-command run as a node-pty child of this process (ptyService), registered
 * under the session id so the existing terminal write / resize / destroy commands reach
 * it. The run dies with the app; the registry marks it 'interrupted' on quit.
 *
 * While the run lives this host holds the run's FIFO open, which is what lets another
 * app instance sharing the database tell "still owned" from "owner gone"
 * (runHasLiveOwner). Nothing is ever read from or written to that fd.
 */
export function createInAppRunHost(options: ShellCommandRunHostOptions): ShellCommandRunHost {
  const { sessionId, runDir, sink } = options
  let ended = false
  let beaconFd: number | null = null
  let offData: (() => void) | null = null
  let offExit: (() => void) | null = null

  const closeBeacon = (): void => {
    if (beaconFd === null) return
    try {
      closeSync(beaconFd)
    } catch {
      // Already closed.
    }
    beaconFd = null
  }

  const removeListeners = (): void => {
    offData?.()
    offExit?.()
    offData = null
    offExit = null
  }

  const openBeacon = (): void => {
    const stdinPath = join(runDir, SHELL_COMMAND_RUN_FILES.stdin)
    try {
      execFileSync('mkfifo', ['-m', '600', stdinPath], { stdio: 'ignore' })
      beaconFd = openSync(stdinPath, constants.O_RDWR | constants.O_NONBLOCK)
    } catch {
      log.warn('Owner beacon unavailable for in-app shell command run', { sessionId })
    }
  }

  return {
    mode: 'in-app',

    async start(): Promise<void> {
      const spawn = buildShellCommandPtySpawn(options.steps)
      // Mandatory: ptyService.create silently reuses an existing PTY with the same id.
      if (ptyService.has(sessionId)) {
        throw new Error('A terminal is already running for this session')
      }
      mkdirSync(runDir, { recursive: true, mode: 0o700 })
      openBeacon()
      try {
        ptyService.create(sessionId, {
          cwd: options.cwd,
          command: spawn.command,
          args: spawn.args,
          env: options.env,
          cols: options.cols,
          rows: options.rows
        })
        // Same synchronous block as create(): the listeners attach to the instance that
        // is registered under the id right now.
        offData = ptyService.onData(sessionId, (data) => {
          if (!ended) sink.data(data)
        })
        offExit = ptyService.onExit(sessionId, (code, signal) => {
          if (ended) return
          ended = true
          offData = null
          offExit = null
          closeBeacon()
          // node-pty reports a signal-killed shell as code 0 plus the signal.
          const sig = signal > 0 ? signal : null
          const exitCode = sig !== null ? 128 + sig : code >= 0 && code <= 255 ? code : 1
          log.info('In-app shell command run exited', { sessionId, exitCode, signal: sig })
          sink.exit({ kind: 'exited', exitCode, signal: sig, abnormal: sig !== null })
        })
      } catch (err) {
        closeBeacon()
        throw err
      }
      log.info('In-app shell command run started', { sessionId, steps: options.steps.length })
    },

    write(data: string): void {
      if (ended || !ptyService.has(sessionId)) return
      ptyService.write(sessionId, data)
    },

    resize(cols: number, rows: number): void {
      if (ended || !ptyService.has(sessionId)) return
      ptyService.resize(sessionId, cols, rows)
    },

    async stop(): Promise<void> {
      if (ended) return
      ended = true
      removeListeners()
      closeBeacon()
      // pty-service's SIGHUP -> group SIGKILL escalation finishes the job; the wrapper
      // runs `set +m`, so every child is in the group. Never write Ctrl-C.
      ptyService.destroy(sessionId)
    },

    detach(): void {
      removeListeners()
      closeBeacon()
      ended = true
    }
  }
}
