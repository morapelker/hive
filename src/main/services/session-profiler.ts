import { execFile } from 'node:child_process'
import { promises as fsp } from 'node:fs'
import os from 'node:os'
import type {
  SessionProfilerAgentKind,
  SessionProfilerIrrelevantReason,
  SessionProfilerKillRequest,
  SessionProfilerKillResult,
  SessionProfilerSession,
  SessionProfilerSnapshot,
  SessionProfilerTotals
} from '@shared/types/session-profiler'
import { getDatabase, type SessionProfilerDbRow } from '../db/database'
import { getClaudeCliBackgroundWorkCounts } from './claude-cli-background-work-tracker'
import { getClaudeCliSessionRecovery } from './claude-cli-session-recovery'
import { getLastClaudeCliStatus } from './claude-hook-server'
import { createLogger } from './logger'
import { ptyService, type PtyInstanceInfo } from './pty-service'
import {
  isAgentCliTerminal,
  isClaudeCliTurnPaused,
  isCodexCliTerminal,
  reapCliTerminal
} from './terminal-pty-bridge'

/**
 * Session profiler (Settings › Advanced, off by default): on demand, one `ps -A` of the
 * whole machine, narrowed to the Hive process tree, then mapped onto the agent CLI
 * sessions the app owns (the PTY registry) plus any agent CLI that leaked out of it (its
 * argv still carries the session's hook URL). Pull-only: nothing here runs until the
 * renderer asks — no timer, no listener, no subprocess at import time.
 */

const log = createLogger({ component: 'SessionProfiler' })

/** A snapshot younger than this is served from cache. */
const SNAPSHOT_CACHE_MS = 3_000
/** A previous CPU sample older than this is too coarse a window: re-prime instead. */
const CPU_SAMPLE_MAX_AGE_MS = 5 * 60_000
/** Window of the priming sample taken when no usable previous sample exists. */
const CPU_PRIME_WINDOW_MS = 1_500
/** Seconds without terminal I/O after which an otherwise quiet session counts as idle. */
export const SESSION_PROFILER_IDLE_THRESHOLD_SECONDS = 30 * 60
const PS_TIMEOUT_MS = 5_000
const PS_MAX_BUFFER = 16 << 20
const KILL_GRACE_MS = 3_000
const KILL_POLL_MS = 100
/**
 * How long the processes of a session the profiler stopped are remembered: a snapshot taken
 * meanwhile shows them as stopping (not as a fresh untracked leftover). Entries also go as
 * soon as a sample no longer has the process.
 */
const STOPPING_MEMORY_MS = 30_000
/**
 * procps derives `lstart` from the wall-clock boot time, which moves when the clock is
 * stepped (NTP, resume): off macOS, start times this close are the same process.
 */
const START_TOLERANCE_MS = 2_000

/** Hook URL on an agent CLI's argv: `/hook/<session>/` (claude) or `/codex-hook/<session>/`. */
const HOOK_URL_PATTERN = /\/(?:codex-)?hook\/([0-9a-f-]{36})\//

/** Live statuses during which the agent is busy or waiting on the user: never flagged. */
const BUSY_LIVE_STATUSES: ReadonlySet<string> = new Set([
  'working',
  'planning',
  'answering',
  'permission',
  'command_approval',
  'plan_ready'
])

// ── ps parsing ─────────────────────────────────────────────────────────────

export interface PsProcess {
  pid: number
  ppid: number
  pgid: number
  rssBytes: number
  /** Cumulative CPU time (user + system), seconds. */
  cpuSeconds: number
  elapsedSeconds: number
  stat: string
  /** Controlling terminal as ps prints it (`16/17` tdev on macOS, `pts/3` on Linux), null if none. */
  tty: string | null
  /** `lstart` with whitespace collapsed — with the pid, identifies the process across pid reuse. */
  startedAt: string
  args: string
}

export function psArgs(platform: NodeJS.Platform): string[] {
  // macOS `tty=` costs a device lookup per process; `tdev=` is the raw dev_t. procps has
  // no tdev, and its tty column is cheap.
  const ttyColumn = platform === 'darwin' ? 'tdev=' : 'tty='
  return ['-A', '-ww', '-o', `pid=,ppid=,pgid=,rss=,time=,etime=,stat=,${ttyColumn},lstart=,args=`]
}

/**
 * `[DD-][HH:]MM:SS[.cc]` → seconds. Covers ps `etime` everywhere, procps `time`
 * (`[DD-]HH:MM:SS`) and macOS `time` (`MMMM:SS.cc`, minutes unbounded). NaN if malformed.
 */
export function parsePsDuration(value: string): number {
  const match = /^(?:(\d+)-)?(\d+(?::\d+){0,2})(?:\.(\d+))?$/.exec(value.trim())
  if (!match) return Number.NaN
  const days = match[1] ? Number(match[1]) : 0
  const parts = match[2].split(':').map(Number)
  let seconds = 0
  for (const part of parts) seconds = seconds * 60 + part
  const fraction = match[3] ? Number(`0.${match[3]}`) : 0
  return days * 86_400 + seconds + fraction
}

const PS_LINE_PATTERN =
  /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+([A-Z][a-z]{2}\s+[A-Z][a-z]{2}\s+\d{1,2}\s+\d{1,2}:\d{2}:\d{2}\s+\d{4})(?:\s+(.*))?$/

/** One line of {@link psArgs} output; null for lines that do not parse. */
export function parsePsLine(line: string): PsProcess | null {
  const match = PS_LINE_PATTERN.exec(line)
  if (!match) return null
  const cpuSeconds = parsePsDuration(match[5])
  const elapsedSeconds = parsePsDuration(match[6])
  const tty = match[8]
  return {
    pid: Number(match[1]),
    ppid: Number(match[2]),
    pgid: Number(match[3]),
    rssBytes: Number(match[4]) * 1024,
    cpuSeconds: Number.isFinite(cpuSeconds) ? cpuSeconds : 0,
    elapsedSeconds: Number.isFinite(elapsedSeconds) ? elapsedSeconds : 0,
    stat: match[7],
    tty: tty === '??' || tty === '?' || tty === '-' ? null : tty,
    startedAt: normalizeStartedAt(match[9]),
    args: (match[10] ?? '').trimEnd()
  }
}

