import { execFile, execFileSync, spawn } from 'node:child_process'
import {
  accessSync,
  closeSync,
  constants,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  rmSync,
  statSync,
  writeFileSync,
  writeSync
} from 'node:fs'
import { delimiter, join } from 'node:path'
import { StringDecoder } from 'node:string_decoder'
import {
  ANTHROPIC_BASE_URL_ENV,
  ASSUME_FIRST_PARTY_ENV,
  getClaudeApiProxyBaseUrl
} from './claude-api-proxy/claude-api-proxy-env'
import { createLogger } from './logger'
import { SHELL_COMMAND_RUN_FILES, runHasLiveOwner } from './shell-command-paths'
import {
  DETACHED_LOG_LIMIT_BLOCKS,
  DETACHED_READY_TIMEOUT_MS,
  DETACHED_TAIL_POLL_MS,
  SHELL_COMMAND_LOG_CAP_BYTES,
  SHELL_COMMAND_LOG_TRUNCATED_MARKER,
  SHELL_LOG_LIMIT_ENV,
  SHELL_RUN_DIR_ENV,
  type RunHostExit,
  type RunHostSink,
  type ShellCommandRunHost,
  type ShellCommandRunHostOptions
} from './shell-command-run-host'
import { buildDetachedHostSpawn, buildShellCommandPtySpawn } from './shell-command-spawner'

/**
 * A shell-command run that outlives the app: `/bin/sh -c DETACHED_HOST_SCRIPT` in its
 * own session, script(1) writing the terminal bytes to output.log, a FIFO for input.
 * This module only tails, feeds and (on Stop) kills that tree; it never owns the
 * process. It must stay free of node-pty, pty-service and electron imports: its
 * integration test runs under plain Node.
 */
const log = createLogger({ component: 'ShellCommandDetachedHost' })

const READY_POLL_MS = 10
const READ_CHUNK_BYTES = 64 * 1024
const MAX_BYTES_PER_TICK = 1024 * 1024
const EXIT_CHECK_EVERY_TICKS = 5
const LIVENESS_CHECK_EVERY_TICKS = 20
const LOST_CONFIRM_DELAY_MS = 300
const WRITE_RETRY_MS = 20
const WRITE_QUEUE_CAP_BYTES = 1024 * 1024
const RESIZE_DEBOUNCE_MS = 100
const STOP_INNER_WAIT_MS = 1000
const STOP_EXIT_WAIT_ROUNDS = 15
const STOP_EXIT_WAIT_STEP_MS = 100
const STOP_HOST_GRACE_MS = 200

const PREFLIGHT_SCRIPT_MISSING =
  'This command is set to keep running if the app quits, which needs the system `script` utility. Install it or untick the option.'

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function isExecutable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK)
    return true
  } catch {
    return false
  }
}

/** First PATH entry holding an executable `name`, or null. */
function findExecutable(name: string): string | null {
  const dirs = (process.env.PATH ?? '').split(delimiter).filter((dir) => dir !== '')
  for (const dir of dirs) {
    const candidate = join(dir, name)
    if (isExecutable(candidate)) return candidate
  }
  return null
}

function psBinary(platform: NodeJS.Platform): string {
  return platform === 'darwin' ? '/bin/ps' : 'ps'
}

function tryKill(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(pid, signal)
  } catch {
    // Already gone, or never ours to begin with.
  }
}

function tryClose(fd: number | null): void {
  if (fd === null) return
  try {
    closeSync(fd)
  } catch {
    // Already closed.
  }
}

