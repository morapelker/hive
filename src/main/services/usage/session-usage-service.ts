import { readdir, realpath } from 'fs/promises'
import { join } from 'path'
import { homedir } from 'os'
import { getDatabase } from '../../db'
import type { DatabaseService } from '../../db/database'
import type { Session } from '../../db/types'
import { encodePath, resolveProjectsDir } from '../claude-transcript-reader'
import {
  getHiveEnterpriseRequestContext,
  requestHiveEnterpriseGraphql
} from '../hive-enterprise-claude-cli-telemetry'
import { GitService } from '../git-service'
import { createLogger } from '../logger'
import {
  parseClaudeSessionIncrement,
  type BucketMap,
  type ClaudeSessionState
} from './claude-usage-parser'
import { parseCodexRolloutIncrement, type CodexFileState } from './codex-usage-parser'
import { ensureModelPricing } from './model-pricing-loader'

/**
 * Session usage reporter: on every session stop (turn end, interrupt, PTY
 * exit, close, sweep) it incrementally parses the session's own on-disk log
 * (Claude transcript JSONL / Codex rollout) ccusage-style and reports
 * CUMULATIVE per-(model, UTC hour) token+cost buckets to Hive Enterprise.
 * The server overwrites on upsert, so resending or fully re-parsing after
 * local state loss can never double-count.
 */

const log = createLogger({ component: 'SessionUsageService' })

const DEBOUNCE_MS = 2_000
const SWEEP_INTERVAL_MS = 30 * 60_000
const SWEEP_INITIAL_DELAY_MS = 15_000
const SWEEP_WINDOW_MS = 14 * 24 * 3_600_000

const ReportSessionUsageDocument = /* GraphQL */ `
  mutation HiveReportSessionUsage($input: SessionUsageReportInput!) {
    reportSessionUsage(input: $input) {
      recorded
    }
  }
`

interface StoredUsageState {
  provider: 'anthropic' | 'openai'
  claude?: ClaudeSessionState
  codex?: { filePath: string | null; state: CodexFileState | null }
  gitRemoteUrl?: string | null
}

export interface SessionUsageServiceDeps {
  db?: DatabaseService
  requestGraphql?: typeof requestHiveEnterpriseGraphql
  codexSessionsDir?: string
}

const debounceTimers = new Map<string, NodeJS.Timeout>()
const running = new Map<string, Promise<void>>()
const rerunRequested = new Set<string>()
let sweepTimer: NodeJS.Timeout | null = null
let sweepStarted = false

function providerForSession(session: Session): 'anthropic' | 'openai' | null {
  if (session.agent_sdk === 'codex') return 'openai'
  if (session.agent_sdk === 'claude-code' || session.agent_sdk === 'claude-code-cli') {
    return 'anthropic'
  }
  return null
}

function resolveSessionCwd(db: DatabaseService, session: Session): string | null {
  if (session.worktree_id) {
    const worktree = db.getWorktree(session.worktree_id)
    if (worktree?.path) return worktree.path
  }
  if (session.connection_id) {
    const connection = db.getConnection(session.connection_id)
    if (connection?.path) return connection.path
  }
  const project = db.getProject(session.project_id)
  return project?.path ?? null
}

function claudeSessionIds(session: Session): string[] {
  const ids = new Set<string>()
  for (const candidate of [session.claude_session_id, session.opencode_session_id]) {
    if (typeof candidate === 'string' && candidate.length > 0 && !candidate.startsWith('pending::')) {
      ids.add(candidate)
    }
  }
  return [...ids]
}

async function listSubagentFiles(transcriptPath: string): Promise<string[]> {
  const subagentsDir = join(transcriptPath.slice(0, -'.jsonl'.length), 'subagents')
  try {
    const names = await readdir(subagentsDir)
    return names.filter((name) => name.endsWith('.jsonl')).map((name) => join(subagentsDir, name))
  } catch {
    return []
  }
}

