import { spawn } from 'node:child_process'

// Runs a run's verify command the way the app runs project scripts (ScriptRunner): through
// `sh -c` with this process's environment. The server child inherits the login-shell
// environment Electron main loads at startup, so the user's PATH and version managers apply.
// What the app set for the server child itself is taken out again (see `verifyEnvironment`).

export const VERIFY_TIMEOUT_MS = 30 * 60 * 1000
export const VERIFY_OUTPUT_TAIL_BYTES = 12 * 1024
/** Between SIGTERM and SIGKILL when the command overruns. */
const KILL_GRACE_MS = 5_000
/** How long the output pipes may stay open after the shell exited (a daemon it left behind). */
const DRAIN_GRACE_MS = 2_000

export interface VerifyCommandResult {
  /** null when the command timed out, was killed or could not be started. */
  exitCode: number | null
  timedOut: boolean
  /** Tail of the combined stdout and stderr, without ANSI escapes. */
  output: string
  durationMs: number
}

export interface VerifyCommandOptions {
  timeoutMs?: number
  tailBytes?: number
  /** Between SIGTERM and SIGKILL on a timeout. */
  killGraceMs?: number
  env?: NodeJS.ProcessEnv
}

const ESCAPE = String.fromCharCode(27)
const BELL = String.fromCharCode(7)
// CSI sequences (colours, cursor moves), OSC sequences (titles, hyperlinks), two-byte escapes.
const ANSI_PATTERN = new RegExp(
  `${ESCAPE}\\[[0-?]*[ -/]*[@-~]|${ESCAPE}\\][^${BELL}${ESCAPE}]*(?:${BELL}|${ESCAPE}\\\\)|${ESCAPE}[@-Z\\\\-_]`,
  'g'
)

export function stripAnsi(text: string): string {
  return text.replace(ANSI_PATTERN, '')
}

/** Readable text from the captured bytes: no escapes, and only the last state of a progress line. */
function cleanOutput(bytes: Buffer, truncated: boolean): string {
  let start = 0
  // The cut may have landed inside a multi-byte character.
  while (truncated && start < bytes.length && (bytes[start] & 0xc0) === 0x80) start++
  let text = stripAnsi(bytes.subarray(start).toString('utf8'))
    .split('\n')
    .map((line) => {
      const settledLine = line.replace(/\r+$/, '')
      return settledLine.slice(settledLine.lastIndexOf('\r') + 1)
    })
    .join('\n')
  if (truncated) {
    // The first line is a fragment.
    const firstBreak = text.indexOf('\n')
    if (firstBreak !== -1) text = text.slice(firstBreak + 1)
  }
  return text.trim()
}

/**
 * The environment a command gets: this process's, minus what the app set to run the server
 * child. `ELECTRON_RUN_AS_NODE` would make any Electron binary the command starts (an
 * end-to-end test, a packaging step) run as plain Node, and the bootstrap token is the key to
 * this app's own RPC server. Neither is there in the terminal the user tried the command in.
 */
export function verifyEnvironment(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const [key, value] of Object.entries(base)) {
    if (key === 'ELECTRON_RUN_AS_NODE' || key === 'HIVE_DESKTOP_BOOTSTRAP_TOKEN') continue
    if (key.startsWith('HIVE_SERVER_')) continue
    env[key] = value
  }
  return env
}

function killTree(pid: number, signal: NodeJS.Signals): void {
  try {
    if (process.platform === 'win32') {
      spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
    } else {
      // The command runs detached as its own process group, so this reaches what it spawned.
      process.kill(-pid, signal)
    }
  } catch {
    // Already gone.
  }
}

function timeoutNote(timeoutMs: number): string {
  const budget =
    timeoutMs >= 60_000 ? `${Math.round(timeoutMs / 60_000)} min` : `${timeoutMs / 1000} s`
  return `Stopped: the command did not finish within ${budget}.`
}

/** Run `command` in `cwd` through the shell. Never rejects. */
export function runVerifyCommand(
  command: string,
  cwd: string,
  options: VerifyCommandOptions = {}
): Promise<VerifyCommandResult> {
  const timeoutMs = options.timeoutMs ?? VERIFY_TIMEOUT_MS
  const tailBytes = options.tailBytes ?? VERIFY_OUTPUT_TAIL_BYTES
  const killGraceMs = options.killGraceMs ?? KILL_GRACE_MS
  const startedAt = Date.now()

  return new Promise((resolve) => {
    const chunks: Buffer[] = []
    let buffered = 0
    let truncated = false
    let timedOut = false
    let settled = false
    let drainTimer: NodeJS.Timeout | undefined

    const capture = (chunk: Buffer): void => {
      chunks.push(chunk)
      buffered += chunk.length
      // Keep memory bounded on chatty commands: fold down to the tail now and then.
      if (buffered > tailBytes * 4) {
        const tail = Buffer.from(Buffer.concat(chunks).subarray(-tailBytes))
        chunks.length = 0
        chunks.push(tail)
        buffered = tail.length
        truncated = true
      }
    }

    const finish = (exitCode: number | null, startError?: string): void => {
      if (settled) return
      settled = true
      clearTimeout(timeoutTimer)
      clearTimeout(drainTimer)
      const all = Buffer.concat(chunks)
      const output = cleanOutput(all.subarray(-tailBytes), truncated || all.length > tailBytes)
      const note = startError ?? (timedOut ? timeoutNote(timeoutMs) : '')
      resolve({
        exitCode: timedOut ? null : exitCode,
        timedOut,
        output: [output, note].filter(Boolean).join('\n'),
        durationMs: Date.now() - startedAt
      })
    }

    const finishAfter = (delayMs: number, exitCode: number | null): void => {
      clearTimeout(drainTimer)
      drainTimer = setTimeout(() => finish(exitCode), delayMs)
    }

    const child = spawn(command, {
      cwd,
      shell: true,
      env: { ...verifyEnvironment(), ...options.env },
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
      windowsHide: true
    })

    const timeoutTimer = setTimeout(() => {
      timedOut = true
      const pid = child.pid
      if (pid === undefined) return
      killTree(pid, 'SIGTERM')
      // Not cleared when the shell exits first: its children may have ignored SIGTERM.
      setTimeout(() => killTree(pid, 'SIGKILL'), killGraceMs).unref()
      // Whatever survives even that is not going to report back.
      finishAfter(killGraceMs + DRAIN_GRACE_MS, null)
    }, timeoutMs)

    child.stdout?.on('data', capture)
    child.stderr?.on('data', capture)
    child.on('error', (error) => {
      finish(null, `Could not start the command: ${error.message}`)
    })
    // `close` waits for the pipes, which a background process the command started may hold.
    child.on('exit', (code) => finishAfter(DRAIN_GRACE_MS, code))
    child.on('close', (code) => finish(code))
  })
}
