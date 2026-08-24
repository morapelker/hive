import { getDatabase } from '../../db'
import type { DatabaseService } from '../../db/database'
import type { Session } from '../../db/types'
import { createLogger } from '../logger'
import { resolveClaudeFiles } from './session-usage-service'
import { parseClaudeSessionIncrement, type ClaudeSessionState } from './claude-usage-parser'
import type { ClaudeTokenTally } from '@shared/types/usage'

/**
 * On-demand cumulative token tally across recent local Claude sessions,
 * feeding the renderer's burn-rate predictor (auto account switching).
 *
 * Reuses the incremental ccusage-style parser: per-file byte cursors mean a
 * call only reads bytes appended since the previous call, so polling every
 * ~30s while usage is near an armed switch threshold costs roughly what the
 * sessions themselves are writing (and those bytes are still in page cache).
 * State is in-memory only — a restart just re-parses once and re-baselines;
 * the predictor calibrates on deltas, so the absolute level doesn't matter.
 */

const log = createLogger({ component: 'ClaudeTokenTally' })

/** Sessions updated within this window are considered possibly-burning. */
const ACTIVE_SESSION_WINDOW_MS = 6 * 3_600_000
/** Hard cap on tracked sessions — newest first — to bound stat() fan-out. */
const MAX_TRACKED_SESSIONS = 40

export interface ClaudeTokenTallyDeps {
  db?: DatabaseService
}

const sessionStates = new Map<string, ClaudeSessionState>()
let inFlight: Promise<ClaudeTokenTally> | null = null

export function __resetClaudeTokenTallyForTests(): void {
  sessionStates.clear()
  inFlight = null
}

function isClaudeSdk(agentSdk: string | null | undefined): boolean {
  return agentSdk === 'claude-code' || agentSdk === 'claude-code-cli'
}

async function computeTally(deps: ClaudeTokenTallyDeps): Promise<ClaudeTokenTally> {
  const db = deps.db ?? getDatabase()
  const since = new Date(Date.now() - ACTIVE_SESSION_WINDOW_MS).toISOString()

  // Filter BEFORE capping: the recent list mixes in Codex and remote-launch
  // sessions, and letting them consume cap slots could push out the local
  // Claude sessions whose burn the predictor needs to see.
  const sessions: Session[] = []
  for (const id of db.listRecentUsageSessionIds(since)) {
    if (sessions.length >= MAX_TRACKED_SESSIONS) break
    const session = db.getSession(id)
    if (!session || !isClaudeSdk(session.agent_sdk) || session.remote_launch) continue
    sessions.push(session)
  }

  const totals: ClaudeTokenTally = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    sessionCount: 0,
    sampledAt: Date.now()
  }

  const seen = new Set<string>()
  for (const session of sessions) {
    const sessionId = session.id

    let files: string[]
    try {
      files = await resolveClaudeFiles(db, session)
    } catch {
      continue
    }
    // Keep previously tracked files (e.g. a fork changed the session id) so
    // their cumulative entries keep contributing between calls.
    const stored = sessionStates.get(sessionId) ?? null
    const allFiles = [...new Set([...(stored ? Object.keys(stored.files) : []), ...files])]
    if (allFiles.length === 0) continue
    seen.add(sessionId)

    try {
      const result = await parseClaudeSessionIncrement(allFiles, stored)
      sessionStates.set(sessionId, result.state)
      let contributed = false
      for (const bucket of Object.values(result.buckets)) {
        totals.inputTokens += bucket.inputTokens
        totals.outputTokens += bucket.outputTokens
        totals.cacheReadTokens += bucket.cacheReadTokens
        totals.cacheWriteTokens += bucket.cacheWriteTokens
        contributed = true
      }
      if (contributed) totals.sessionCount += 1
    } catch (error) {
      log.warn('Failed to parse session transcript for token tally', {
        sessionId,
        error: error instanceof Error ? error.message : String(error)
      })
    }
  }

  // Sessions that aged out of the window stop contributing — drop their
  // parser state so the map stays bounded. Their tokens vanishing from the
  // cumulative total is fine: the predictor re-anchors on every usage fetch,
  // and a negative inter-anchor delta is discarded by calibration.
  for (const trackedId of sessionStates.keys()) {
    if (!seen.has(trackedId)) sessionStates.delete(trackedId)
  }

  return totals
}

/**
 * Single-flight cumulative tally: concurrent callers share one computation
 * (the parser state map must not be advanced concurrently).
 */
export function getClaudeTokenTally(deps: ClaudeTokenTallyDeps = {}): Promise<ClaudeTokenTally> {
  if (inFlight) return inFlight
  inFlight = computeTally(deps).finally(() => {
    inFlight = null
  })
  return inFlight
}
