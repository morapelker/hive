import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, rmSync, rmdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { getDatabase } from '../db'
import type { Session } from '../db/types'
import { publishDesktopBackendEvent } from '../desktop/backend-event-publisher'
import type {
  TerminalAttachShellCommandResult,
  TerminalRunShellCommandResult
} from '../../shared/desktop-command'
import {
  parseSessionShellCommand,
  parseShellCommandSteps,
  serializeSessionShellCommand,
  type SessionShellCommand
} from '@shared/lib/shell-commands'
import {
  SHELL_COMMAND_STATUS_CHANNEL,
  wrapShellCommandReplay,
  type ShellCommandStatusPayload
} from '@shared/shell-command-events'
import { isShellCommandSession } from '@shared/types/agent-sdk'
import { getUserEnvironmentVariables } from './env-vars'
import { createLogger } from './logger'
import {
  adoptDetachedRunHost,
  createDetachedRunHost,
  readDetachedRunResult,
  stopDetachedRun
} from './shell-command-detached-host'
import { createInAppRunHost } from './shell-command-in-app-host'
import {
  ShellCommandOutputBuffer,
  appendToShellCommandLog,
  readShellCommandLogTail,
  trimShellCommandLog
} from './shell-command-output-buffer'
import {
  SHELL_COMMAND_RUN_FILES,
  getShellCommandRunDir,
  getShellCommandRunsDir,
  isValidShellCommandRunId,
  runHasLiveOwner
} from './shell-command-paths'
import {
  RUN_DIR_ORPHAN_MAX_AGE_MS,
  SHELL_COMMAND_DEFAULT_COLS,
  SHELL_COMMAND_DEFAULT_ROWS,
  SHELL_COMMAND_INTERRUPTED_MARKER,
  SHELL_COMMAND_STOPPED_MARKER,
  type RunHostExit,
  type RunHostSink,
  type ShellCommandRunHost,
  type ShellCommandRunHostFactories
} from './shell-command-run-host'

const log = createLogger({ component: 'ShellCommandRuns' })

/**
 * The run registry of shell-command sessions: the one place in the app that starts,
 * follows, stops and finalizes a run, whichever host executes it (an in-app PTY or a
 * detached process tree).
 *
 * Rules the rest of the app relies on:
 * - This module is the ONLY writer of the run state in sessions.shell_command, and a
 *   state is persisted before it is published on 'shell-command:status'.
 * - Buffered output is flushed before a final state is persisted or published.
 * - Only runShellCommandTerminal spawns. Attaching a view republishes the transcript.
 * - Output reaches views on terminal:data:<sessionId>; the terminal exit channel is
 *   never used for these sessions (state travels on the status channel).
 * - Finalizing is a compare-and-set on (runId, state === 'running'): several app
 *   instances can share one database and must not overwrite each other's verdict.
 */

interface LiveRun {
  sessionId: string
  runId: string
  runDir: string
  detached: boolean
  host: ShellCommandRunHost
  buffer: ShellCommandOutputBuffer
  cols: number
  rows: number
  /** A final state was persisted (or the run was handed to another owner). */
  settled: boolean
}

interface StoredRun {
  session: Session
  snapshot: SessionShellCommand
}

/** A pending session this old was abandoned by its launcher. */
const PENDING_STALE_MS = 60_000
/** A host that just vanished may still be writing its exit file. */
const DETACHED_RESULT_GRACE_MS = 300
/** Run directories younger than this may belong to a run that is being started. */
const SWEEP_MIN_AGE_MS = 60_000
const SWEEP_FIRST_DELAY_MS = 30_000
const SWEEP_INTERVAL_MS = 6 * 60 * 60 * 1000

const NOT_A_SHELL_COMMAND_SESSION = 'Session is not a shell command session'

const liveRuns = new Map<string, LiveRun>()
/** Sessions that ran or attached, with the size their view last reported. */
const knownSizes = new Map<string, { cols: number; rows: number }>()
/** Stops still killing their process tree; a re-run waits for its session's entry. */
const stoppingRuns = new Map<string, Promise<void>>()

