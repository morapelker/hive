import {
  closeSync,
  existsSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  statSync,
  watch,
  type FSWatcher
} from 'node:fs'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import { createLogger } from './logger'

/**
 * Codex rollout (transcript) helpers for the Codex CLI provider.
 *
 * The codex TUI persists every thread as
 * `${CODEX_HOME:-~/.codex}/sessions/YYYY/MM/DD/rollout-<timestamp>-<thread-uuid>.jsonl`.
 * Line 1 is `session_meta` (`payload.id` / `payload.session_id` = thread id,
 * `payload.cwd`); later lines are `response_item`, `turn_context` and
 * `event_msg` records — of which `item_completed` (with `item.type` such as
 * `UserMessage`, `AgentMessage`, `Plan`), `token_count`, `task_started` and
 * `task_complete` are the ones persisted (verified against codex-cli 0.153.4
 * rollouts on disk). The hooks carry `transcript_path` pointing at this file.
 */

const log = createLogger({ component: 'CodexCliRollout' })

const ROLLOUT_FILE_RE = /^rollout-(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2})-([0-9a-f-]{36})\.jsonl$/i

export function resolveCodexHome(env: Record<string, string | undefined> = process.env): string {
  const configured = env.CODEX_HOME
  return typeof configured === 'string' && configured.trim().length > 0
    ? configured.trim()
    : join(homedir(), '.codex')
}

export function resolveCodexSessionsDir(env?: Record<string, string | undefined>): string {
  return join(resolveCodexHome(env), 'sessions')
}

function dateDir(sessionsDir: string, date: Date): string {
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, '0')
  const d = String(date.getDate()).padStart(2, '0')
  return join(sessionsDir, String(y), m, d)
}

/** Today's and yesterday's rollout folders (a session can straddle midnight; the file lives where it started). */
export function recentRolloutDirs(sessionsDir: string, now = new Date()): string[] {
  const yesterday = new Date(now.getTime() - 24 * 3_600_000)
  return [...new Set([dateDir(sessionsDir, now), dateDir(sessionsDir, yesterday)])]
}

export function parseRolloutFileName(name: string): { threadId: string } | null {
  const match = ROLLOUT_FILE_RE.exec(name)
  return match ? { threadId: match[2].toLowerCase() } : null
}

function readFirstLine(filePath: string): string | null {
  try {
    const raw = readFileSync(filePath, 'utf8')
    const newline = raw.indexOf('\n')
    return newline === -1 ? raw : raw.slice(0, newline)
  } catch {
    return null
  }
}

/** The `cwd` recorded in a rollout's `session_meta` line, or null when unreadable / not yet written. */
export function readRolloutCwd(filePath: string): string | null {
  const line = readFirstLine(filePath)
  if (!line) return null
  try {
    const record = JSON.parse(line) as { type?: string; payload?: { cwd?: unknown } }
    if (record.type !== 'session_meta') return null
    return typeof record.payload?.cwd === 'string' ? record.payload.cwd : null
  } catch {
    return null
  }
}

function samePath(a: string, b: string): boolean {
  const norm = (p: string): string => p.replace(/\/+$/, '').normalize('NFC')
  const na = norm(a)
  const nb = norm(b)
  if (na === nb) return true
  // macOS: /tmp ↔ /private/tmp, /var ↔ /private/var.
  const strip = (p: string): string => p.replace(/^\/private(\/|$)/, '/')
  return strip(na) === strip(nb)
}

/**
 * Find the rollout whose thread id starts with `prefix` (the codex terminal
 * title truncates the UUID to 29 characters + "..."). Looks at today's and
 * yesterday's folders — the ones a live TUI can have written to.
 */
export function findCodexRolloutByIdPrefix(
  prefix: string,
  opts?: { sessionsDir?: string; now?: Date }
): { threadId: string; filePath: string } | null {
  const sessionsDir = opts?.sessionsDir ?? resolveCodexSessionsDir()
  const needle = prefix.toLowerCase()
  if (needle.length < 8) return null
  for (const dir of recentRolloutDirs(sessionsDir, opts?.now)) {
    let names: string[]
    try {
      names = readdirSync(dir)
    } catch {
      continue
    }
    for (const name of names) {
      const parsed = parseRolloutFileName(name)
      if (parsed && parsed.threadId.startsWith(needle)) {
        return { threadId: parsed.threadId, filePath: join(dir, name) }
      }
    }
  }
  return null
}

export interface CodexSessionWatchHandle {
  close(): void
}

/**
 * Fallback thread-id discovery when hooks are not delivering: watch the
 * rollout folder for a new file whose `session_meta.cwd` is this worktree
 * (files that already existed at spawn are excluded). Mirrors
 * claude-session-watcher.ts; the SessionStart hook normally wins first and the
 * caller closes the watcher.
 */
