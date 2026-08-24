import { closeSync, fstatSync, openSync, readSync } from 'fs'
import { CUSTOM_MODEL_PROVIDER_ID } from '@shared/types/custom-provider'
import { resolveClaudeCliFallbackModel } from '@shared/types/claude-cli-fallback-models'
import { OPENCODE_STREAM_CHANNEL } from '@shared/opencode-events'
import type { DatabaseService } from '../db/database'
import type { Session, SessionUpdate } from '../db/types'
import { getDatabase } from '../db'
import { publishDesktopBackendEvent } from '../desktop/backend-event-publisher'
import { normalizeClaudeCliModel } from './claude-cli-spawner'
import { createLogger } from './logger'

const log = createLogger({ component: 'ClaudeCliModelWatcher' })

/**
 * Detects the claude CLI switching models mid-session — usage-limit
 * degradation (e.g. Fable→Sonnet), safety fallback, or a user /model — and
 * propagates the change to the session row so the ticket badge, respawn
 * --model, telemetry, etc. all follow.
 *
 * The only signal that covers PTY (TUI) sessions is the session transcript
 * JSONL: every main-chain assistant line records the model that actually
 * produced it in `message.model` (hook payloads carry no model field). The
 * watcher tails the transcript from the `transcript_path` every hook already
 * delivers and reacts to *transitions* between consecutive assistant models.
 *
 * Two deliberate suppressions keep the watcher from clobbering user intent:
 * - A mere mismatch between transcript and session row never fires: a user
 *   picking a new model in Hive updates the row while the running CLI keeps
 *   answering on the old model until respawn, so the transcript lawfully lags
 *   the row. Only an observed in-transcript switch proves the CLI itself
 *   changed models.
 * - The backlog present when a tracker attaches (respawn --resume, app
 *   restart, rewritten file) is consumed as a silent baseline — its
 *   historical transitions were either already applied live in a previous
 *   run or superseded by an explicit user choice made while no CLI was
 *   running, so replaying them could revert that choice. Only transitions
 *   appended after baselining fire.
 * Transitions are tracked at alias granularity (fable/opus/sonnet/haiku): a
 * dated snapshot bump within the same alias is not a switch Hive can express.
 *
 * A switch is only ever an in-transcript transition, so the baseline must seed
 * the model the CLI is *currently* running before the first live line lands —
 * otherwise a session whose very first committed line is already the fallback
 * model (a safety degrade or usage-limit degrade that fires on the opening
 * turn) shows no transition and the change is missed. When the backlog has an
 * assistant model, that model is the seed; when it has none yet (a fresh or
 * just-cleared transcript), the seed is the alias the tracker was already
 * following across a transcript-path change, or — on the very first attach —
 * the session's launch model (the row's model_id is exactly the CLI's --model
 * flag). Seeding the launch model cannot fabricate a spurious switch: a lawful
 * pending UI choice only exists alongside an already-running CLI, whose
 * transcript is never empty, so it takes the carried-forward alias instead and
 * is never reverted.
 *
 * The transcript is read incrementally — a per-session byte cursor consumes
 * only the bytes appended since the previous hook (plus a one-time bounded tail
 * at first attach); the whole file is never rescanned.
 */

interface ModelTrackerState {
  transcriptPath: string
  /** Byte offset of the first unconsumed transcript byte (complete lines only). */
  offset: number
  /** Raw model of the last main-chain assistant line seen (event payloads). */
  lastRawModel: string | null
  /** normalizeClaudeCliModel(lastRawModel) — transition tracking granularity. */
  lastAlias: string | null
  /**
   * The CLI's currently-running model alias, used to seed `lastAlias` when the
   * baseline finds no assistant model in the backlog (fresh/cleared transcript)
   * — the carried-forward alias across a path change, or the launch model on
   * first attach. Anchors the first live line so an opening-turn fallback reads
   * as a transition rather than a silent baseline.
   */
  seedAlias: string | null
  /** True once the pre-existing backlog has been consumed silently. */
  baselined: boolean
}