const defaultFactories: ShellCommandRunHostFactories = {
  createInApp: createInAppRunHost,
  createDetached: createDetachedRunHost,
  adoptDetached: adoptDetachedRunHost
}
let factories: ShellCommandRunHostFactories = { ...defaultFactories }

let sweepStarted = false

const nowIso = (): string => new Date().toISOString()

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

function errorCode(err: unknown): string {
  return err instanceof Error && 'code' in err ? String(err.code) : 'unknown'
}

function isTerminalSize(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0
}

function readRun(sessionId: string): StoredRun | null {
  const session = getDatabase().getSession(sessionId)
  if (!session || !isShellCommandSession(session)) return null
  const snapshot = parseSessionShellCommand(session.shell_command)
  return snapshot ? { session, snapshot } : null
}

function writeSnapshot(sessionId: string, snapshot: SessionShellCommand): void {
  getDatabase().updateSession(sessionId, { shell_command: serializeSessionShellCommand(snapshot) })
}

/** The session's row when it still shows `runId` as running (the compare of every finalize). */
function readRunIfCurrent(sessionId: string, runId: string): StoredRun | null {
  const current = readRun(sessionId)
  if (!current) return null
  if (current.snapshot.runId !== runId || current.snapshot.state !== 'running') return null
  return current
}

function publishData(sessionId: string, chunk: string): void {
  void publishDesktopBackendEvent(`terminal:data:${sessionId}`, chunk).catch(() => undefined)
}

function publishStatus(sessionId: string, snapshot: SessionShellCommand): void {
  const payload: ShellCommandStatusPayload = {
    sessionId,
    runId: snapshot.runId,
    state: snapshot.state,
    exitCode: snapshot.exitCode,
    signal: snapshot.signal,
    detached: snapshot.detached,
    reason: snapshot.reason,
    error: snapshot.error,
    startedAt: snapshot.startedAt,
    finishedAt: snapshot.finishedAt
  }
  void publishDesktopBackendEvent(SHELL_COMMAND_STATUS_CHANNEL, payload).catch(() => undefined)
}

/** The run directory, or null when the ids cannot name one. */
function runDirOrNull(sessionId: string, runId: string | null): string | null {
  if (runId === null) return null
  try {
    return getShellCommandRunDir(sessionId, runId)
  } catch {
    return null
  }
}

function logFileOf(runDir: string): string {
  return join(runDir, SHELL_COMMAND_RUN_FILES.log)
}

function removeFile(path: string): void {
  try {
    rmSync(path, { force: true })
  } catch {
    // Best effort; the sweep removes leftovers with the directory.
  }
}

function removeDir(path: string): void {
  try {
    rmSync(path, { recursive: true, force: true })
  } catch {
    // Best effort; the sweep removes leftovers.
  }
}

/** Everything but the transcript (output.log) and the result (exit) of a finished run. */
function removeControlFiles(runDir: string): void {
  const files = SHELL_COMMAND_RUN_FILES
  for (const name of [
    files.stdin,
    files.hostPid,
    `${files.hostPid}.tmp`,
    files.feederPid,
    files.inner,
    `${files.inner}.tmp`,
    files.innerExit,
    `${files.exit}.tmp`
  ]) {
    removeFile(join(runDir, name))
  }
  try {
    const hostErr = join(runDir, files.hostErr)
    if (statSync(hostErr).size === 0) removeFile(hostErr)
  } catch {
    // No host.err: nothing to remove.
  }
}

function sizeFor(sessionId: string): { cols: number; rows: number } {
  return (
    knownSizes.get(sessionId) ?? {
      cols: SHELL_COMMAND_DEFAULT_COLS,
      rows: SHELL_COMMAND_DEFAULT_ROWS
    }
  )
}

/**
 * Builds the run object and its host together: a host may deliver output through the
 * sink while it is being constructed (an adopted run replays its log), so the buffer
 * exists first.
 */