export function parsePsOutput(stdout: string): Map<number, PsProcess> {
  const processes = new Map<number, PsProcess>()
  for (const line of stdout.split('\n')) {
    const proc = parsePsLine(line)
    if (proc) processes.set(proc.pid, proc)
  }
  return processes
}

export function normalizeStartedAt(value: string): string {
  return value.trim().replace(/\s+/g, ' ')
}

// ── process tree ───────────────────────────────────────────────────────────

export function buildChildrenIndex(
  processes: ReadonlyMap<number, PsProcess>
): Map<number, number[]> {
  const children = new Map<number, number[]>()
  for (const proc of processes.values()) {
    if (proc.ppid === proc.pid) continue
    const list = children.get(proc.ppid)
    if (list) list.push(proc.pid)
    else children.set(proc.ppid, [proc.pid])
  }
  return children
}

/** `root` and every descendant present in the sample (iterative DFS, cycle-safe). */
export function collectSubtree(root: number, children: ReadonlyMap<number, number[]>): Set<number> {
  const seen = new Set<number>([root])
  const stack = [root]
  while (stack.length > 0) {
    const pid = stack.pop() as number
    for (const child of children.get(pid) ?? []) {
      if (seen.has(child)) continue
      seen.add(child)
      stack.push(child)
    }
  }
  return seen
}

/** Ancestors of `pid` in the sample, nearest first (excludes `pid`). */
export function collectAncestors(pid: number, processes: ReadonlyMap<number, PsProcess>): number[] {
  const ancestors: number[] = []
  const seen = new Set<number>([pid])
  let current = processes.get(pid)
  while (current && !seen.has(current.ppid) && current.ppid > 0) {
    ancestors.push(current.ppid)
    seen.add(current.ppid)
    current = processes.get(current.ppid)
  }
  return ancestors
}

// ── CPU ────────────────────────────────────────────────────────────────────

export interface CpuSample {
  sampledAt: number
  /** `pid:startedAt` → cumulative CPU seconds. */
  cpuByProcess: Map<string, number>
  /**
   * pid → cumulative CPU seconds and start time estimated from `etime` (epoch seconds) — a
   * second identity that survives an `lstart` shift after a clock step (procps).
   */
  byPid: Map<number, { cpuSeconds: number; startEstimateSec: number }>
}

export function processKey(proc: Pick<PsProcess, 'pid' | 'startedAt'>): string {
  return `${proc.pid}:${proc.startedAt}`
}

export function makeCpuSample(
  processes: ReadonlyMap<number, PsProcess>,
  sampledAt: number
): CpuSample {
  const cpuByProcess = new Map<string, number>()
  const byPid = new Map<number, { cpuSeconds: number; startEstimateSec: number }>()
  for (const proc of processes.values()) {
    cpuByProcess.set(processKey(proc), proc.cpuSeconds)
    byPid.set(proc.pid, {
      cpuSeconds: proc.cpuSeconds,
      startEstimateSec: sampledAt / 1000 - proc.elapsedSeconds
    })
  }
  return { sampledAt, cpuByProcess, byPid }
}

/** Seconds of etime-derived start-time drift still read as the same process. */
const START_ESTIMATE_TOLERANCE_SEC = 2

/**
 * CPU seconds each process used since `previous`, by pid. A process absent from the
 * previous sample started inside the window, so all of its CPU time is new. With
 * `sampledAt` (of `processes`), a pid whose `lstart` changed but whose etime-derived start
 * did not is still the same process (procps `lstart` moves when the wall clock is stepped).
 */
export function cpuDeltas(
  processes: ReadonlyMap<number, PsProcess>,
  previous: CpuSample,
  sampledAt?: number
): Map<number, number> {
  const deltas = new Map<number, number>()
  for (const proc of processes.values()) {
    let before = previous.cpuByProcess.get(processKey(proc))
    if (before === undefined && sampledAt !== undefined) {
      const earlier = previous.byPid.get(proc.pid)
      const startEstimateSec = sampledAt / 1000 - proc.elapsedSeconds
      if (
        earlier &&
        Math.abs(earlier.startEstimateSec - startEstimateSec) <= START_ESTIMATE_TOLERANCE_SEC
      ) {
        before = earlier.cpuSeconds
      }
    }
    deltas.set(proc.pid, Math.max(0, proc.cpuSeconds - (before ?? 0)))
  }
  return deltas
}

/**
 * Whether two `lstart` values name the same process start. Exact on macOS (its start time
 * is stable); elsewhere within {@link START_TOLERANCE_MS}, since procps shifts `lstart`
 * when the wall clock is stepped.
 */
export function sameStartedAt(a: string, b: string, platform: NodeJS.Platform): boolean {
  const left = normalizeStartedAt(a)
  const right = normalizeStartedAt(b)
  if (left === right) return true
  if (platform === 'darwin') return false
  const leftMs = Date.parse(left)
  const rightMs = Date.parse(right)
  return (
    Number.isFinite(leftMs) &&
    Number.isFinite(rightMs) &&
    Math.abs(leftMs - rightMs) <= START_TOLERANCE_MS
  )
}

/** Percent of one core used by `pids` over `windowMs` (may exceed 100). */
export function cpuPercentOf(
  pids: Iterable<number>,
  deltas: ReadonlyMap<number, number>,
  windowMs: number
): number {
  if (windowMs <= 0) return 0
  let seconds = 0
  for (const pid of pids) seconds += deltas.get(pid) ?? 0
  return roundTo((seconds / (windowMs / 1000)) * 100, 1)
}

function roundTo(value: number, digits: number): number {
  const factor = 10 ** digits
  return Math.round(value * factor) / factor
}

// ── session detection ──────────────────────────────────────────────────────

