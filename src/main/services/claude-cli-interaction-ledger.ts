import { STATUS_PRIORITY, type SessionStatusType } from '@shared/types/session-status'
// Type-only import: claude-hook-server imports this module at runtime, so a
// runtime import back would create a cycle.
import type { ClaudeCliStatusPayload, ParsedClaudeHook } from './claude-hook-server'
// Runtime import: claude-cli-subagent-tracker only *type*-imports from
// claude-hook-server, so this does not create a cycle.
import { isTaskNotificationPrompt } from './claude-cli-subagent-tracker'

/**
 * Per-session ledger of blocking interactions (questions, permission prompts,
 * plan approvals) raised by Claude CLI hooks. Sub-agents share the parent's
 * hive session id, so their PostToolUse hooks would otherwise overwrite an
 * unanswered question's status (last-write-wins). The ledger latches blocking
 * statuses until the hook that actually resolves them arrives, suppresses
 * unrelated status publishes in between, and re-surfaces the next pending
 * interaction once the current one resolves.
 *
 * This must run before publishClaudeCliStatus's dedup: the resolution hook
 * (PostToolUse → 'working') often carries the same status as a suppressed
 * intermediate publish, and would be dedup-swallowed if the latch lived
 * downstream (e.g. in the renderer store).
 *
 * Interactions the hooks cannot see through to the end (codex's non-blocking
 * questions) are covered by external holds — see the section at the bottom.
 */

type BlockingKind = 'answering' | 'permission' | 'plan_ready'

const KIND_STATUS: Record<BlockingKind, SessionStatusType> = {
  answering: 'answering',
  permission: 'permission',
  plan_ready: 'plan_ready'
}

interface BlockingEntry {
  kind: BlockingKind
  // Outstanding requests tracked precisely by tool_use_id when hooks carry it…
  toolUseIds: Set<string>
  // …and by count for hooks that don't.
  count: number
  // Latest register payload, re-published when this entry re-surfaces.
  payload: ClaudeCliStatusPayload
}

// sessionId → entry key ('answering' | 'plan_ready' | 'permission:<tool>') → entry
const ledgers = new Map<string, Map<string, BlockingEntry>>()

// Turn boundaries: a new prompt or a finished/started session invalidates any
// interaction the hooks failed to resolve explicitly (e.g. a permission denied
// in the TUI, which fires no per-tool hook). StopFailure is the API-error twin
// of Stop — it fires instead of Stop, so it is a turn boundary too.
const RESET_EVENTS = new Set([
  'UserPromptSubmit',
  'Stop',
  'StopFailure',
  'SessionStart',
  'SessionEnd'
])

function entrySize(entry: BlockingEntry): number {
  return entry.toolUseIds.size + entry.count
}

function classify(toolName: string | undefined): { kind: BlockingKind; key: string } {
  if (toolName === 'AskUserQuestion') return { kind: 'answering', key: 'answering' }
  if (toolName === 'ExitPlanMode') return { kind: 'plan_ready', key: 'plan_ready' }
  return { kind: 'permission', key: `permission:${toolName ?? ''}` }
}

function topEntry(session: Map<string, BlockingEntry> | undefined): BlockingEntry | null {
  if (!session) return null
  let best: BlockingEntry | null = null
  for (const entry of session.values()) {
    if (!best || STATUS_PRIORITY[KIND_STATUS[entry.kind]] > STATUS_PRIORITY[KIND_STATUS[best.kind]]) {
      best = entry
    }
  }
  return best
}

function resurfacedPayload(entry: BlockingEntry): ClaudeCliStatusPayload {
  return {
    ...entry.payload,
    metadata: { ...entry.payload.metadata, reason: 'interaction_resurfaced' }
  }
}

function registerInteraction(
  sessionId: string,
  hook: ParsedClaudeHook,
  mapped: ClaudeCliStatusPayload,
  kind: BlockingKind,
  key: string
): ClaudeCliStatusPayload[] {
  let session = ledgers.get(sessionId)
  if (!session) {
    session = new Map()
    ledgers.set(sessionId, session)
  }

  let entry = session.get(key)
  if (!entry) {
    entry = { kind, toolUseIds: new Set(), count: 0, payload: mapped }
    session.set(key, entry)
  }
  entry.payload = mapped

  if (hook.tool_use_id) {
    // Set semantics also dedupe PreToolUse + PermissionRequest firing for the
    // same tool call.
    entry.toolUseIds.add(hook.tool_use_id)
  } else if (hook.hook_event_name === 'PermissionRequest' && kind !== 'permission') {
    // PreToolUse already fires for AskUserQuestion/ExitPlanMode; a paired
    // PermissionRequest must not double-count the same interaction.
    if (entrySize(entry) === 0) entry.count = 1
  } else {
    entry.count += 1
  }

  return topEntry(session) === entry ? [mapped] : []
}

/**
 * Release one outstanding unit from the entry. Returns false when the hook's
 * tool_use_id does not match any outstanding request — i.e. an unrelated
 * parallel call of the same tool completed, which must not lift the latch.
 */
function releaseOne(entry: BlockingEntry, toolUseId: string | undefined): boolean {
  if (toolUseId) {
    if (entry.toolUseIds.delete(toolUseId)) return true
    if (entry.count > 0) {
      entry.count -= 1
      return true
    }
    return false
  }

  if (entry.count > 0) {
    entry.count -= 1
    return true
  }
  const first = entry.toolUseIds.values().next()
  if (!first.done) {
    entry.toolUseIds.delete(first.value)
    return true
  }
  return false
}