function createLiveRun(
  init: Pick<LiveRun, 'sessionId' | 'runId' | 'runDir' | 'detached' | 'cols' | 'rows'>,
  makeHost: (sink: RunHostSink) => ShellCommandRunHost
): LiveRun {
  const buffer = new ShellCommandOutputBuffer({
    // A detached run's log is written by script(1); an in-app run's by the buffer.
    logFile: init.detached ? null : logFileOf(init.runDir),
    publish: (chunk) => publishData(init.sessionId, chunk)
  })
  const run = { ...init, buffer, settled: false } as LiveRun
  run.host = makeHost({
    data: (chunk) => run.buffer.append(chunk),
    exit: (exit) => settleRun(run, exit)
  })
  return run
}

function cleanupRun(run: LiveRun): void {
  run.buffer.close()
  if (run.detached) trimShellCommandLog(logFileOf(run.runDir))
  removeControlFiles(run.runDir)
  if (liveRuns.get(run.sessionId) === run) liveRuns.delete(run.sessionId)
}

function finishedSnapshot(snapshot: SessionShellCommand, exit: RunHostExit): SessionShellCommand {
  if (exit.kind === 'lost') {
    return {
      ...snapshot,
      state: 'interrupted',
      exitCode: null,
      signal: null,
      reason: null,
      finishedAt: nowIso()
    }
  }
  return {
    ...snapshot,
    state: exit.exitCode === 0 ? 'succeeded' : 'failed',
    exitCode: exit.exitCode,
    signal: exit.signal,
    reason: exit.reason ?? null,
    finishedAt: nowIso()
  }
}

function settleRun(run: LiveRun, exit: RunHostExit): void {
  if (run.settled) return
  run.settled = true
  // Flush before the final state: the wrapper's last lines must reach the views first.
  run.buffer.flush()
  let current: StoredRun | null
  try {
    current = readRun(run.sessionId)
  } catch (err) {
    log.warn('Reading a finished shell command run failed', {
      sessionId: run.sessionId,
      code: errorCode(err)
    })
    cleanupRun(run)
    return
  }
  if (!current || current.snapshot.runId !== run.runId || current.snapshot.state !== 'running') {
    // Cancelled, or finalized by another app instance: their verdict stands.
    cleanupRun(run)
    if (current) publishStatus(run.sessionId, current.snapshot)
    return
  }
  const next = finishedSnapshot(current.snapshot, exit)
  try {
    writeSnapshot(run.sessionId, next)
  } catch (err) {
    log.warn('Persisting a finished shell command run failed', {
      sessionId: run.sessionId,
      code: errorCode(err)
    })
    cleanupRun(run)
    return
  }
  cleanupRun(run)
  log.info('Shell command run finished', {
    sessionId: run.sessionId,
    runId: run.runId,
    state: next.state,
    exitCode: next.exitCode
  })
  publishStatus(run.sessionId, next)
}

/**
 * Starts the session's command (the launcher and "Run again"). Resolves right after
 * the spawn, never at the end of the run.
 */