/** Main transcript + subagent files for every known Claude session id, across cwd/realpath encodings. */
async function resolveClaudeFiles(db: DatabaseService, session: Session): Promise<string[]> {
  const cwd = resolveSessionCwd(db, session)
  if (!cwd) return []
  const projectsDir = resolveProjectsDir()
  const encodings = new Set<string>([encodePath(cwd)])
  try {
    const resolved = await realpath(cwd)
    encodings.add(encodePath(resolved))
  } catch {
    // cwd may be gone (deleted worktree) — still try the plain encoding.
  }

  const files: string[] = []
  for (const sessionId of claudeSessionIds(session)) {
    for (const encoded of encodings) {
      const transcript = join(projectsDir, encoded, `${sessionId}.jsonl`)
      files.push(transcript)
      files.push(...(await listSubagentFiles(transcript)))
    }
  }
  return files
}

async function findCodexRolloutFile(sessionsDir: string, threadId: string): Promise<string | null> {
  const suffix = `-${threadId}.jsonl`
  // Layout: <dir>/YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl — walk newest-first.
  async function listDirsDesc(dir: string): Promise<string[]> {
    try {
      const entries = await readdir(dir, { withFileTypes: true })
      return entries
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
        .sort()
        .reverse()
    } catch {
      return []
    }
  }
  for (const year of await listDirsDesc(sessionsDir)) {
    for (const month of await listDirsDesc(join(sessionsDir, year))) {
      for (const day of await listDirsDesc(join(sessionsDir, year, month))) {
        try {
          const names = await readdir(join(sessionsDir, year, month, day))
          const hit = names.find((name) => name.startsWith('rollout-') && name.endsWith(suffix))
          if (hit) return join(sessionsDir, year, month, day, hit)
        } catch {
          // Ignore unreadable day dirs.
        }
      }
    }
  }
  return null
}

function loadStoredState(db: DatabaseService, sessionId: string): {
  state: StoredUsageState | null
  lastReported: BucketMap | null
} {
  const row = db.getSessionUsageState(sessionId)
  if (!row) return { state: null, lastReported: null }
  let state: StoredUsageState | null = null
  let lastReported: BucketMap | null = null
  try {
    state = JSON.parse(row.stateJson) as StoredUsageState
  } catch {
    state = null
  }
  try {
    lastReported = row.lastReportedJson ? (JSON.parse(row.lastReportedJson) as BucketMap) : null
  } catch {
    lastReported = null
  }
  return { state, lastReported }
}

function roundBuckets(buckets: BucketMap): BucketMap {
  const rounded: BucketMap = {}
  for (const [key, bucket] of Object.entries(buckets)) {
    rounded[key] = {
      inputTokens: Math.round(bucket.inputTokens),
      outputTokens: Math.round(bucket.outputTokens),
      cacheReadTokens: Math.round(bucket.cacheReadTokens),
      cacheWriteTokens: Math.round(bucket.cacheWriteTokens),
      costUsd: Number(bucket.costUsd.toFixed(6))
    }
  }
  return rounded
}

function bucketsEqual(a: BucketMap | null, b: BucketMap): boolean {
  if (!a) return Object.keys(b).length === 0
  const aKeys = Object.keys(a)
  const bKeys = Object.keys(b)
  if (aKeys.length !== bKeys.length) return false
  for (const key of bKeys) {
    const left = a[key]
    const right = b[key]
    if (!left) return false
    if (
      left.inputTokens !== right.inputTokens ||
      left.outputTokens !== right.outputTokens ||
      left.cacheReadTokens !== right.cacheReadTokens ||
      left.cacheWriteTokens !== right.cacheWriteTokens ||
      left.costUsd !== right.costUsd
    ) {
      return false
    }
  }
  return true
}

async function resolveGitRemoteUrl(
  db: DatabaseService,
  session: Session,
  stored: StoredUsageState | null
): Promise<string | null> {
  if (stored && stored.gitRemoteUrl !== undefined) return stored.gitRemoteUrl
  const cwd = resolveSessionCwd(db, session)
  if (!cwd) return null
  try {
    const remote = await new GitService(cwd).getRemoteUrl('origin')
    return remote.success ? (remote.url ?? null) : null
  } catch {
    return null
  }
}