/**
 * Apply a hook to the session's interaction ledger and return the status
 * payloads to publish, in order (0, 1, or 2 — a resolution followed by the
 * re-surfaced next pending interaction). While an external hold is placed on
 * the session (see holdClaudeCliInteraction) only blocking statuses get out.
 */
export function processClaudeCliHook(
  sessionId: string,
  hook: ParsedClaudeHook,
  mapped: ClaudeCliStatusPayload | null
): ClaudeCliStatusPayload[] {
  const publishes = applyClaudeCliHook(sessionId, hook, mapped)
  if (!externalHolds.has(sessionId)) return publishes
  return publishes.filter((payload) => BLOCKING_STATUSES.has(payload.status))
}

function applyClaudeCliHook(
  sessionId: string,
  hook: ParsedClaudeHook,
  mapped: ClaudeCliStatusPayload | null
): ClaudeCliStatusPayload[] {
  const event = hook.hook_event_name ?? ''
  // A background-subagent task-notification resume is not a user turn
  // boundary: it must not reset a latched question/permission/plan the way a
  // real UserPromptSubmit would. It falls through to the normal non-reset
  // flow below, which suppresses its publish while a latch is pending.
  const isTaskNotificationResume = event === 'UserPromptSubmit' && isTaskNotificationPrompt(hook.prompt)

  if (RESET_EVENTS.has(event) && !isTaskNotificationResume) {
    // A main-turn API error (StopFailure) with background subagents still
    // running: any latched question/permission belongs to a live subagent
    // that remains blocked on it. Preserve the latch and suppress the
    // completion — mirroring the deferred-Stop watchdog's
    // hasBlockingClaudeCliInteraction guard. Without running subagent work
    // the latch can only be stale (the main agent cannot hit an API error
    // while blocked on its own dialog), so the normal reset applies.
    if (
      event === 'StopFailure' &&
      (ledgers.get(sessionId)?.size ?? 0) > 0 &&
      (hook.background_tasks ?? []).some(
        (task) =>
          (task.type === 'subagent' || task.type === 'workflow') && task.status === 'running'
      )
    ) {
      return []
    }
    ledgers.delete(sessionId)
    return mapped ? [mapped] : []
  }

  const session = ledgers.get(sessionId)

  if (mapped && (event === 'PreToolUse' || event === 'PermissionRequest')) {
    const { kind, key } = classify(hook.tool_name)
    // PreToolUse hooks are only configured for AskUserQuestion/ExitPlanMode;
    // anything else that slips through is not a blocking interaction.
    if (event === 'PermissionRequest' || kind !== 'permission') {
      return registerInteraction(sessionId, hook, mapped, kind, key)
    }
  }

  if (event === 'PostToolUse' || event === 'PostToolUseFailure') {
    const { key } = classify(hook.tool_name)
    const entry = session?.get(key)
    if (session && entry) {
      if (!releaseOne(entry, hook.tool_use_id)) return []
      if (entrySize(entry) === 0) {
        session.delete(key)
        if (session.size === 0) ledgers.delete(sessionId)
      }
      const publishes = mapped ? [mapped] : []
      const top = topEntry(session)
      if (top) publishes.push(resurfacedPayload(top))
      return publishes
    }
  }

  // While any interaction is pending, unrelated hooks neither register nor
  // release — suppress their status so the alert stays surfaced.
  if (session && session.size > 0) return []
  return mapped ? [mapped] : []
}

/**
 * Drop the hook-derived latches of a session. External holds are left in
 * place: they belong to whoever observed the interaction (the codex title
 * tracker) and end only when that observer releases them.
 */
export function clearClaudeCliInteractions(sessionId: string): void {
  ledgers.delete(sessionId)
}

export function clearAllClaudeCliInteractions(): void {
  ledgers.clear()
  externalHolds.clear()
}

export function hasBlockingClaudeCliInteraction(sessionId: string): boolean {
  return (ledgers.get(sessionId)?.size ?? 0) > 0 || externalHolds.has(sessionId)
}

// ── External holds ───────────────────────────────────────────────────
//
// A blocking interaction observed outside the hook stream: codex's
// `[ ! ] Action Required` terminal title, which stays on for the whole life
// of a request_user_input question (terminal-pty-bridge.ts). Codex asks
// non-blocking questions in Default mode — the tool returns at once, the turn
// keeps running with the question open (more tool hooks, then Stop) and the
// answer arrives later as a new user message — so the hook ledger alone
// cannot keep 'answering' surfaced: its latch is a per-turn thing, reset by
// Stop/UserPromptSubmit, and every unrelated hook after that reset would
// publish 'working' (dismissing the ticket modal) until the next title blink
// re-asserted 'answering'. A hold outlives turn boundaries: while one is
// placed, processClaudeCliHook lets only blocking statuses through, whatever
// the hook. Keyed per observer so distinct holders never release each other.

const BLOCKING_STATUSES: ReadonlySet<SessionStatusType> = new Set<SessionStatusType>([
  'answering',
  'permission',
  'plan_ready'
])

// sessionId → hold keys
const externalHolds = new Map<string, Set<string>>()

/** Idempotent: re-placing an existing hold is a no-op. */
export function holdClaudeCliInteraction(sessionId: string, key: string): void {
  let holds = externalHolds.get(sessionId)
  if (!holds) {
    holds = new Set()
    externalHolds.set(sessionId, holds)
  }
  holds.add(key)
}

/** Returns whether the hold existed. */
export function releaseClaudeCliInteraction(sessionId: string, key: string): boolean {
  const holds = externalHolds.get(sessionId)
  if (!holds?.delete(key)) return false
  if (holds.size === 0) externalHolds.delete(sessionId)
  return true
}

export function hasClaudeCliInteractionHold(sessionId: string): boolean {
  return externalHolds.has(sessionId)
}