export async function runShellCommandTerminal(
  sessionId: string,
  opts?: { cols?: number; rows?: number }
): Promise<TerminalRunShellCommandResult> {
  // A stop of the previous run may still be killing its tree (and holding the PTY id).
  const stopping = stoppingRuns.get(sessionId)
  if (stopping) await stopping

  const stored = readRun(sessionId)
  if (!stored) return { success: false, error: NOT_A_SHELL_COMMAND_SESSION }
  const { session, snapshot } = stored

  const previousRunDir = runDirOrNull(sessionId, snapshot.runId)
  if (
    liveRuns.has(sessionId) ||
    // Another app instance on the same database owns the run.
    (snapshot.state === 'running' && previousRunDir !== null && runHasLiveOwner(previousRunDir))
  ) {
    return { success: false, alreadyRunning: true, error: 'Command is already running' }
  }

  // A failure before the spawn belongs to no run: it must not inherit the previous
  // run's runId (its transcript would replay under a Failed strip) or startedAt (the
  // view would show a bogus elapsed time). Post-spawn failures pass the new run's row.
  const failStart = (
    base: SessionShellCommand,
    message: string,
    identity: Pick<SessionShellCommand, 'runId' | 'startedAt'> = {
      runId: null,
      startedAt: nowIso()
    }
  ): TerminalRunShellCommandResult => {
    const failed: SessionShellCommand = {
      ...base,
      ...identity,
      state: 'failed',
      reason: 'start-failed',
      error: message,
      exitCode: null,
      signal: null,
      finishedAt: nowIso()
    }
    writeSnapshot(sessionId, failed)
    publishStatus(sessionId, failed)
    log.warn('Shell command run could not start', { sessionId, runId: failed.runId })
    return { success: false, error: message }
  }

  if (process.platform === 'win32') {
    return failStart(snapshot, 'Shell commands are not supported on Windows')
  }

  const db = getDatabase()
  const worktree = session.worktree_id ? db.getWorktree(session.worktree_id) : null
  if (worktree?.teleported_to) {
    return failStart(snapshot, 'This worktree lives on another machine')
  }
  let worktreeIsDirectory = false
  try {
    worktreeIsDirectory = worktree !== null && statSync(worktree.path).isDirectory()
  } catch {
    // Missing or unreadable: reported below.
  }
  if (!worktree || !worktreeIsDirectory) {
    return failStart(snapshot, 'The worktree folder for this command no longer exists')
  }

  const steps = parseShellCommandSteps(snapshot.script)
  if (steps.length === 0) return failStart(snapshot, 'Command has no runnable lines')

  const known = sizeFor(sessionId)
  const cols = isTerminalSize(opts?.cols) ? opts.cols : known.cols
  const rows = isTerminalSize(opts?.rows) ? opts.rows : known.rows

  const runId = randomUUID()
  let run: LiveRun
  try {
    const runDir = getShellCommandRunDir(sessionId, runId)
    mkdirSync(runDir, { recursive: true, mode: 0o700 })
    const project = db.getProject(worktree.project_id)
    const env: Record<string, string> = {
      ...getUserEnvironmentVariables(db),
      HIVE_PROJECT_PATH: project?.path ?? worktree.path,
      HIVE_WORKTREE_PATH: worktree.path
    }
    run = createLiveRun(
      { sessionId, runId, runDir, detached: snapshot.detached, cols, rows },
      (sink) => {
        const hostOptions = { sessionId, runDir, cwd: worktree.path, steps, env, cols, rows, sink }
        return snapshot.detached
          ? factories.createDetached(hostOptions)
          : factories.createInApp(hostOptions)
      }
    )
  } catch (err) {
    log.warn('Preparing a shell command run failed', { sessionId, code: errorCode(err) })
    const runDir = runDirOrNull(sessionId, runId)
    if (runDir !== null) removeDir(runDir)
    return failStart(snapshot, 'The command could not be prepared')
  }

  // Persisted BEFORE the spawn: a run that outlives a crash here is found by the
  // startup reconcile through this row.
  const running: SessionShellCommand = {
    ...snapshot,
    state: 'running',
    runId,
    exitCode: null,
    signal: null,
    reason: null,
    error: null,
    startedAt: nowIso(),
    finishedAt: null
  }
  writeSnapshot(sessionId, running)
  liveRuns.set(sessionId, run)
  knownSizes.set(sessionId, { cols, rows })
  publishStatus(sessionId, running)
  // An empty replay clears every attached view (this is what resets the terminal on
  // Run again).
  publishData(sessionId, wrapShellCommandReplay(''))

  try {
    await run.host.start()
  } catch (err) {
    const message = err instanceof Error && err.message ? err.message : 'The command did not start'
    // Stopped (or otherwise settled) while it was starting: that verdict stands.
    if (run.settled) return { success: false, error: message }
    run.settled = true
    if (liveRuns.get(sessionId) === run) liveRuns.delete(sessionId)
    run.buffer.close()
    removeDir(run.runDir)
    const current = readRunIfCurrent(sessionId, runId)
    if (!current) return { success: false, error: message }
    return failStart(current.snapshot, message, {
      runId: current.snapshot.runId,
      startedAt: current.snapshot.startedAt
    })
  }

  if (previousRunDir !== null && snapshot.runId !== runId && !runHasLiveOwner(previousRunDir)) {
    removeDir(previousRunDir)
  }
  log.info('Shell command run started', { sessionId, runId, detached: snapshot.detached })
  return { success: true, cols, rows }
}

