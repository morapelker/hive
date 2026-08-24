import { getDatabase } from '../../db'
import type { DatabaseService } from '../../db/database'
import type { Session } from '../../db/types'
import { APP_SETTINGS_DB_KEY } from '@shared/types/settings'
import {
  customProviderUsageToUsageProvider,
  findCustomProvider,
  sanitizeCustomProviders,
  type CustomClaudeProvider
} from '@shared/types/custom-provider'
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
/**
 * Hard cap on tracked sessions (active first, then newest) to bound stat()
 * fan-out. DB 'active' means "open", not "currently burning", so the cap is
 * set well above any realistic open-session count — per-session cost is a
 * handful of stat()s and the tally only runs while usage sits near an armed
 * switch threshold.
 */
const MAX_TRACKED_SESSIONS = 120

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

function loadCustomProviders(db: DatabaseService): CustomClaudeProvider[] {
  try {
    const raw = db.getSetting(APP_SETTINGS_DB_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw) as { customProviders?: unknown }
    return sanitizeCustomProviders(parsed.customProviders)
  } catch {
    return []
  }
}

/**
 * Mirrors the renderer's resolveUsageProvider attribution: a custom-provider
 * session configured with usageProvider 'openai' or 'none' does not burn the
 * Anthropic account, so its transcripts must not feed the Anthropic
 * burn-rate calibration. A deleted or blank-command provider degrades to
 * plain claude (anthropic) at spawn — count those.
 */
function isAnthropicAttributed(session: Session, providers: CustomClaudeProvider[]): boolean {
  const provider = findCustomProvider(providers, session.custom_provider_id)
  if (!provider || !provider.command.trim()) return true
  return customProviderUsageToUsageProvider(provider.usageProvider) === 'anthropic'
}

async function computeTally(deps: ClaudeTokenTallyDeps): Promise<ClaudeTokenTally> {
  const db = deps.db ?? getDatabase()
  const since = new Date(Date.now() - ACTIVE_SESSION_WINDOW_MS).toISOString()

  // Filter BEFORE capping: the recent list mixes in Codex and remote-launch
  // sessions, and letting them consume cap slots could push out the local
  // Claude sessions whose burn the predictor needs to see.
  const customProviders = loadCustomProviders(db)
  // Deliberately NO account-switch partition here. Credential attribution is
  // per SDK query (claude-code re-reads credentials every prompt) or per
  // process (claude-code-cli, including resume respawns), which this process
  // cannot observe — a session-level cutoff would wrongly exclude resumed
  // sessions' post-switch burn, the dominant workload. The error asymmetry
  // decides it: over-counting another account's burn at worst fires a
  // harmless 30s-floored early sample, while under-counting misses the
  // threshold crossing this predictor exists to catch. Cross-account
  // CALIBRATION is prevented renderer-side (the predictor hard-resets on
  // every switch), so misattributed tokens can bias a rate estimate but
  // never anchor one account's percent against another's tokens ratio.
  const sessions: Session[] = []
  for (const id of db.listRecentUsageSessionIds(since)) {
    if (sessions.length >= MAX_TRACKED_SESSIONS) break
    const session = db.getSession(id)
    if (!session || !isClaudeSdk(session.agent_sdk) || session.remote_launch) continue
    if (!isAnthropicAttributed(session, customProviders)) continue
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