async function doReport(sessionId: string, deps: SessionUsageServiceDeps): Promise<void> {
  const db = deps.db ?? getDatabase()
  const session = db.getSession(sessionId)
  if (!session) return
  if (session.remote_launch) return
  const provider = providerForSession(session)
  if (!provider) return

  // Prices live only on Hive Enterprise (the client bundles none). Without a
  // logged-in enterprise connection there is nobody to report to and no way
  // to price usage, and without a price table costs would be computed as 0 —
  // which the codex parser would bake into its persisted state. So both are
  // required BEFORE parsing anything; a later stop/sweep simply retries.
  const context = getHiveEnterpriseRequestContext(db)
  if (!context) return
  const request = deps.requestGraphql ?? requestHiveEnterpriseGraphql
  if (!(await ensureModelPricing(context, request))) {
    log.warn('Model prices unavailable — deferring session usage report', { sessionId })
    return
  }

  const { state: stored, lastReported } = loadStoredState(db, sessionId)

  let buckets: BucketMap
  let nextState: StoredUsageState
  if (provider === 'anthropic') {
    const resolvedFiles = await resolveClaudeFiles(db, session)
    // Keep previously tracked files (e.g. after an SDK session fork changes
    // the session id) so their entries keep contributing and replays dedupe.
    const files = [...new Set([...(stored?.claude ? Object.keys(stored.claude.files) : []), ...resolvedFiles])]
    if (files.length === 0) return
    const result = await parseClaudeSessionIncrement(files, stored?.claude ?? null)
    buckets = result.buckets
    nextState = { provider, claude: result.state }
  } else {
    const threadId = session.opencode_session_id
    if (!threadId) return
    const sessionsDir = deps.codexSessionsDir ?? join(homedir(), '.codex', 'sessions')
    let filePath = stored?.codex?.filePath ?? null
    if (!filePath) {
      filePath = await findCodexRolloutFile(sessionsDir, threadId)
      if (!filePath) return
    }
    const result = await parseCodexRolloutIncrement(filePath, stored?.codex?.state ?? null)
    buckets = result.buckets
    nextState = { provider, codex: { filePath, state: result.state } }
  }

  const rounded = roundBuckets(buckets)
  if (bucketsEqual(lastReported, rounded)) {
    nextState.gitRemoteUrl = stored?.gitRemoteUrl ?? null
    db.setSessionUsageState(sessionId, JSON.stringify(nextState), JSON.stringify(lastReported ?? {}))
    return
  }

  const gitRemoteUrl = await resolveGitRemoteUrl(db, session, stored)
  nextState.gitRemoteUrl = gitRemoteUrl
  const project = db.getProject(session.project_id)
  const worktree = session.worktree_id ? db.getWorktree(session.worktree_id) : null

  const input = {
    sessionId,
    provider,
    agentSdk: session.agent_sdk,
    mode: session.mode ?? null,
    projectName: project?.name ?? null,
    projectPath: project?.path ?? null,
    gitRemoteUrl,
    worktreeBranch: worktree?.branch_name ?? null,
    buckets: Object.entries(rounded).map(([key, bucket]) => {
      const separator = key.lastIndexOf('|')
      return {
        model: key.slice(0, separator),
        bucketTs: key.slice(separator + 1),
        inputTokens: bucket.inputTokens,
        outputTokens: bucket.outputTokens,
        cacheReadTokens: bucket.cacheReadTokens,
        cacheWriteTokens: bucket.cacheWriteTokens,
        costUsd: bucket.costUsd
      }
    })
  }

  try {
    await request(context.endpoint, context.token, ReportSessionUsageDocument, { input })
    db.setSessionUsageState(sessionId, JSON.stringify(nextState), JSON.stringify(rounded))
    log.info('Reported session usage', {
      sessionId,
      provider,
      buckets: input.buckets.length,
      costUsd: input.buckets.reduce((sum, bucket) => sum + bucket.costUsd, 0).toFixed(4)
    })
  } catch (error) {
    // Keep cursors (state) but not lastReported: the next stop/sweep resends
    // the same cumulative totals — upsert semantics make that safe.
    db.setSessionUsageState(
      sessionId,
      JSON.stringify(nextState),
      lastReported ? JSON.stringify(lastReported) : null
    )
    log.warn('Failed to report session usage', {
      sessionId,
      error: error instanceof Error ? error.message : String(error)
    })
  }
}