/**
 * A view mounted: publish the transcript so far (in-band replay) and report the run
 * state. Synchronous on purpose, and it never spawns.
 */
export function attachShellCommandTerminal(sessionId: string): TerminalAttachShellCommandResult {
  const stored = readRun(sessionId)
  if (!stored) return { success: false, error: NOT_A_SHELL_COMMAND_SESSION }
  const { snapshot } = stored

  const size = sizeFor(sessionId)
  if (!knownSizes.has(sessionId)) knownSizes.set(sessionId, size)

  const run = liveRuns.get(sessionId)
  if (run) {
    // No await between the flush and the replay: nothing can be lost or shown twice.
    run.buffer.flush()
    publishData(sessionId, wrapShellCommandReplay(run.buffer.snapshot()))
    return {
      success: true,
      cols: run.cols,
      rows: run.rows,
      state: 'running',
      exitCode: null,
      runId: run.runId
    }
  }

  const runDir = runDirOrNull(sessionId, snapshot.runId)
  if (runDir !== null) {
    publishData(sessionId, wrapShellCommandReplay(readShellCommandLogTail(logFileOf(runDir))))
  }
  return {
    success: true,
    cols: size.cols,
    rows: size.rows,
    state: snapshot.state,
    exitCode: snapshot.exitCode,
    runId: snapshot.runId
  }
}

/** Keyboard input. True when a live run took it (the caller must not look for a PTY). */
export function writeShellCommandRun(sessionId: string, data: string): boolean {
  const run = liveRuns.get(sessionId)
  if (!run || run.settled) return false
  run.host.write(data)
  return true
}

/**
 * True when the id belongs to a shell-command session this process knows. Without a
 * live run the size is only remembered: the next run starts at the view's size.
 */
export function resizeShellCommandRun(sessionId: string, cols: number, rows: number): boolean {
  const run = liveRuns.get(sessionId)
  if (!run && !knownSizes.has(sessionId)) return false
  if (!isTerminalSize(cols) || !isTerminalSize(rows)) return true
  knownSizes.set(sessionId, { cols, rows })
  if (run) {
    run.cols = cols
    run.rows = rows
    if (!run.settled) run.host.resize(cols, rows)
  }
  return true
}

export function getLiveShellCommandSessionIds(): string[] {
  return Array.from(liveRuns.keys())
}

/**
 * The user stopped the run (Stop button, tab close, ticket dragged back). 'cancelled'
 * is persisted BEFORE anything is killed: the exit a dying tree reports is not
 * trustworthy (zsh says 1, bash dies by signal, sh says 0).
 */
export function cancelShellCommandRunIfLive(sessionId: string): boolean {
  const run = liveRuns.get(sessionId)
  if (!run || run.settled) return false
  run.settled = true
  run.buffer.flush()

  try {
    const current = readRunIfCurrent(sessionId, run.runId)
    if (current) {
      const cancelled: SessionShellCommand = {
        ...current.snapshot,
        state: 'cancelled',
        exitCode: null,
        signal: null,
        reason: null,
        finishedAt: nowIso()
      }
      writeSnapshot(sessionId, cancelled)
      publishStatus(sessionId, cancelled)
    }
  } catch (err) {
    log.warn('Persisting a cancelled shell command run failed', {
      sessionId,
      code: errorCode(err)
    })
  }

  liveRuns.delete(sessionId)
  run.buffer.append(SHELL_COMMAND_STOPPED_MARKER)
  run.buffer.flush()

  let stop: Promise<void>
  try {
    stop = run.host.stop()
  } catch {
    stop = Promise.resolve()
  }
  const stopped: Promise<void> = stop
    .catch(() => undefined)
    .finally(() => {
      run.buffer.close()
      if (run.detached) {
        const logFile = logFileOf(run.runDir)
        appendToShellCommandLog(logFile, SHELL_COMMAND_STOPPED_MARKER)
        trimShellCommandLog(logFile)
      }
      removeControlFiles(run.runDir)
      if (stoppingRuns.get(sessionId) === stopped) stoppingRuns.delete(sessionId)
    })
  stoppingRuns.set(sessionId, stopped)
  log.info('Shell command run cancelled', { sessionId, runId: run.runId })
  return true
}