const trackers = new Map<string, ModelTrackerState>()

/** Placeholder model on API-error assistant lines (isApiErrorMessage) — not a real model. */
const SYNTHETIC_MODEL = '<synthetic>'

/**
 * The baseline only needs the backlog's *final* model, so reading the file
 * tail suffices — a multi-hundred-MB transcript must not be synchronously
 * read in full on the hook path.
 */
const BASELINE_TAIL_BYTES = 512 * 1024

// A model switch only becomes visible when the next assistant line is written,
// so per-turn boundaries are the natural (and cheap) polling points.
// StopFailure is the API-error twin of Stop — same turn boundary (the
// synthetic '<synthetic>' model on API-error lines is filtered below).
const MODEL_HOOK_EVENTS = new Set([
  'SessionStart',
  'UserPromptSubmit',
  'Stop',
  'StopFailure',
  'SessionEnd'
])

// Mirrors the claude-cli catalog in claude-code-implementer.ts: sonnet/haiku
// effort tops out at 'high'; only fable/opus offer xhigh/max. A degrade must
// not leave a variant the target model cannot run ('ultracode' is exempt —
// it is settings-injected, not an --effort value).
const REDUCED_EFFORT_MODELS = new Set(['sonnet', 'haiku'])
const EXTENDED_EFFORTS = new Set(['xhigh', 'max'])

export interface ClaudeCliModelChangeHook {
  hook_event_name?: string
  transcript_path?: unknown
}

export interface ClaudeCliModelWatcherDeps {
  db?: DatabaseService
}

/**
 * Extract the models of main-chain assistant lines from a chunk of transcript
 * JSONL, in order. Sidechain (subagent) lines and synthetic API-error
 * placeholders are excluded — their models never describe the main session.
 */
export function mainChainAssistantModels(text: string): string[] {
  const models: string[] = []
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    let value: unknown
    try {
      value = JSON.parse(line)
    } catch {
      continue
    }
    if (typeof value !== 'object' || value === null || Array.isArray(value)) continue
    const record = value as Record<string, unknown>
    if (record.type !== 'assistant') continue
    if (record.isSidechain === true) continue
    const message = record.message
    if (typeof message !== 'object' || message === null || Array.isArray(message)) continue
    const model = (message as Record<string, unknown>).model
    if (typeof model !== 'string' || !model || model === SYNTHETIC_MODEL) continue
    models.push(model)
  }
  return models
}

/** Fold a chunk's models into the tracker; true when an alias-level switch was observed. */
function foldModels(tracker: ModelTrackerState, models: string[]): boolean {
  let switched = false
  for (const model of models) {
    const alias = normalizeClaudeCliModel(model)
    if (alias === null) continue
    if (tracker.lastAlias !== null && alias !== tracker.lastAlias) switched = true
    tracker.lastRawModel = model
    tracker.lastAlias = alias
  }
  return switched
}

function markForRebaseline(tracker: ModelTrackerState): void {
  // Preserve the running model across the rewrite so a fresh empty file
  // re-seeds it (a rewritten transcript does not restart the CLI).
  tracker.seedAlias = tracker.lastAlias ?? tracker.seedAlias
  tracker.offset = 0
  tracker.lastRawModel = null
  tracker.lastAlias = null
  tracker.baselined = false
}

/**
 * After a baseline consumed no assistant model (empty/cleared transcript),
 * anchor `lastAlias` to the CLI's running model so the first live line is
 * measured as a transition. A backlog that did carry a model leaves `lastAlias`
 * set and is untouched.
 */
function applyBaselineSeed(tracker: ModelTrackerState): void {
  if (tracker.lastAlias === null && tracker.seedAlias !== null) {
    tracker.lastAlias = tracker.seedAlias
  }
}