export interface DetectedSession {
  sessionId: string | null
  rootPid: number
  tracked: boolean
  /** Agent kind as far as the process itself says (hook URL flavour), for untracked roots. */
  argvAgent: 'claude' | 'codex' | null
  pty: PtyInstanceInfo | null
  pids: Set<number>
  /** Processes of a session the profiler just stopped, still exiting. */
  stopping: boolean
}

export function matchHookSessionId(args: string): { sessionId: string; codex: boolean } | null {
  const match = HOOK_URL_PATTERN.exec(args)
  if (!match) return null
  return { sessionId: match[1], codex: match[0].startsWith('/codex-') }
}

/**
 * Parents an orphan of the app can have been reparented to: init, or — on Linux, where an
 * orphan goes to the nearest child subreaper — a `systemd` user manager above the app. Never
 * any other ancestor: an app launched from another Hive instance's terminal (a dev
 * build run from a session) has that instance's main above it, and its live agents carry
 * matching hook URLs too — they must not read as our leftovers.
 */
export function orphanParentsOf(
  appPid: number,
  processes: ReadonlyMap<number, PsProcess>,
  platform: NodeJS.Platform
): Set<number> {
  const parents = new Set<number>([1])
  if (platform !== 'linux') return parents
  for (const ancestor of collectAncestors(appPid, processes)) {
    const executable = processes.get(ancestor)?.args.split(/\s+/, 1)[0] ?? ''
    if (/(^|\/)systemd$/.test(executable)) parents.add(ancestor)
  }
  return parents
}

/**
 * (a) every agent CLI PTY in the registry whose process is alive, with its whole subtree
 * (custom providers run the agent as a grandchild under `$SHELL -ilc`); then (b) every
 * process in the app tree, or orphaned (see {@link orphanParentsOf}), whose argv carries a
 * session hook URL and that is not already inside a tracked subtree — only the topmost of a
 * chain; then (c) whatever is left of the sessions the profiler just stopped (`stopping`,
 * `pid:startedAt` → session id): the exiting agent, and tool shells / dev servers that ran
 * in their own process group and carry no hook URL — listed under their session as stopping.
 */
export function detectSessions(input: {
  processes: ReadonlyMap<number, PsProcess>
  children: ReadonlyMap<number, number[]>
  appTree: ReadonlySet<number>
  ptys: readonly PtyInstanceInfo[]
  isAgentCliTerminal: (id: string) => boolean
  /** Defaults to init only. */
  orphanParents?: ReadonlySet<number>
  stopping?: ReadonlyMap<string, string>
}): DetectedSession[] {
  const { processes, children, appTree, ptys } = input
  const orphanParents = input.orphanParents ?? new Set([1])
  const stopping = input.stopping ?? new Map<string, string>()
  const sessions: DetectedSession[] = []
  const covered = new Set<number>()

  for (const pty of ptys) {
    if (!pty.pid || !processes.has(pty.pid) || !input.isAgentCliTerminal(pty.id)) continue
    const pids = collectSubtree(pty.pid, children)
    for (const pid of pids) covered.add(pid)
    sessions.push({
      sessionId: pty.id,
      rootPid: pty.pid,
      tracked: true,
      argvAgent: null,
      pty,
      pids,
      stopping: false
    })
  }

  const candidates = new Map<number, { sessionId: string; codex: boolean }>()
  for (const proc of processes.values()) {
    if (covered.has(proc.pid)) continue
    if (!appTree.has(proc.pid) && !orphanParents.has(proc.ppid)) continue
    const hook = matchHookSessionId(proc.args)
    if (hook) candidates.set(proc.pid, hook)
  }
  const stoppingRows = new Map<string, DetectedSession>()
  for (const [pid, hook] of candidates) {
    if (collectAncestors(pid, processes).some((ancestor) => candidates.has(ancestor))) continue
    const pids = collectSubtree(pid, children)
    for (const member of pids) covered.add(member)
    const root = processes.get(pid) as PsProcess
    const row: DetectedSession = {
      sessionId: hook.sessionId,
      rootPid: pid,
      tracked: false,
      argvAgent: hook.codex ? 'codex' : 'claude',
      pty: null,
      pids,
      stopping: stopping.has(processKey(root))
    }
    sessions.push(row)
    if (row.stopping && !stoppingRows.has(hook.sessionId)) stoppingRows.set(hook.sessionId, row)
  }

  if (stopping.size === 0) return sessions
  const leftovers = new Map<number, string>()
  for (const proc of processes.values()) {
    if (covered.has(proc.pid)) continue
    const sessionId = stopping.get(processKey(proc))
    if (sessionId) leftovers.set(proc.pid, sessionId)
  }
  for (const [pid, sessionId] of leftovers) {
    if (collectAncestors(pid, processes).some((ancestor) => leftovers.has(ancestor))) continue
    const pids = new Set(
      [...collectSubtree(pid, children)].filter((member) => !covered.has(member))
    )
    for (const member of pids) covered.add(member)
    // One row per stopped session: a dev server that outlived the agent joins its row.
    const existing = stoppingRows.get(sessionId)
    if (existing) {
      for (const member of pids) existing.pids.add(member)
      continue
    }
    const row: DetectedSession = {
      sessionId,
      rootPid: pid,
      tracked: false,
      argvAgent: null,
      pty: null,
      pids,
      stopping: true
    }
    stoppingRows.set(sessionId, row)
    sessions.push(row)
  }
  return sessions
}

// ── irrelevance ────────────────────────────────────────────────────────────

export interface IrrelevanceInput {
  tracked: boolean
  /** DB context; undefined when the DB could not be read (nothing DB-based is inferred). */
  dbRow: SessionProfilerDbRow | undefined
  liveStatus: string | null
  backgroundWork: number
  /** The agent will wake itself (scheduled wakeup / pending auto-resume): never idle. */
  paused: boolean
  /** Being stopped by the profiler right now: nothing to offer. */
  stopping: boolean
  idleSeconds: number | null
  idleThresholdSeconds: number
}