export function watchForCodexSessionId(
  worktreePath: string,
  onSessionId: (threadId: string, filePath: string) => boolean | void,
  opts?: { sessionsDir?: string; pollMs?: number }
): CodexSessionWatchHandle {
  const sessionsDir = opts?.sessionsDir ?? resolveCodexSessionsDir()
  const startedAtMs = Date.now()
  const existing = new Set<string>()
  for (const dir of recentRolloutDirs(sessionsDir)) {
    try {
      for (const name of readdirSync(dir)) existing.add(join(dir, name))
    } catch {
      // Folder may not exist yet.
    }
  }

  let closed = false
  const watchers: FSWatcher[] = []
  let interval: NodeJS.Timeout | null = null
  let scanScheduled: NodeJS.Timeout | null = null

  const stop = (): void => {
    closed = true
    if (interval) clearInterval(interval)
    interval = null
    if (scanScheduled) clearTimeout(scanScheduled)
    scanScheduled = null
    for (const watcher of watchers) watcher.close()
    watchers.length = 0
  }

  const scan = (): void => {
    if (closed) return
    // Re-resolve the folders each tick: a session started just before midnight
    // may land in the new day's folder.
    for (const dir of recentRolloutDirs(sessionsDir)) {
      let names: string[]
      try {
        names = readdirSync(dir)
      } catch {
        continue
      }
      for (const name of names) {
        const filePath = join(dir, name)
        if (existing.has(filePath)) continue
        const parsed = parseRolloutFileName(name)
        if (!parsed) {
          existing.add(filePath)
          continue
        }
        try {
          if (statSync(filePath).mtimeMs + 1000 < startedAtMs) {
            existing.add(filePath)
            continue
          }
        } catch {
          continue
        }
        const cwd = readRolloutCwd(filePath)
        if (!cwd) continue // session_meta not flushed yet — retry next tick
        if (!samePath(cwd, worktreePath)) {
          existing.add(filePath)
          continue
        }
        log.info('Detected Codex CLI thread id from rollout', { worktreePath, threadId: parsed.threadId })
        let verdict: boolean | void
        try {
          verdict = onSessionId(parsed.threadId, filePath)
        } catch (error) {
          log.warn('Codex thread id consumer threw; closing watcher', {
            error: error instanceof Error ? error.message : String(error)
          })
          verdict = true
        }
        if (verdict === false) {
          existing.add(filePath)
          continue
        }
        stop()
        return
      }
    }
  }

  const requestScan = (): void => {
    if (closed || scanScheduled) return
    scanScheduled = setTimeout(() => {
      scanScheduled = null
      scan()
    }, 50)
  }

  for (const dir of recentRolloutDirs(sessionsDir)) {
    if (!existsSync(dir)) continue
    try {
      watchers.push(watch(dir, () => requestScan()))
    } catch (error) {
      log.warn('Unable to watch codex rollout folder', {
        dir,
        error: error instanceof Error ? error.message : String(error)
      })
    }
  }
  // Poll as well: the day folder may not exist yet, and fs.watch misses the
  // first write when the folder is created after we attached.
  interval = setInterval(scan, opts?.pollMs ?? 1000)
  scan()

  return { close: stop }
}

// ── Transcript readers ────────────────────────────────────────────────

interface RolloutRecord {
  type?: string
  payload?: Record<string, unknown>
}

function parseRecords(text: string): RolloutRecord[] {
  const records: RolloutRecord[] = []
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    try {
      const parsed = JSON.parse(line) as RolloutRecord
      if (parsed && typeof parsed === 'object') records.push(parsed)
    } catch {
      // Codex appends incrementally; a partial trailing line is expected.
    }
  }
  return records
}

/**
 * The proposed plan text of a turn (codex Plan mode emits it as an
 * `item_completed` record whose item is `{type:"Plan", id, text}`). With a
 * turn id, the plan of that turn; otherwise the last plan in the transcript.
 */
export function readCodexPlanText(transcriptPath: string, turnId?: string | null): string | null {
  let text: string
  try {
    text = readFileSync(transcriptPath, 'utf8')
  } catch {
    return null
  }
  return extractCodexPlanText(text, turnId)
}

export function extractCodexPlanText(transcript: string, turnId?: string | null): string | null {
  let latest: string | null = null
  let latestForTurn: string | null = null
  for (const record of parseRecords(transcript)) {
    if (record.type !== 'event_msg') continue
    const payload = record.payload
    if (!payload || payload.type !== 'item_completed') continue
    const item = payload.item as { type?: unknown; text?: unknown } | undefined
    if (!item || item.type !== 'Plan' || typeof item.text !== 'string') continue
    const planText = item.text.trim()
    if (!planText) continue
    latest = planText
    if (turnId && payload.turn_id === turnId) latestForTurn = planText
  }
  return latestForTurn ?? latest
}

export interface CodexTokenCounters {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
}

function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, value) : 0
}

/**
 * Sum the per-response usage of every `token_count` event in `text`
 * (`payload.info.last_token_usage`). Codex's `input_tokens` includes the
 * cached prompt tokens, so the uncached input is `input - cached` to match
 * the Anthropic-style counters the telemetry rows expect.
 */