/**
 * Consume the transcript's existing content as the silent baseline: seed the
 * tracker's last model from the backlog tail without firing on its historical
 * transitions. Reads at most BASELINE_TAIL_BYTES from the end (discarding the
 * partial first line of the window); the final model is all a baseline needs.
 * On read errors the tracker stays un-baselined and retries on the next hook.
 */
function baselineTracker(tracker: ModelTrackerState): void {
  let fd: number
  try {
    fd = openSync(tracker.transcriptPath, 'r')
  } catch {
    // No transcript yet — everything written later is live.
    tracker.baselined = true
    return
  }

  try {
    const size = fstatSync(fd).size
    let start = size > BASELINE_TAIL_BYTES ? size - BASELINE_TAIL_BYTES : 0
    const buffer = Buffer.alloc(size - start)
    const bytesRead = readSync(fd, buffer, 0, buffer.length, start)
    let data = buffer.subarray(0, Math.max(0, bytesRead))

    if (start > 0) {
      const firstNewline = data.indexOf(0x0a)
      if (firstNewline === -1) {
        // A single torn line fills the window; skip the backlog outright.
        tracker.offset = size
        tracker.baselined = true
        return
      }
      data = data.subarray(firstNewline + 1)
      start += firstNewline + 1
    }

    const lastNewline = data.lastIndexOf(0x0a)
    if (lastNewline === -1) {
      tracker.offset = start
      tracker.baselined = true
      return
    }

    foldModels(tracker, mainChainAssistantModels(data.subarray(0, lastNewline + 1).toString('utf8')))
    tracker.offset = start + lastNewline + 1
    tracker.baselined = true
  } catch {
    // Leave un-baselined; the next hook retries.
  } finally {
    closeSync(fd)
  }
}

/**
 * Read the transcript bytes appended since the last call, consuming complete
 * lines only (a partial trailing line is re-read next time, so a line split
 * across writes is never parsed in halves). A shrunken file (rewritten
 * transcript) flags the tracker for a fresh silent baseline.
 */
function readTranscriptChunk(tracker: ModelTrackerState): string | null {
  let fd: number
  try {
    fd = openSync(tracker.transcriptPath, 'r')
  } catch {
    return null
  }

  try {
    const size = fstatSync(fd).size
    if (size < tracker.offset) {
      markForRebaseline(tracker)
      return null
    }
    if (size === tracker.offset) return null

    const buffer = Buffer.alloc(size - tracker.offset)
    const bytesRead = readSync(fd, buffer, 0, buffer.length, tracker.offset)
    if (bytesRead <= 0) return null

    const data = buffer.subarray(0, bytesRead)
    const lastNewline = data.lastIndexOf(0x0a)
    if (lastNewline === -1) return null

    tracker.offset += lastNewline + 1
    return data.subarray(0, lastNewline + 1).toString('utf8')
  } catch {
    return null
  } finally {
    closeSync(fd)
  }
}

function clampEffortVariant(alias: string, variant: string | null | undefined): string | undefined {
  if (!variant) return undefined
  if (REDUCED_EFFORT_MODELS.has(alias) && EXTENDED_EFFORTS.has(variant.toLowerCase())) {
    return 'high'
  }
  return undefined
}

/**
 * The model id Hive stores for a raw transcript model (or an already-stored
 * id). Selectable models collapse to their alias (fable/opus/sonnet/haiku); a
 * safety/usage fallback keeps a distinct id (e.g. `opus-4-8`) so the ticket
 * badge shows "Opus 4.8" instead of the selectable "Opus 5". Comparing both
 * sides through this resolver keeps the no-op guard honest — a stored
 * `opus-4-8` and a fresh `claude-opus-4-8` line canonicalize to the same id.
 */
function canonicalClaudeCliModelId(rawModel: string | null | undefined): string | null {
  const fallback = resolveClaudeCliFallbackModel(rawModel)
  if (fallback) return fallback.id
  return normalizeClaudeCliModel(rawModel)
}