export function isBusyLiveStatus(status: string | null | undefined): boolean {
  return !!status && BUSY_LIVE_STATUSES.has(status)
}

/** Why a session looks safe to stop, most significant first; [] when it must be left alone. */
export function deriveIrrelevantReasons(
  input: IrrelevanceInput
): SessionProfilerIrrelevantReason[] {
  const { dbRow } = input
  // A busy agent, or one a document run still needs, is never offered for clearing.
  if (isBusyLiveStatus(input.liveStatus)) return []
  if (dbRow?.documentRunBusy) return []
  if (input.stopping) return []
  const reasons: SessionProfilerIrrelevantReason[] = []
  if (dbRow) {
    if (!dbRow.sessionExists) reasons.push('no_session_row')
    if (dbRow.status === 'completed' || dbRow.status === 'error') reasons.push('session_completed')
    if (dbRow.worktreeArchived) reasons.push('worktree_archived')
    // Done and Merged both end a ticket's work (the board closes the session on entering
    // either); a merged ticket a document run still has to ask for its document update is
    // kept by `documentRunBusy` above.
    if (
      dbRow.ticket &&
      (dbRow.ticket.column === 'done' || dbRow.ticket.column === 'merged' || dbRow.ticket.archived)
    ) {
      reasons.push('ticket_done')
    }
  }
  if (!input.tracked) reasons.push('untracked')
  if (
    input.idleSeconds !== null &&
    input.idleSeconds >= input.idleThresholdSeconds &&
    input.backgroundWork === 0 &&
    !input.paused
  ) {
    reasons.push('idle')
  }
  return reasons
}

export function agentKindFor(
  agentSdk: string | null | undefined,
  fallback: 'claude' | 'codex' | null
): SessionProfilerAgentKind {
  if (agentSdk === 'codex-cli' || agentSdk === 'codex') return 'codex'
  if (agentSdk === 'claude-code-cli' || agentSdk === 'claude-code') return 'claude'
  if (agentSdk === 'opencode') return 'opencode'
  return fallback ?? 'other'
}

/** Device path of a ps tty column, with the dev_t to verify it against (macOS), or null. */
export function ttyDevicePath(
  tty: string | null,
  platform: NodeJS.Platform
): { path: string; rdev: number | null } | null {
  if (!tty) return null
  if (platform === 'darwin') {
    // tdev prints `major/minor`; pseudo-terminal slaves are /dev/ttysNNN (minor, 3 digits).
    const match = /^(\d+)\/(\d+)$/.exec(tty)
    if (!match) return null
    const major = Number(match[1])
    const minor = Number(match[2])
    if (minor > 999) return null
    // XNU dev_t: major in the top byte, minor below.
    return { path: `/dev/ttys${String(minor).padStart(3, '0')}`, rdev: major * 2 ** 24 + minor }
  }
  if (/^(?:pts\/\d+|tty[\w]+)$/.test(tty)) return { path: `/dev/${tty}`, rdev: null }
  return null
}

// ── profiler ───────────────────────────────────────────────────────────────

export interface SessionProfilerDeps {
  platform: NodeJS.Platform
  appPid: number
  appParentPid: number
  /** Runs {@link psArgs}; `psPid` lets the sample leave the ps process itself out. */
  runPs: () => Promise<{ stdout: string; psPid: number | null }>
  listPtys: () => PtyInstanceInfo[]
  hasPty: (id: string) => boolean
  isAgentCliTerminal: (id: string) => boolean
  isCodexCliTerminal: (id: string) => boolean
  reapCliTerminal: (id: string) => boolean
  getDbRows: (ids: string[]) => SessionProfilerDbRow[]
  getLiveStatus: (id: string) => string | undefined
  getBackgroundWork: (id: string) => number
  /** The turn ended but the agent wakes itself again (scheduled wakeup, pending auto-resume). */
  isPaused: (id: string) => boolean
  statTty: (path: string) => Promise<{ atimeMs: number; mtimeMs: number; rdev: number } | null>
  /** process.kill */
  kill: (pid: number, signal: NodeJS.Signals | 0) => void
  cpuCount: () => number
  now: () => number
  sleep: (ms: number) => Promise<void>
}

export interface SessionProfilerKillOptions {
  /** Pids that must never be signalled (the server child). */
  protectedPids?: readonly number[]
}

interface PsSample {
  processes: Map<number, PsProcess>
  sampledAt: number
}

/** A process that was in a session's subtree when the profiler stopped it. */
interface StoppedMember {
  pid: number
  startedAt: string
  pgid: number
}

const emptyTotals = (cpuCount: number): SessionProfilerTotals => ({
  processCount: 0,
  cpuPercent: null,
  agentCpuPercent: null,
  rssBytes: 0,
  agentRssBytes: 0,
  cpuCount
})