export function tallyCodexTranscriptTokens(text: string): CodexTokenCounters {
  const totals: CodexTokenCounters = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
  for (const record of parseRecords(text)) {
    if (record.type !== 'event_msg' || record.payload?.type !== 'token_count') continue
    const info = record.payload.info as { last_token_usage?: Record<string, unknown> } | undefined
    const last = info?.last_token_usage
    if (!last) continue
    const input = num(last.input_tokens)
    const cached = Math.min(num(last.cached_input_tokens), input)
    totals.input += input - cached
    totals.cacheRead += cached
    totals.cacheWrite += num(last.cache_write_input_tokens)
    totals.output += num(last.output_tokens)
  }
  return totals
}

/** Context size at the last response: the full (cached + uncached) prompt of the last `token_count`. */
export function lastCodexContextLength(text: string): number | null {
  let latest: number | null = null
  for (const record of parseRecords(text)) {
    if (record.type !== 'event_msg' || record.payload?.type !== 'token_count') continue
    const info = record.payload.info as { last_token_usage?: Record<string, unknown> } | undefined
    const last = info?.last_token_usage
    if (!last) continue
    latest = num(last.input_tokens) + num(last.cache_write_input_tokens)
  }
  return latest
}

export function rolloutThreadIdFromPath(filePath: string): string | null {
  return parseRolloutFileName(basename(filePath))?.threadId ?? null
}

// ── Turn-end watcher ──────────────────────────────────────────────────

export interface CodexTurnEnd {
  kind: 'complete' | 'aborted'
  turnId: string | null
  /** `task_complete.error.message` when the turn failed (an API error, a refused model, …). */
  error: string | null
  lastAgentMessage: string | null
}

export interface CodexTurnWatchHandle {
  close(): void
}

/**
 * Codex runs its Stop hook only when a turn ends with a model answer: a turn
 * that dies on an API error (`unexpected status 404 …`) fires no hook at all,
 * so a hook-driven status would sit on 'working' forever. The rollout still
 * records the end of every turn — `event_msg` `task_complete` (with an `error`
 * object on failure) or `turn_aborted` — so this tails the transcript from the
 * moment a turn starts and reports the first end record for that turn.
 * Poll-based (plus fs.watch) and incremental: only bytes appended since the
 * watcher attached are parsed.
 */
export function watchCodexTurnEnd(
  transcriptPath: string,
  turnId: string | null,
  onEnd: (end: CodexTurnEnd) => void,
  opts?: { pollMs?: number }
): CodexTurnWatchHandle {
  let closed = false
  let offset = 0
  try {
    offset = statSync(transcriptPath).size
  } catch {
    offset = 0
  }
  let watcher: FSWatcher | null = null
  let interval: NodeJS.Timeout | null = null
  let partial = ''

  const stop = (): void => {
    closed = true
    if (interval) clearInterval(interval)
    interval = null
    watcher?.close()
    watcher = null
  }

  const scan = (): void => {
    if (closed) return
    let size: number
    try {
      size = statSync(transcriptPath).size
    } catch {
      return
    }
    if (size < offset) {
      // Rewritten/truncated file: start over from the beginning.
      offset = 0
      partial = ''
    }
    if (size === offset) return
    let chunk: string
    try {
      const fd = openSync(transcriptPath, 'r')
      try {
        const buffer = Buffer.alloc(size - offset)
        readSync(fd, buffer, 0, buffer.length, offset)
        chunk = buffer.toString('utf8')
      } finally {
        closeSync(fd)
      }
    } catch {
      return
    }
    offset = size
    const text = partial + chunk
    const lines = text.split('\n')
    partial = lines.pop() ?? ''
    for (const line of lines) {
      if (!line.trim()) continue
      let record: RolloutRecord
      try {
        record = JSON.parse(line) as RolloutRecord
      } catch {
        continue
      }
      if (record.type !== 'event_msg' || !record.payload) continue
      const payload = record.payload
      if (payload.type !== 'task_complete' && payload.type !== 'turn_aborted') continue
      const recordTurnId = typeof payload.turn_id === 'string' ? payload.turn_id : null
      if (turnId && recordTurnId && recordTurnId !== turnId) continue
      const errorRecord = payload.error as { message?: unknown } | undefined
      const end: CodexTurnEnd = {
        kind: payload.type === 'task_complete' ? 'complete' : 'aborted',
        turnId: recordTurnId,
        error:
          errorRecord && typeof errorRecord.message === 'string' ? errorRecord.message : null,
        lastAgentMessage:
          typeof payload.last_agent_message === 'string' ? payload.last_agent_message : null
      }
      stop()
      try {
        onEnd(end)
      } catch (error) {
        log.warn('Codex turn-end consumer threw', {
          transcriptPath,
          error: error instanceof Error ? error.message : String(error)
        })
      }
      return
    }
  }

  try {
    if (existsSync(transcriptPath)) {
      watcher = watch(transcriptPath, () => scan())
    }
  } catch {
    watcher = null
  }
  interval = setInterval(scan, opts?.pollMs ?? 500)
  scan()
  return { close: stop }
}