function runReport(sessionId: string, deps: SessionUsageServiceDeps): Promise<void> {
  const existing = running.get(sessionId)
  if (existing) {
    rerunRequested.add(sessionId)
    return existing
  }
  const promise = doReport(sessionId, deps)
    .catch((error) => {
      log.warn('Session usage report crashed', {
        sessionId,
        error: error instanceof Error ? error.message : String(error)
      })
    })
    .finally(() => {
      running.delete(sessionId)
      if (rerunRequested.delete(sessionId)) {
        scheduleSessionUsageReport(sessionId, 'rerun', deps)
      }
    })
  running.set(sessionId, promise)
  return promise
}

/**
 * Debounced entry point — safe to call from every stop path; concurrent calls
 * for the same session collapse into one serialized report.
 */
export function scheduleSessionUsageReport(
  sessionId: string,
  reason: string,
  deps: SessionUsageServiceDeps = {}
): void {
  const existing = debounceTimers.get(sessionId)
  if (existing) clearTimeout(existing)
  const timer = setTimeout(() => {
    debounceTimers.delete(sessionId)
    void runReport(sessionId, deps)
  }, DEBOUNCE_MS)
  timer.unref?.()
  debounceTimers.set(sessionId, timer)
  log.debug('Scheduled session usage report', { sessionId, reason })
}

/** Immediate, awaitable report (tests + sweep). */
export async function flushSessionUsageReport(
  sessionId: string,
  deps: SessionUsageServiceDeps = {}
): Promise<void> {
  const timer = debounceTimers.get(sessionId)
  if (timer) {
    clearTimeout(timer)
    debounceTimers.delete(sessionId)
  }
  await runReport(sessionId, deps)
}

async function runSweep(deps: SessionUsageServiceDeps): Promise<void> {
  try {
    const db = deps.db ?? getDatabase()
    const since = new Date(Date.now() - SWEEP_WINDOW_MS).toISOString()
    const sessionIds = db.listRecentUsageSessionIds(since)
    for (const sessionId of sessionIds) {
      await flushSessionUsageReport(sessionId, deps)
    }
    log.info('Session usage sweep finished', { sessions: sessionIds.length })
  } catch (error) {
    log.warn('Session usage sweep failed', {
      error: error instanceof Error ? error.message : String(error)
    })
  }
}

/**
 * Startup + periodic sweep: catches sessions whose stop event was missed
 * (app crash, quit race) by re-parsing anything whose log grew since the
 * stored cursor. Cheap when nothing changed (one stat per file).
 */
export function startSessionUsageSweep(deps: SessionUsageServiceDeps = {}): void {
  if (sweepStarted) return
  sweepStarted = true
  const initial = setTimeout(() => {
    void runSweep(deps)
  }, SWEEP_INITIAL_DELAY_MS)
  initial.unref?.()
  sweepTimer = setInterval(() => {
    void runSweep(deps)
  }, SWEEP_INTERVAL_MS)
  sweepTimer.unref?.()
}

export function stopSessionUsageSweep(): void {
  if (sweepTimer) clearInterval(sweepTimer)
  sweepTimer = null
  sweepStarted = false
}

export function __resetSessionUsageServiceForTests(): void {
  for (const timer of debounceTimers.values()) clearTimeout(timer)
  debounceTimers.clear()
  running.clear()
  rerunRequested.clear()
  stopSessionUsageSweep()
}