function applyDetectedClaudeCliModel(
  sessionId: string,
  session: Session,
  rawModel: string,
  db: DatabaseService
): void {
  const modelId = canonicalClaudeCliModelId(rawModel)
  if (!modelId) return

  if (modelId === canonicalClaudeCliModelId(session.model_id)) return

  const update: SessionUpdate = { model_id: modelId }
  const clampedVariant = clampEffortVariant(modelId, session.model_variant)
  if (clampedVariant !== undefined) {
    update.model_variant = clampedVariant
  }
  db.updateSession(sessionId, update)
  log.info('claude-cli switched models mid-session', {
    sessionId,
    from: session.model_id,
    to: modelId,
    rawModel
  })

  void Promise.resolve(
    publishDesktopBackendEvent(OPENCODE_STREAM_CHANNEL, {
      type: 'session.model_changed',
      sessionId,
      data: {
        modelId,
        previousModelId: session.model_id,
        rawModel,
        ...(clampedVariant !== undefined ? { modelVariant: clampedVariant } : {})
      }
    })
  ).catch(() => undefined)
}

/**
 * Per-hook entry point (call sites: main-session hooks that passed the
 * subagent gate). Synchronous end-to-end so concurrent hooks cannot interleave
 * tracker reads with the DB compare-and-write.
 */
export function handleClaudeCliModelChangeHook(
  sessionId: string,
  hook: ClaudeCliModelChangeHook,
  deps: ClaudeCliModelWatcherDeps = {}
): void {
  try {
    if (!hook.hook_event_name || !MODEL_HOOK_EVENTS.has(hook.hook_event_name)) return
    const transcriptPath =
      typeof hook.transcript_path === 'string' && hook.transcript_path
        ? hook.transcript_path
        : null
    if (!transcriptPath) return

    const db = deps.db ?? getDatabase()
    const session = db.getSession(sessionId)
    if (!session || session.agent_sdk !== 'claude-code-cli') return
    // Custom providers own their model slugs (proxies report arbitrary model
    // ids) — never overwrite them with a stock alias.
    if (session.model_provider_id === CUSTOM_MODEL_PROVIDER_ID || session.custom_provider_id) return

    let tracker = trackers.get(sessionId)
    if (!tracker || tracker.transcriptPath !== transcriptPath) {
      // New session transcript (first hook, /clear, resume under a new id):
      // its existing content becomes a silent baseline. When that content has
      // no assistant model yet, the baseline seeds the CLI's running model:
      // the alias we were already following across a path change (the running
      // CLI, not the possibly-ahead row), or the launch model on first attach.
      const seedAlias = tracker?.lastAlias ?? normalizeClaudeCliModel(session.model_id)
      tracker = {
        transcriptPath,
        offset: 0,
        lastRawModel: null,
        lastAlias: null,
        seedAlias,
        baselined: false
      }
      trackers.set(sessionId, tracker)
    }

    if (!tracker.baselined) {
      baselineTracker(tracker)
      if (!tracker.baselined) return
      applyBaselineSeed(tracker)
    }

    let chunk = readTranscriptChunk(tracker)
    if (!tracker.baselined) {
      // The file shrank mid-read (rewritten transcript): re-baseline its new
      // content silently, then pick up anything appended after it.
      baselineTracker(tracker)
      if (!tracker.baselined) return
      applyBaselineSeed(tracker)
      chunk = readTranscriptChunk(tracker)
    }
    if (!chunk) return

    const switched = foldModels(tracker, mainChainAssistantModels(chunk))
    if (switched && tracker.lastRawModel !== null) {
      applyDetectedClaudeCliModel(sessionId, session, tracker.lastRawModel, db)
    }
  } catch (error) {
    log.warn('model-change detection failed', {
      sessionId,
      error: error instanceof Error ? error.message : String(error)
    })
  }
}

export function resetClaudeCliModelWatcher(sessionId: string): void {
  trackers.delete(sessionId)
}

export function resetAllClaudeCliModelWatchers(): void {
  trackers.clear()
}