/**
 * App quit, synchronous. Detached runs keep running and stay 'running' in the
 * database (the next launch adopts them); in-app runs die with their PTY right after
 * this and are recorded as 'interrupted'. Nothing is published: nobody is listening.
 */
export function detachShellCommandRunsForQuit(): void {
  for (const run of liveRuns.values()) {
    if (run.settled) continue
    run.settled = true
    try {
      if (run.detached) {
        run.host.detach()
        run.buffer.close()
        continue
      }
      run.buffer.append(SHELL_COMMAND_INTERRUPTED_MARKER)
      run.buffer.close()
      const current = readRunIfCurrent(run.sessionId, run.runId)
      if (current) {
        writeSnapshot(run.sessionId, finishedSnapshot(current.snapshot, { kind: 'lost' }))
      }
      run.host.detach()
    } catch (err) {
      log.warn('Releasing a shell command run on quit failed', {
        sessionId: run.sessionId,
        code: errorCode(err)
      })
    }
  }
  liveRuns.clear()
}

/** Compare-and-set finalize of a run this process does not hold live. */
function finalizeStoredRun(
  sessionId: string,
  expected: { runId: string | null; state: 'pending' | 'running' },
  exit: RunHostExit
): void {
  const current = readRun(sessionId)
  if (
    !current ||
    current.snapshot.runId !== expected.runId ||
    current.snapshot.state !== expected.state
  ) {
    return
  }
  const next = finishedSnapshot(current.snapshot, exit)
  writeSnapshot(sessionId, next)
  publishStatus(sessionId, next)
  log.info('Shell command run reconciled', { sessionId, runId: next.runId, state: next.state })
}

function finalizeDetachedFromResult(
  sessionId: string,
  runId: string,
  runDir: string,
  exit: RunHostExit
): void {
  trimShellCommandLog(logFileOf(runDir))
  removeControlFiles(runDir)
  finalizeStoredRun(sessionId, { runId, state: 'running' }, exit)
}

async function reconcileSession(session: Session): Promise<void> {
  const sessionId = session.id
  if (liveRuns.has(sessionId)) return
  const snapshot = parseSessionShellCommand(session.shell_command)
  if (!snapshot || !isShellCommandSession(session)) return

  if (snapshot.state === 'pending') {
    // A younger one may belong to a launcher that is mid-flight.
    const updatedAt = Date.parse(session.updated_at)
    if (!Number.isFinite(updatedAt) || Date.now() - updatedAt > PENDING_STALE_MS) {
      finalizeStoredRun(sessionId, { runId: snapshot.runId, state: 'pending' }, { kind: 'lost' })
    }
    return
  }
  if (snapshot.state !== 'running') return

  const runId = snapshot.runId
  const runDir = runDirOrNull(sessionId, runId)
  if (runId === null || runDir === null) {
    finalizeStoredRun(sessionId, { runId, state: 'running' }, { kind: 'lost' })
    return
  }

  if (snapshot.detached) {
    const result = readDetachedRunResult(runDir)
    if (result !== null) {
      finalizeDetachedFromResult(sessionId, runId, runDir, result)
      return
    }
  }

  if (runHasLiveOwner(runDir)) {
    // In-app: another running app instance owns it; the row is theirs to finalize.
    if (!snapshot.detached) return
    const size = sizeFor(sessionId)
    const run = createLiveRun(
      { sessionId, runId, runDir, detached: true, cols: size.cols, rows: size.rows },
      (sink) => factories.adoptDetached({ sessionId, runDir, sink })
    )
    if (!run.settled) liveRuns.set(sessionId, run)
    knownSizes.set(sessionId, size)
    log.info('Detached shell command run adopted', { sessionId, runId })
    return
  }

  if (snapshot.detached) {
    await delay(DETACHED_RESULT_GRACE_MS)
    const result = readDetachedRunResult(runDir)
    if (result !== null) {
      finalizeDetachedFromResult(sessionId, runId, runDir, result)
      return
    }
  }
  removeControlFiles(runDir)
  finalizeStoredRun(sessionId, { runId, state: 'running' }, { kind: 'lost' })
}