function errorCode(err: unknown): string {
  return err instanceof Error && 'code' in err ? String(err.code) : 'unknown'
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

export interface DetachedExitFacts {
  /** script(1)'s exit status, as recorded by the host. */
  script: number
  /** The wrapper's own status from inner.exit, when the wrapper got to write it. */
  wrapper: number | null
}

/** Parses the host's `exit` file: `script=<n>` is required, `wrapper=<n>` optional. */
export function parseDetachedExitFile(text: string): DetachedExitFacts | null {
  const script = /^script=(\d+)$/m.exec(text)
  if (!script) return null
  const wrapper = /^wrapper=(\d+)$/m.exec(text)
  return { script: Number(script[1]), wrapper: wrapper ? Number(wrapper[1]) : null }
}

/**
 * Facts -> verdict. script(1) normally exits with the shell's status, so when both
 * numbers agree (modulo 256) the wrapper's status is trusted. 153 (SIGXFSZ) means the
 * log hit the ulimit backstop.
 *
 * No wrapper line means the wrapper's EXIT trap never ran. Its HUP / INT handling
 * still records a status, so that is either SIGKILL (on darwin script(1) reports a
 * signal-killed shell by the raw signal number, 9) or a step that replaced the shell
 * (`exec`) or its EXIT trap: those exit with the program's own status, which is
 * what the user wants to see.
 */
export function resolveDetachedExit(
  facts: DetachedExitFacts,
  platform: NodeJS.Platform
): { exitCode: number; abnormal: boolean; reason: 'output-limit' | null } {
  const agree = facts.wrapper !== null && (facts.wrapper & 255) === facts.script
  if (agree) return { exitCode: facts.script, abnormal: false, reason: null }
  if (facts.script === 0) return { exitCode: facts.wrapper ?? 0, abnormal: true, reason: null }
  // util-linux script(1) reports a signal-killed shell as 128 + n instead.
  const killed =
    facts.wrapper === null && (platform === 'darwin' ? facts.script === 9 : facts.script > 128)
  const outputLimit = facts.script === 153
  return {
    exitCode: killed ? 137 : facts.script,
    abnormal: killed || outputLimit || facts.wrapper !== null,
    reason: outputLimit ? 'output-limit' : null
  }
}

/** Parses the prelude's `inner` file: the shell's pid (= its pgid) and controlling tty. */
export function parseInnerFile(text: string): { pid: number; tty: string } | null {
  const pid = /^pid=(\d+)$/m.exec(text)
  const tty = /^tty=(\/dev\/(?:ttys\d+|pts\/\d+))$/m.exec(text)
  return pid && tty ? { pid: Number(pid[1]), tty: tty[1] } : null
}

/** The run's result from its exit file; null while the file does not exist. */
export function readDetachedRunResult(
  runDir: string,
  platform: NodeJS.Platform = process.platform
): RunHostExit | null {
  let text: string
  try {
    text = readFileSync(join(runDir, SHELL_COMMAND_RUN_FILES.exit), 'utf8')
  } catch {
    return null
  }
  const facts = parseDetachedExitFile(text)
  if (!facts) return { kind: 'exited', exitCode: 1, signal: null, abnormal: true }
  const resolved = resolveDetachedExit(facts, platform)
  return {
    kind: 'exited',
    exitCode: resolved.exitCode,
    signal: null,
    abnormal: resolved.abnormal,
    ...(resolved.reason ? { reason: resolved.reason } : {})
  }
}

/** User-facing reason a detached run cannot start here, or null. Never falls back to in-app. */
export function detachedRunPreflight(platform: NodeJS.Platform = process.platform): string | null {
  if (platform === 'win32') return 'Shell commands are not supported on Windows'
  const hasScript =
    platform === 'darwin' ? isExecutable('/usr/bin/script') : findExecutable('script') !== null
  if (!hasScript || findExecutable('mkfifo') === null) return PREFLIGHT_SCRIPT_MISSING
  return null
}

function readInner(runDir: string): { pid: number; tty: string } | null {
  try {
    return parseInnerFile(readFileSync(join(runDir, SHELL_COMMAND_RUN_FILES.inner), 'utf8'))
  } catch {
    return null
  }
}

function readPidFile(path: string): number | null {
  try {
    const pid = Number(readFileSync(path, 'utf8').trim())
    return Number.isInteger(pid) && pid > 1 ? pid : null
  } catch {
    return null
  }
}

/** `{ pid, pgid }` of every process whose controlling tty is `tty` (empty on error). */
function psTty(tty: string): Array<{ pid: number; pgid: number }> {
  try {
    const out = execFileSync(
      psBinary(process.platform),
      ['-o', 'pid=,pgid=', '-t', tty.replace(/^\/dev\//, '')],
      { env: { ...process.env, LC_ALL: 'C' }, timeout: 2000 }
    ).toString()
    return out
      .split('\n')
      .map((line) => line.trim().split(/\s+/).map(Number))
      .filter((cols) => cols.length === 2 && cols.every(Number.isInteger) && cols[0] > 1)
      .map(([pid, pgid]) => ({ pid, pgid }))
  } catch {
    return []
  }
}

/**
 * Kills a live detached run (Stop button, sweep of an unreferenced run). The tty
 * snapshot is taken BEFORE the hangup: the tty is revoked when its session leader
 * dies, and a child that left the process group but kept the tty is only reachable
 * through that snapshot. Pids are used only here, and only while the FIFO probe says
 * the run is live.
 */
export async function stopDetachedRun(runDir: string): Promise<void> {
  const exitPath = join(runDir, SHELL_COMMAND_RUN_FILES.exit)
  const innerPath = join(runDir, SHELL_COMMAND_RUN_FILES.inner)
  const deadline = Date.now() + STOP_INNER_WAIT_MS
  while (!existsSync(innerPath) && !existsSync(exitPath) && Date.now() < deadline) {
    if (!runHasLiveOwner(runDir)) break
    await delay(READY_POLL_MS)
  }
  if (existsSync(exitPath) || !runHasLiveOwner(runDir)) return

  const hostPid = readPidFile(join(runDir, SHELL_COMMAND_RUN_FILES.hostPid))
  const inner = readInner(runDir)
  const snapshot = inner ? psTty(inner.tty) : []
  const innerLive = inner !== null && snapshot.some((row) => row.pgid === inner.pid)
  if (inner && innerLive) {
    tryKill(-inner.pid, 'SIGHUP')
    tryKill(-inner.pid, 'SIGCONT')
  }
  for (let i = 0; i < STOP_EXIT_WAIT_ROUNDS && !existsSync(exitPath); i++) {
    await delay(STOP_EXIT_WAIT_STEP_MS)
  }
  if (inner && innerLive) tryKill(-inner.pid, 'SIGKILL')
  for (const row of snapshot) tryKill(row.pid, 'SIGKILL')
  await delay(STOP_HOST_GRACE_MS)
  // A live reader proves the host group still exists.
  if (hostPid !== null && runHasLiveOwner(runDir)) tryKill(-hostPid, 'SIGKILL')
  log.info('Detached shell command run stopped', {
    innerKnown: inner !== null,
    innerLive,
    snapshot: snapshot.length,
    exited: existsSync(exitPath),
    live: runHasLiveOwner(runDir)
  })
}

// ---------------------------------------------------------------------------
// The tail / input / resize core shared by created and adopted hosts
// ---------------------------------------------------------------------------

interface DetachedCore {
  startTail(offset: number): void
  openInput(): boolean
  write(data: string): void
  resize(cols: number, rows: number): void
  stop(): Promise<void>
  detach(): void
}

function createDetachedCore(sessionId: string, runDir: string, sink: RunHostSink): DetachedCore {
  const logPath = join(runDir, SHELL_COMMAND_RUN_FILES.log)
  const stdinPath = join(runDir, SHELL_COMMAND_RUN_FILES.stdin)
  const exitPath = join(runDir, SHELL_COMMAND_RUN_FILES.exit)

  let finished = false
  let logFd: number | null = null
  let inFd: number | null = null
  let offset = 0
  let tick = 0
  let decoder = new StringDecoder('utf8')
  // One scratch buffer per tail: pump() runs every tick for the life of the run.
  const readBuffer = Buffer.allocUnsafe(READ_CHUNK_BYTES)
  let tailTimer: NodeJS.Timeout | null = null
  let lostTimer: NodeJS.Timeout | null = null
  let writeTimer: NodeJS.Timeout | null = null
  let resizeTimer: NodeJS.Timeout | null = null
  let pendingResize: { cols: number; rows: number } | null = null
  const writeQueue: Buffer[] = []
  let writeQueueBytes = 0

  const clearTimers = (): void => {
    if (tailTimer) clearInterval(tailTimer)
    if (lostTimer) clearTimeout(lostTimer)
    if (writeTimer) clearInterval(writeTimer)
    if (resizeTimer) clearTimeout(resizeTimer)
    tailTimer = null
    lostTimer = null
    writeTimer = null
    resizeTimer = null
  }

  const closeFds = (): void => {
    tryClose(logFd)
    tryClose(inFd)
    logFd = null
    inFd = null
  }

  /** Reads from the stored offset, at most `maxBytes`, into the sink. */
  const pump = (maxBytes = MAX_BYTES_PER_TICK): void => {
    if (logFd === null) {
      try {
        logFd = openSync(logPath, 'r')
      } catch {
        return
      }
    }
    let read = 0
    while (read < maxBytes) {
      let n: number
      try {
        n = readSync(logFd, readBuffer, 0, readBuffer.length, offset)
      } catch {
        return
      }
      if (n <= 0) break
      offset += n
      read += n
      const text = decoder.write(readBuffer.subarray(0, n))
      if (text !== '') sink.data(text)
    }
  }

  /**
   * A chatty step can outrun the tail by far more than the transcript cap. Jump to
   * the last cap's worth instead of pushing the whole backlog through the sink in
   * one go (the final flush would otherwise build one multi-hundred-MB IPC message).
   */
  const skipBacklog = (): void => {
    let size: number
    try {
      size = statSync(logPath).size
    } catch {
      return
    }
    if (size - offset <= SHELL_COMMAND_LOG_CAP_BYTES) return
    offset = offsetAfterNextNewline(logPath, size - SHELL_COMMAND_LOG_CAP_BYTES, size)
    decoder = new StringDecoder('utf8')
    sink.data(SHELL_COMMAND_LOG_TRUNCATED_MARKER)
  }

  const drain = (): void => {
    skipBacklog()
    for (;;) {
      const before = offset
      pump()
      if (offset === before) break
    }
  }

  const finish = (exit: RunHostExit): void => {
    if (finished) return
    finished = true
    clearTimers()
    drain()
    const rest = decoder.end()
    if (rest !== '') sink.data(rest)
    closeFds()
    writeQueue.length = 0
    writeQueueBytes = 0
    log.info('Detached shell command run finished', {
      sessionId,
      kind: exit.kind,
      ...(exit.kind === 'exited' ? { exitCode: exit.exitCode, abnormal: exit.abnormal } : {})
    })
    sink.exit(exit)
  }

  const onTick = (): void => {
    if (finished) return
    tick += 1
    pump()
    if (tick % EXIT_CHECK_EVERY_TICKS === 0) {
      const exit = readDetachedRunResult(runDir)
      if (exit) {
        finish(exit)
        return
      }
    }
    if (tick % LIVENESS_CHECK_EVERY_TICKS === 0 && lostTimer === null && !runHasLiveOwner(runDir)) {
      lostTimer = setTimeout(() => {
        lostTimer = null
        if (finished) return
        drain()
        finish(readDetachedRunResult(runDir) ?? { kind: 'lost' })
      }, LOST_CONFIRM_DELAY_MS)
      lostTimer.unref()
    }
  }

  const dropQueue = (): void => {
    writeQueue.length = 0
    writeQueueBytes = 0
    if (writeTimer) clearInterval(writeTimer)
    writeTimer = null
  }

  const enqueue = (bytes: Buffer): void => {
    const room = WRITE_QUEUE_CAP_BYTES - writeQueueBytes
    if (room <= 0) return
    const kept = bytes.length > room ? bytes.subarray(0, room) : bytes
    writeQueue.push(kept)
    writeQueueBytes += kept.length
    if (writeTimer === null) {
      writeTimer = setInterval(flushQueue, WRITE_RETRY_MS)
      writeTimer.unref()
    }
  }

  /** Writes as much of `bytes` as the FIFO takes; returns the unwritten remainder. */
  const writeSome = (bytes: Buffer): Buffer | null => {
    if (inFd === null) return null
    let done = 0
    while (done < bytes.length) {
      try {
        done += writeSync(inFd, bytes, done, bytes.length - done)
      } catch (err) {
        const code = errorCode(err)
        if (code === 'EAGAIN') return bytes.subarray(done)
        // EPIPE / ENXIO: the reader is gone; anything else is not worth retrying.
        dropQueue()
        return null
      }
    }
    return null
  }

  function flushQueue(): void {
    if (finished || inFd === null) {
      dropQueue()
      return
    }
    while (writeQueue.length > 0) {
      const head = writeQueue[0]
      const rest = writeSome(head)
      if (writeQueue.length === 0) return
      if (rest !== null) {
        writeQueueBytes -= head.length - rest.length
        writeQueue[0] = rest
        return
      }
      writeQueue.shift()
      writeQueueBytes -= head.length
    }
    if (writeTimer) clearInterval(writeTimer)
    writeTimer = null
  }

  const applyResize = (): void => {
    resizeTimer = null
    const size = pendingResize
    pendingResize = null
    if (finished || !size) return
    const inner = readInner(runDir)
    if (!inner || existsSync(exitPath) || !runHasLiveOwner(runDir)) return
    const darwin = process.platform === 'darwin'
    execFile(
      darwin ? '/bin/stty' : 'stty',
      [darwin ? '-f' : '-F', inner.tty, 'cols', String(size.cols), 'rows', String(size.rows)],
      { timeout: 2000 },
      () => {
        // Errors are ignored: the tty may have just gone away.
      }
    )
  }

  return {
    startTail(startOffset: number): void {
      // Stopped or detached while the host was still starting: nothing to follow.
      if (finished) return
      offset = startOffset
      tick = 0
      tailTimer = setInterval(onTick, DETACHED_TAIL_POLL_MS)
      tailTimer.unref()
    },

    openInput(): boolean {
      if (finished) return true
      try {
        inFd = openSync(stdinPath, constants.O_WRONLY | constants.O_NONBLOCK)
        return true
      } catch {
        inFd = null
        return false
      }
    },

    write(data: string): void {
      if (finished || inFd === null || data === '') return
      const bytes = Buffer.from(data, 'utf8')
      if (writeQueue.length > 0) {
        enqueue(bytes)
        return
      }
      const rest = writeSome(bytes)
      if (rest !== null) enqueue(rest)
    },

    resize(cols: number, rows: number): void {
      if (finished) return
      if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols <= 0 || rows <= 0) return
      pendingResize = { cols, rows }
      if (resizeTimer) clearTimeout(resizeTimer)
      resizeTimer = setTimeout(applyResize, RESIZE_DEBOUNCE_MS)
      resizeTimer.unref()
    },

    async stop(): Promise<void> {
      if (finished) return
      finished = true
      clearTimers()
      await stopDetachedRun(runDir)
      closeFds()
    },

    detach(): void {
      finished = true
      clearTimers()
      closeFds()
    }
  }
}

// ---------------------------------------------------------------------------
// Hosts
// ---------------------------------------------------------------------------

/** The host's environment: the app's, minus what must not outlive the app. */
function buildDetachedEnv(extra: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    TERM: 'xterm-256color',
    COLORTERM: 'truecolor'
  }
  delete env.COLUMNS
  delete env.LINES
  // The Claude API proxy dies with the app; a detached run outlives it.
  const proxyBaseUrl = getClaudeApiProxyBaseUrl()
  if (proxyBaseUrl !== null && env[ANTHROPIC_BASE_URL_ENV] === proxyBaseUrl) {
    delete env[ANTHROPIC_BASE_URL_ENV]
    delete env[ASSUME_FIRST_PARTY_ENV]
  }
  Object.assign(env, extra)
  if (!(SHELL_LOG_LIMIT_ENV in extra)) env[SHELL_LOG_LIMIT_ENV] = DETACHED_LOG_LIMIT_BLOCKS
  // The host sets this one itself.
  delete env[SHELL_RUN_DIR_ENV]
  return env
}

export function createDetachedRunHost(options: ShellCommandRunHostOptions): ShellCommandRunHost {
  const { sessionId, runDir, sink } = options
  const core = createDetachedCore(sessionId, runDir, sink)
  let starting: Promise<void> | null = null

  const startHost = async (): Promise<void> => {
    const preflight = detachedRunPreflight()
    if (preflight !== null) throw new Error(preflight)
    const host = buildDetachedHostSpawn(buildShellCommandPtySpawn(options.steps), {
      runDir,
      cols: options.cols,
      rows: options.rows
    })
    const stdinPath = join(runDir, SHELL_COMMAND_RUN_FILES.stdin)
    const hostPidPath = join(runDir, SHELL_COMMAND_RUN_FILES.hostPid)
    const exitPath = join(runDir, SHELL_COMMAND_RUN_FILES.exit)

    mkdirSync(runDir, { recursive: true, mode: 0o700 })
    execFileSync(findExecutable('mkfifo') ?? 'mkfifo', ['-m', '600', stdinPath], {
      stdio: 'ignore'
    })
    writeFileSync(join(runDir, SHELL_COMMAND_RUN_FILES.log), '', { mode: 0o600 })

    const child = spawn(host.command, host.args, {
      detached: true,
      stdio: 'ignore',
      cwd: options.cwd,
      env: buildDetachedEnv(options.env)
    })
    child.unref()
    let early: string | null = null
    child.on('error', (err) => {
      early = early ?? `error:${errorCode(err)}`
    })
    child.on('exit', (code, signal) => {
      early = early ?? `exit:${code ?? signal ?? 'unknown'}`
    })

    const fail = (why: string): never => {
      if (child.pid) tryKill(-child.pid, 'SIGKILL')
      try {
        rmSync(runDir, { recursive: true, force: true })
      } catch {
        // Best effort; the sweep removes leftovers.
      }
      log.warn('Detached shell command host did not start', { sessionId, why })
      throw new Error('The command host did not start')
    }

    const startedAt = Date.now()
    while (
      readPidFile(hostPidPath) === null &&
      early === null &&
      Date.now() - startedAt < DETACHED_READY_TIMEOUT_MS
    ) {
      await delay(READY_POLL_MS)
    }
    // The ready marker is what counts: a short run may already have finished (and its
    // host exited) by the time this loop looks again.
    if (readPidFile(hostPidPath) === null) {
      fail(early ?? (child.pid ? 'ready-timeout' : 'no-pid'))
    }

    // Without `detached: true` the run would die with the app: assert the host
    // leads its own process group (unless it is already gone, leaving its result).
    let pgid = ''
    try {
      pgid = execFileSync(psBinary(process.platform), ['-o', 'pgid=', '-p', String(child.pid)], {
        timeout: 2000
      })
        .toString()
        .trim()
    } catch {
      // Treated as a mismatch below.
    }
    if (pgid !== String(child.pid) && !existsSync(exitPath)) fail('not-group-leader')

    // Only now: the host holds the FIFO open, so this never blocks or fails with ENXIO
    // (a run that already finished has no reader left; the tail reports its result).
    if (!core.openInput() && !existsSync(exitPath)) fail('stdin-open')
    core.startTail(0)
    log.info('Detached shell command run started', {
      sessionId,
      hostPid: child.pid,
      steps: options.steps.length,
      readyMs: Date.now() - startedAt
    })
  }

  return {
    mode: 'detached',

    start(): Promise<void> {
      if (starting === null) starting = startHost()
      return starting
    },

    write: (data) => core.write(data),
    resize: (cols, rows) => core.resize(cols, rows),
    async stop(): Promise<void> {
      // A stop that arrives while the host is starting waits for it: only then are
      // there pids to kill.
      if (starting !== null) await starting.catch(() => {})
      await core.stop()
    },
    detach: () => core.detach()
  }
}

/** Offset just after the first newline at or after `from` (or `from` when there is none). */
function offsetAfterNextNewline(logPath: string, from: number, size: number): number {
  let fd: number | null = null
  try {
    fd = openSync(logPath, 'r')
    const buffer = Buffer.allocUnsafe(READ_CHUNK_BYTES)
    let position = from
    while (position < size) {
      const n = readSync(fd, buffer, 0, buffer.length, position)
      if (n <= 0) break
      const index = buffer.subarray(0, n).indexOf(0x0a)
      if (index !== -1) return position + index + 1
      position += n
    }
    return from
  } catch {
    return from
  } finally {
    tryClose(fd)
  }
}

/**
 * Takes over a detached run started by an earlier app lifetime. The returned host is
 * tailing already: it replays the retained tail of the log (prefixed with the truncated
 * marker when the log is longer than the cap) and then follows it until the exit file
 * appears or the run's owner vanishes. start() is a no-op.
 */
export function adoptDetachedRunHost(options: {
  sessionId: string
  runDir: string
  sink: RunHostSink
}): ShellCommandRunHost {
  const { sessionId, runDir, sink } = options
  const core = createDetachedCore(sessionId, runDir, sink)
  const logPath = join(runDir, SHELL_COMMAND_RUN_FILES.log)

  let size = 0
  try {
    size = statSync(logPath).size
  } catch {
    // No log yet: tail from the beginning.
  }
  let offset = Math.max(0, size - SHELL_COMMAND_LOG_CAP_BYTES)
  if (offset > 0) {
    offset = offsetAfterNextNewline(logPath, offset, size)
    sink.data(SHELL_COMMAND_LOG_TRUNCATED_MARKER)
  }
  // Input is simply unavailable when this fails; the tail reports lost / finished.
  const inputOpen = core.openInput()
  core.startTail(offset)
  log.info('Detached shell command run adopted', { sessionId, offset, inputOpen })

  return {
    mode: 'detached',
    start: async () => {},
    write: (data) => core.write(data),
    resize: (cols, rows) => core.resize(cols, rows),
    stop: () => core.stop(),
    detach: () => core.detach()
  }
}
