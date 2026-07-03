import { STATUS_PRIORITY, type SessionStatusType } from '@shared/types/session-status'
// Type-only import: claude-hook-server imports this module at runtime, so a
// runtime import back would create a cycle.
import type { ClaudeCliStatusPayload, ParsedClaudeHook } from './claude-hook-server'

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
// in the TUI, which fires no per-tool hook).
const RESET_EVENTS = new Set(['UserPromptSubmit', 'Stop', 'SessionStart', 'SessionEnd'])

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
 * re-surfaced next pending interaction).
 */
export function processClaudeCliHook(
  sessionId: string,
  hook: ParsedClaudeHook,
  mapped: ClaudeCliStatusPayload | null
): ClaudeCliStatusPayload[] {
  const event = hook.hook_event_name ?? ''

  if (RESET_EVENTS.has(event)) {
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

export function clearClaudeCliInteractions(sessionId: string): void {
  ledgers.delete(sessionId)
}

export function clearAllClaudeCliInteractions(): void {
  ledgers.clear()
}

export function hasBlockingClaudeCliInteraction(sessionId: string): boolean {
  return (ledgers.get(sessionId)?.size ?? 0) > 0
}