/**
 * Startup: settle what the previous app lifetime left behind. Finished detached runs
 * are finalized from their exit file, live ones are adopted, ownerless runs become
 * 'interrupted'. Never rejects.
 */
export async function reconcileShellCommandRuns(): Promise<void> {
  try {
    const sessions = getDatabase().getShellCommandSessionsInStates(['pending', 'running'])
    await Promise.all(
      sessions.map((session) =>
        reconcileSession(session).catch((err) => {
          log.warn('Reconciling a shell command run failed', {
            sessionId: session.id,
            code: errorCode(err)
          })
        })
      )
    )
  } catch (err) {
    log.warn('Reconciling shell command runs failed', { code: errorCode(err) })
  }
}

function isRunDirReferenced(sessionId: string, runId: string): boolean {
  if (!isValidShellCommandRunId(sessionId) || !isValidShellCommandRunId(runId)) return false
  if (liveRuns.get(sessionId)?.runId === runId) return true
  const session = getDatabase().getSession(sessionId)
  if (!session) return false
  return parseSessionShellCommand(session.shell_command)?.runId === runId
}

async function sweepRunDir(sessionId: string, runId: string, runDir: string): Promise<void> {
  const ageMs = Date.now() - statSync(runDir).mtimeMs
  if (ageMs < SWEEP_MIN_AGE_MS) return
  // A session's current run is kept for as long as the session exists.
  if (isRunDirReferenced(sessionId, runId)) return
  if (runHasLiveOwner(runDir)) {
    // In-app run of another app instance: never pulled out from under its owner.
    if (!existsSync(join(runDir, SHELL_COMMAND_RUN_FILES.hostPid))) return
    // A detached run that outlived its session (or was replaced by a newer run).
    await stopDetachedRun(runDir)
    removeDir(runDir)
    return
  }
  if (ageMs > RUN_DIR_ORPHAN_MAX_AGE_MS) removeDir(runDir)
}

/** Removes run directories nothing refers to any more. Never rejects. */
export async function sweepShellCommandRunDirs(): Promise<void> {
  try {
    const runsDir = getShellCommandRunsDir()
    if (!existsSync(runsDir)) return
    for (const sessionEntry of readdirSync(runsDir, { withFileTypes: true })) {
      if (!sessionEntry.isDirectory()) continue
      const sessionDir = join(runsDir, sessionEntry.name)
      try {
        for (const runEntry of readdirSync(sessionDir, { withFileTypes: true })) {
          if (!runEntry.isDirectory()) continue
          try {
            await sweepRunDir(sessionEntry.name, runEntry.name, join(sessionDir, runEntry.name))
          } catch (err) {
            log.warn('Sweeping a shell command run directory failed', { code: errorCode(err) })
          }
        }
        // Fails (and is ignored) while anything is left inside.
        rmdirSync(sessionDir)
      } catch {
        // Not empty, or already gone.
      }
    }
  } catch (err) {
    log.warn('Sweeping shell command run directories failed', { code: errorCode(err) })
  }
}

/** First pass shortly after launch, then every 6 hours. Never keeps the app alive. */
export function startShellCommandRunSweep(): void {
  if (sweepStarted) return
  sweepStarted = true
  const sweep = (): void => {
    void sweepShellCommandRunDirs().catch(() => undefined)
  }
  setTimeout(sweep, SWEEP_FIRST_DELAY_MS).unref()
  setInterval(sweep, SWEEP_INTERVAL_MS).unref()
}

/** Tests: replace some host factories (null restores the real ones and clears all state). */
export function setShellCommandRunHostFactoriesForTests(
  next: Partial<ShellCommandRunHostFactories> | null
): void {
  if (next === null) {
    factories = { ...defaultFactories }
    liveRuns.clear()
    knownSizes.clear()
    stoppingRuns.clear()
    return
  }
  factories = { ...factories, ...next }
}