export function createSessionProfiler(deps: SessionProfilerDeps): {
  getSnapshot: () => Promise<SessionProfilerSnapshot>
  kill: (
    req: SessionProfilerKillRequest,
    options?: SessionProfilerKillOptions
  ) => Promise<SessionProfilerKillResult>
  invalidate: () => void
} {
  let previousCpu: CpuSample | null = null
  let cached: SessionProfilerSnapshot | null = null
  let inFlight: { generation: number; promise: Promise<SessionProfilerSnapshot> } | null = null
  // Bumped by kills: a snapshot started before one must not be served after it.
  let generation = 0
  // `pid:startedAt` of the processes of sessions stopped moments ago → session id + expiry.
  const recentlyStopped = new Map<string, { sessionId: string; until: number }>()

  const cpuCount = (): number => Math.max(1, deps.cpuCount())

  const samplePs = async (): Promise<PsSample> => {
    const { stdout, psPid } = await deps.runPs()
    const sampledAt = deps.now()
    const processes = parsePsOutput(stdout)
    if (psPid) processes.delete(psPid)
    return { processes, sampledAt }
  }

  const ttyIdleSeconds = async (proc: PsProcess, now: number): Promise<number | null> => {
    const device = ttyDevicePath(proc.tty, deps.platform)
    if (!device) return null
    try {
      const stat = await deps.statTty(device.path)
      if (!stat) return null
      if (device.rdev !== null && stat.rdev !== device.rdev) return null
      const last = Math.max(stat.atimeMs, stat.mtimeMs)
      return Math.max(0, Math.floor((now - last) / 1000))
    } catch {
      return null
    }
  }

  /**
   * The remembered processes of recently stopped sessions that `processes` still has, as
   * `pid:startedAt` → session id; forgets the expired ones and those that are gone.
   */
  const stoppingSessions = (processes: ReadonlyMap<number, PsProcess>): Map<string, string> => {
    const now = deps.now()
    const live = new Set<string>()
    for (const proc of processes.values()) live.add(processKey(proc))
    const out = new Map<string, string>()
    for (const [key, entry] of recentlyStopped) {
      if (entry.until <= now || !live.has(key)) recentlyStopped.delete(key)
      else out.set(key, entry.sessionId)
    }
    return out
  }

  const buildSnapshot = async (): Promise<SessionProfilerSnapshot> => {
    let sample: PsSample
    let windowMs: number
    let deltas: Map<number, number>
    const previous = previousCpu
    if (!previous || deps.now() - previous.sampledAt > CPU_SAMPLE_MAX_AGE_MS) {
      // No usable baseline: prime, wait, and measure a short window now.
      const prime = await samplePs()
      await deps.sleep(CPU_PRIME_WINDOW_MS)
      sample = await samplePs()
      const baseline = makeCpuSample(prime.processes, prime.sampledAt)
      windowMs = sample.sampledAt - prime.sampledAt
      deltas = cpuDeltas(sample.processes, baseline, sample.sampledAt)
    } else {
      sample = await samplePs()
      windowMs = sample.sampledAt - previous.sampledAt
      deltas = cpuDeltas(sample.processes, previous, sample.sampledAt)
    }
    previousCpu = makeCpuSample(sample.processes, sample.sampledAt)

    const { processes, sampledAt } = sample
    const children = buildChildrenIndex(processes)
    const appTree = collectSubtree(deps.appPid, children)
    const ptys = deps.listPtys()
    const detected = detectSessions({
      processes,
      children,
      appTree,
      ptys,
      isAgentCliTerminal: deps.isAgentCliTerminal,
      orphanParents: orphanParentsOf(deps.appPid, processes, deps.platform),
      stopping: stoppingSessions(processes)
    })

    const ids = [...new Set(detected.map((s) => s.sessionId).filter((id): id is string => !!id))]
    let dbRows: Map<string, SessionProfilerDbRow> | null = null
    try {
      dbRows = new Map(deps.getDbRows(ids).map((row) => [row.id, row]))
    } catch (error) {
      log.warn('Session profiler: DB enrichment failed', {
        error: error instanceof Error ? error.message : String(error)
      })
    }

    const window = windowMs > 0 ? windowMs : null
    const agentPids = new Set<number>()
    const sessions: SessionProfilerSession[] = []
    for (const found of detected) {
      const root = processes.get(found.rootPid)
      if (!root) continue
      const dbRow = found.sessionId && dbRows ? dbRows.get(found.sessionId) : undefined
      // Main's live status is only meaningful while the registry still owns the PTY.
      const owned = found.tracked && !!found.sessionId && deps.hasPty(found.sessionId)
      const liveStatus = owned ? (deps.getLiveStatus(found.sessionId as string) ?? null) : null
      const backgroundWork = owned ? deps.getBackgroundWork(found.sessionId as string) : 0
      const paused = owned && deps.isPaused(found.sessionId as string)
      const idleSeconds = found.pty
        ? Math.max(
            0,
            Math.floor((sampledAt - Math.max(found.pty.lastOutputAt, found.pty.lastInputAt)) / 1000)
          )
        : await ttyIdleSeconds(root, sampledAt)

      let rssBytes = 0
      let cpuSeconds = 0
      for (const pid of found.pids) {
        const proc = processes.get(pid)
        if (!proc) continue
        agentPids.add(pid)
        rssBytes += proc.rssBytes
        cpuSeconds += proc.cpuSeconds
      }
      const fallbackAgent =
        found.argvAgent ??
        (found.sessionId && deps.isCodexCliTerminal(found.sessionId) ? 'codex' : 'claude')

      sessions.push({
        sessionId: found.sessionId,
        pid: found.rootPid,
        startedAt: root.startedAt,
        agent: agentKindFor(dbRow?.agentSdk, fallbackAgent),
        tracked: found.tracked,
        name: dbRow?.name ?? null,
        dbStatus: dbRow?.sessionExists ? dbRow.status : null,
        liveStatus,
        backgroundWork,
        paused,
        stopping: found.stopping,
        ticket: dbRow?.ticket ?? null,
        worktreeName: dbRow?.worktreeName ?? null,
        worktreePath: dbRow?.worktreePath ?? null,
        worktreeArchived: dbRow?.worktreeArchived ?? false,
        projectName: dbRow?.projectName ?? null,
        cwd: found.pty?.cwd ?? null,
        processCount: found.pids.size,
        rssBytes,
        cpuPercent: window === null ? null : cpuPercentOf(found.pids, deltas, window),
        cpuSeconds: roundTo(cpuSeconds, 2),
        elapsedSeconds: Math.floor(root.elapsedSeconds),
        idleSeconds,
        irrelevantReasons: deriveIrrelevantReasons({
          tracked: found.tracked,
          dbRow,
          liveStatus,
          backgroundWork,
          paused,
          stopping: found.stopping,
          idleSeconds,
          idleThresholdSeconds: SESSION_PROFILER_IDLE_THRESHOLD_SECONDS
        })
      })
    }
    sessions.sort((a, b) => b.rssBytes - a.rssBytes)

    // Agent sessions that leaked out of the tree (adopted by init) count in the totals too, so
    // the agent figures stay a subset of them.
    const totalPids = new Set<number>(appTree)
    for (const pid of agentPids) totalPids.add(pid)
    let rssBytes = 0
    for (const pid of totalPids) rssBytes += processes.get(pid)?.rssBytes ?? 0
    let agentRssBytes = 0
    for (const pid of agentPids) agentRssBytes += processes.get(pid)?.rssBytes ?? 0

    return {
      supported: true,
      sampledAt,
      cpuWindowMs: window,
      idleThresholdSeconds: SESSION_PROFILER_IDLE_THRESHOLD_SECONDS,
      sessions,
      totals: {
        processCount: totalPids.size,
        cpuPercent: window === null ? null : cpuPercentOf(totalPids, deltas, window),
        agentCpuPercent: window === null ? null : cpuPercentOf(agentPids, deltas, window),
        rssBytes,
        agentRssBytes,
        cpuCount: cpuCount()
      }
    }
  }

  const getSnapshot = async (): Promise<SessionProfilerSnapshot> => {
    if (deps.platform === 'win32') {
      return {
        supported: false,
        sampledAt: deps.now(),
        cpuWindowMs: null,
        idleThresholdSeconds: SESSION_PROFILER_IDLE_THRESHOLD_SECONDS,
        sessions: [],
        totals: emptyTotals(cpuCount())
      }
    }
    if (cached && deps.now() - cached.sampledAt < SNAPSHOT_CACHE_MS) return cached
    if (inFlight && inFlight.generation === generation) return inFlight.promise

    const startedGeneration = generation
    const promise = buildSnapshot()
      .then((snapshot) => {
        if (startedGeneration === generation) cached = snapshot
        return snapshot
      })
      .catch((error: unknown): SessionProfilerSnapshot => {
        const message = error instanceof Error ? error.message : String(error)
        log.warn('Session profiler: sampling failed', { error: message })
        return {
          supported: true,
          sampledAt: deps.now(),
          cpuWindowMs: null,
          idleThresholdSeconds: SESSION_PROFILER_IDLE_THRESHOLD_SECONDS,
          sessions: [],
          totals: emptyTotals(cpuCount()),
          error: message
        }
      })
      .finally(() => {
        if (inFlight?.promise === promise) inFlight = null
      })
    inFlight = { generation: startedGeneration, promise }
    return promise
  }

  const invalidate = (): void => {
    generation += 1
    cached = null
  }

  const isAlive = (target: number): boolean => {
    try {
      deps.kill(target, 0)
      return true
    } catch (error) {
      // EPERM: it exists but is not ours to signal — still alive.
      return (error as NodeJS.ErrnoException)?.code === 'EPERM'
    }
  }

  const signalProcess = async (proc: PsProcess): Promise<SessionProfilerKillResult> => {
    // The agent CLI leads its own process group (a PTY child is a session leader): signal the
    // group so its tool children go with it. A non-leader is signalled alone.
    const target = proc.pgid === proc.pid ? -proc.pid : proc.pid
    const stillAlive = (): boolean => isAlive(proc.pid) || (target < 0 && isAlive(target))
    try {
      deps.kill(target, 'SIGTERM')
    } catch (error) {
      const code = (error as NodeJS.ErrnoException)?.code
      if (code === 'ESRCH') return { ok: true, method: 'signal' }
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
    const deadline = deps.now() + KILL_GRACE_MS
    while (deps.now() < deadline) {
      if (!stillAlive()) return { ok: true, method: 'signal' }
      await deps.sleep(KILL_POLL_MS)
    }
    if (!stillAlive()) return { ok: true, method: 'signal' }
    log.warn('Session profiler: process survived SIGTERM, escalating to SIGKILL', {
      pid: proc.pid,
      group: target < 0
    })
    try {
      deps.kill(target, 'SIGKILL')
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== 'ESRCH') {
        return { ok: false, error: error instanceof Error ? error.message : String(error) }
      }
    }
    return { ok: true, method: 'signal' }
  }

  /** Pids that must never be signalled: the app, its parent and the caller's protected ones. */
  const refusedPids = (options: SessionProfilerKillOptions): Set<number> =>
    new Set<number>([deps.appPid, deps.appParentPid, ...(options.protectedPids ?? [])])

  /** The subtree of `rootPid` in a sample, for the after-stop sweep and the stopping label. */
  const subtreeMembers = (
    rootPid: number,
    processes: ReadonlyMap<number, PsProcess>
  ): StoppedMember[] => {
    const members: StoppedMember[] = []
    for (const pid of collectSubtree(rootPid, buildChildrenIndex(processes))) {
      const proc = processes.get(pid)
      if (proc) members.push({ pid, startedAt: proc.startedAt, pgid: proc.pgid })
    }
    return members
  }

  const rememberStopping = (sessionId: string, members: readonly StoppedMember[]): void => {
    const until = deps.now() + STOPPING_MEMORY_MS
    for (const member of members) recentlyStopped.set(processKey(member), { sessionId, until })
  }

  const forgetStopping = (members: readonly StoppedMember[]): void => {
    for (const member of members) recentlyStopped.delete(processKey(member))
  }

  /** Bounded wait for a process to exit. */
  const waitForExit = async (pid: number): Promise<void> => {
    const deadline = deps.now() + KILL_GRACE_MS
    while (deps.now() < deadline && isAlive(pid)) await deps.sleep(KILL_POLL_MS)
  }

  /**
   * Signal targets for the members of a stopped session that are still alive (`survivors`,
   * identity checked against `processes`): the whole group of a survivor that leads one —
   * a Bash-tool shell or dev server that setsid'd, plus whatever it spawned since — else the
   * pid alone. Never a group holding a refused pid or an ancestor of the app.
   */
  const sweepTargets = (
    survivors: readonly StoppedMember[],
    processes: ReadonlyMap<number, PsProcess>,
    refused: ReadonlySet<number>
  ): number[] => {
    const appAncestors = new Set(collectAncestors(deps.appPid, processes))
    const forbidden = (pid: number): boolean =>
      pid <= 1 || refused.has(pid) || appAncestors.has(pid)
    const groupIsSafe = (pgid: number): boolean => {
      for (const proc of processes.values()) {
        if (proc.pgid === pgid && forbidden(proc.pid)) return false
      }
      return true
    }
    const survivorPids = new Set(survivors.map((member) => member.pid))
    const groups = new Set<number>()
    for (const member of survivors) {
      if (member.pgid === member.pid && !forbidden(member.pid) && groupIsSafe(member.pid)) {
        groups.add(member.pid)
      }
    }
    const targets = [...groups].map((pgid) => -pgid)
    for (const member of survivors) {
      if (forbidden(member.pid)) continue
      // Covered by its group's signal (the leader is a survivor of ours, so the group is too).
      if (groups.has(member.pgid) && survivorPids.has(member.pgid)) continue
      targets.push(member.pid)
    }
    return targets
  }

  const signalTargets = (targets: readonly number[], signal: NodeJS.Signals): void => {
    for (const target of targets) {
      try {
        deps.kill(target, signal)
      } catch {
        // ESRCH: gone already. Anything else: nothing more to do from here.
      }
    }
  }

  /**
   * After a session's agent is gone, stop what it left behind: members of its subtree at
   * stop time that run in their own process group (Bash-tool shells, dev servers) are not
   * reached by the group signal, and would otherwise run on for hours adopted by init.
   * TERM, a grace period, then KILL — each round re-verifying identity with a fresh sample,
   * so a recycled pid is never touched.
   */
  const sweepSurvivors = async (
    members: readonly StoppedMember[],
    refused: ReadonlySet<number>
  ): Promise<void> => {
    const verified = async (
      candidates: readonly StoppedMember[]
    ): Promise<{ survivors: StoppedMember[]; processes: Map<number, PsProcess> }> => {
      const alive = candidates.filter((member) => isAlive(member.pid))
      if (alive.length === 0) return { survivors: [], processes: new Map() }
      const { processes } = await samplePs()
      const survivors = alive.filter((member) => {
        const proc = processes.get(member.pid)
        return !!proc && sameStartedAt(proc.startedAt, member.startedAt, deps.platform)
      })
      return { survivors, processes }
    }

    let round = await verified(members)
    if (round.survivors.length === 0) return
    log.info('Session profiler: stopping processes the stopped session left behind', {
      pids: round.survivors.map((member) => member.pid)
    })
    signalTargets(sweepTargets(round.survivors, round.processes, refused), 'SIGTERM')
    const deadline = deps.now() + KILL_GRACE_MS
    while (deps.now() < deadline && round.survivors.some((member) => isAlive(member.pid))) {
      await deps.sleep(KILL_POLL_MS)
    }
    round = await verified(round.survivors)
    if (round.survivors.length === 0) return
    log.warn('Session profiler: left-behind processes survived SIGTERM, escalating to SIGKILL', {
      pids: round.survivors.map((member) => member.pid)
    })
    signalTargets(sweepTargets(round.survivors, round.processes, refused), 'SIGKILL')
  }

  /** The sweep is best effort: the session itself is stopped whatever happens to it. */
  const sweepQuietly = async (
    members: readonly StoppedMember[],
    refused: ReadonlySet<number>
  ): Promise<void> => {
    try {
      await sweepSurvivors(members, refused)
    } catch (error) {
      log.warn('Session profiler: sweeping left-behind processes failed', {
        error: error instanceof Error ? error.message : String(error)
      })
    }
  }

  const killByPid = async (
    req: SessionProfilerKillRequest,
    options: SessionProfilerKillOptions
  ): Promise<SessionProfilerKillResult> => {
    const pid = req.pid
    if (typeof pid !== 'number' || !Number.isInteger(pid)) {
      return { ok: false, error: 'No live session process to stop' }
    }
    if (typeof req.startedAt !== 'string' || !req.startedAt.trim()) {
      return { ok: false, error: 'Missing process start time' }
    }
    const refused = refusedPids(options)
    if (pid <= 1 || refused.has(pid)) return { ok: false, error: 'Refusing to stop this process' }

    // A fresh full sample (one `ps -p` is a full scan on macOS anyway) re-verifies identity
    // and gives the ancestry for the app-tree check.
    const { processes } = await samplePs()
    const proc = processes.get(pid)
    if (!proc) return { ok: true, method: 'signal' }
    if (!sameStartedAt(proc.startedAt, req.startedAt, deps.platform)) {
      return { ok: false, error: 'The process changed since the sample; refresh and retry' }
    }
    const hook = matchHookSessionId(proc.args)
    if (!hook) return { ok: false, error: 'Not an agent session process' }
    if (req.sessionId && hook.sessionId !== req.sessionId) {
      return { ok: false, error: 'The process belongs to another session' }
    }
    const appAncestors = collectAncestors(deps.appPid, processes)
    if (appAncestors.includes(pid)) return { ok: false, error: 'Refusing to stop this process' }
    const inAppTree = collectAncestors(pid, processes).includes(deps.appPid)
    if (!inAppTree && !orphanParentsOf(deps.appPid, processes, deps.platform).has(proc.ppid)) {
      return { ok: false, error: 'The process does not belong to Hive' }
    }
    // A group signal must never reach the app itself (or a refused pid) through a shared pgid.
    if (proc.pgid === pid) {
      for (const member of processes.values()) {
        if (member.pgid === pid && refused.has(member.pid)) {
          return { ok: false, error: 'Refusing to stop this process group' }
        }
      }
    }
    log.info('Session profiler: stopping untracked agent process', {
      pid,
      sessionId: hook.sessionId,
      orphaned: !inAppTree
    })
    const members = subtreeMembers(pid, processes)
    rememberStopping(hook.sessionId, members)
    const result = await signalProcess(proc)
    if (!result.ok) {
      forgetStopping(members)
      return result
    }
    // signalProcess took the root's own group down (TERM, then KILL); sweep the rest.
    const groupSignalled = proc.pgid === proc.pid
    await sweepQuietly(
      members.filter((member) => !(groupSignalled && member.pgid === proc.pgid)),
      refused
    )
    return result
  }

  /**
   * The app's own PTY: torn down through the bridge (session stays resumable). The subtree
   * is sampled first — to check the request still names this process, and to remember what
   * the session ran so a snapshot meanwhile shows it as stopping and the sweep can stop what
   * outlives the agent.
   */
  const stopTracked = async (
    pty: PtyInstanceInfo,
    req: SessionProfilerKillRequest,
    options: SessionProfilerKillOptions
  ): Promise<SessionProfilerKillResult> => {
    if (!deps.isAgentCliTerminal(pty.id)) return { ok: false, error: 'Not an agent session' }
    let sample: PsSample | null = null
    try {
      sample = await samplePs()
    } catch (error) {
      log.warn('Session profiler: pre-stop sample failed', {
        error: error instanceof Error ? error.message : String(error)
      })
    }
    const root = pty.pid ? sample?.processes.get(pty.pid) : undefined
    // A request by pid alone needs the sample to vouch for the process; one naming the
    // session is checked whenever it can be.
    const changed = root
      ? !!req.startedAt && !sameStartedAt(root.startedAt, req.startedAt, deps.platform)
      : !req.sessionId
    if (changed) {
      return { ok: false, error: 'The process changed since the sample; refresh and retry' }
    }
    const members = root ? subtreeMembers(root.pid, sample?.processes ?? new Map()) : []
    rememberStopping(pty.id, members)
    if (!deps.reapCliTerminal(pty.id)) {
      forgetStopping(members)
      return { ok: false, error: 'The session is not running' }
    }
    log.info('Session profiler: stopped tracked agent session', { sessionId: pty.id })
    // destroy() only sends SIGHUP (and SIGKILLs the group 1.5 s later): wait for the agent so
    // the follow-up refresh does not find it still exiting, then stop what it left behind.
    if (root) {
      await waitForExit(root.pid)
      await sweepQuietly(members, refusedPids(options))
    }
    return { ok: true, method: 'pty' }
  }

  const kill = async (
    req: SessionProfilerKillRequest,
    options: SessionProfilerKillOptions = {}
  ): Promise<SessionProfilerKillResult> => {
    if (deps.platform === 'win32') return { ok: false, error: 'unsupported' }
    try {
      // A request naming a session only ever takes that session's PTY: its pid may since
      // belong to another session's PTY, which the pid path (identity-checked) refuses. A pid
      // that is not the PTY's (a leaked earlier process of the same session) is signalled.
      const ptys = deps.listPtys()
      if (req.sessionId) {
        const pty = ptys.find((p) => p.id === req.sessionId)
        if (pty && (req.pid === undefined || req.pid === pty.pid)) {
          return await stopTracked(pty, req, options)
        }
      } else if (typeof req.pid === 'number' && typeof req.startedAt === 'string') {
        // By pid alone, only with the start time to prove the PTY is still that process.
        const pty = ptys.find((p) => p.pid === req.pid)
        if (pty) return await stopTracked(pty, req, options)
      }
      return await killByPid(req, options)
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    } finally {
      invalidate()
    }
  }

  return { getSnapshot, kill, invalidate }
}

// ── live wiring ────────────────────────────────────────────────────────────

const runPs = (): Promise<{ stdout: string; psPid: number | null }> =>
  new Promise((resolve, reject) => {
    const child = execFile(
      '/bin/ps',
      psArgs(process.platform),
      {
        env: { ...process.env, LC_ALL: 'C' },
        timeout: PS_TIMEOUT_MS,
        killSignal: 'SIGKILL',
        maxBuffer: PS_MAX_BUFFER,
        encoding: 'utf8'
      },
      (error, stdout) => {
        if (error) reject(error)
        else resolve({ stdout, psPid: child.pid ?? null })
      }
    )
  })

const sumBackgroundWork = (id: string): number => {
  const counts = getClaudeCliBackgroundWorkCounts(id)
  return counts.runningShells + counts.runningMonitors + counts.runningSubagents
}

let liveProfiler: ReturnType<typeof createSessionProfiler> | null = null

const getLiveProfiler = (): ReturnType<typeof createSessionProfiler> => {
  liveProfiler ??= createSessionProfiler({
    platform: process.platform,
    appPid: process.pid,
    appParentPid: process.ppid,
    runPs,
    listPtys: () => ptyService.listInstances(),
    hasPty: (id) => ptyService.has(id),
    isAgentCliTerminal,
    isCodexCliTerminal,
    reapCliTerminal,
    getDbRows: (ids) => getDatabase().getSessionProfilerRows(ids),
    getLiveStatus: getLastClaudeCliStatus,
    getBackgroundWork: sumBackgroundWork,
    isPaused: (id) =>
      isClaudeCliTurnPaused(id) ||
      (getClaudeCliSessionRecovery()?.pendingSessions().includes(id) ?? false),
    statTty: async (path) => {
      const stat = await fsp.stat(path)
      return { atimeMs: stat.atimeMs, mtimeMs: stat.mtimeMs, rdev: stat.rdev }
    },
    kill: (pid, signal) => {
      process.kill(pid, signal)
    },
    cpuCount: () => os.availableParallelism?.() ?? os.cpus().length,
    now: Date.now,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  })
  return liveProfiler
}

/** One sample of the app's process tree and its agent sessions (cached for 3 s). */
export function getSessionProfilerSnapshot(): Promise<SessionProfilerSnapshot> {
  return getLiveProfiler().getSnapshot()
}

/** Stop a session's process (tracked: through the PTY registry, resumable; else by pid). */
export function killSessionProfilerTarget(
  req: SessionProfilerKillRequest,
  options?: SessionProfilerKillOptions
): Promise<SessionProfilerKillResult> {
  return getLiveProfiler().kill(req, options)
}
