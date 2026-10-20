import { lastSessionAbortTime } from '@/api/opencode-api'
import { useQuestionStore } from '@/stores/useQuestionStore'
import { useSessionStore } from '@/stores/useSessionStore'
import {
  countBackgroundWork,
  useWorktreeStatusStore,
  type SessionStatusEntry
} from '@/stores/useWorktreeStatusStore'
import type {
  ClaudeCliCompletion,
  ClaudeCliPendingWork
} from '@shared/types/claude-cli-stop-completion'

// What a document run can observe about one agent session, reduced from the renderer's
// status and question stores to the four cases the orchestrator acts on. Turn status is
// never persisted, so this is all there is until the session's next hook after a reload.

export type SessionBlockReason = 'question' | 'permission' | 'command_approval' | 'plan'

/** `reason` of an ended signal for an SDK session the user stopped. */
export const USER_ABORT_REASON = 'user_abort'

export type SessionSignal =
  | {
      kind: 'working'
      /** When the status was written (epoch ms); absent only in test fakes. */
      since?: number
    }
  | { kind: 'blocked'; reason: SessionBlockReason; detail: string | null }
  | {
      kind: 'ended'
      /** When the turn ended (epoch ms). */
      at: number
      /** Claude CLI only: `waiting` is a pause, `none` means no Stop hook ended the turn. */
      completion: ClaudeCliCompletion | undefined
      /** What holds a `waiting` pause open, when the Stop hook said. */
      pending?: ClaudeCliPendingWork
      apiError: string | null
      reason: string | null
      /** The CLI hook that published the end (`Stop`, `SessionStart`, `SessionEnd`, …), if any. */
      hookEvent: string | null
      hasBackgroundWork: boolean
    }
  | { kind: 'unknown' }

// Opening a worktree nulls its sessions' 'completed' entries (clearWorktreeUnread), which
// would make a finished turn vanish the moment the user looks at it. The last completed
// entry per session is kept here until the session visibly moves on.
const lastCompleted = new Map<string, SessionStatusEntry>()
// When each session was last seen busy or blocked: an abort only explains an end that came
// after it with no new activity in between.
const lastActiveAt = new Map<string, number>()
let stopLatch: (() => void) | null = null

type SessionStatuses = Record<string, SessionStatusEntry | null>

function recordStatuses(statuses: SessionStatuses, previous: SessionStatuses): void {
  for (const [sessionId, entry] of Object.entries(statuses)) {
    if (!entry || entry === previous[sessionId]) continue
    if (entry.status === 'completed') {
      lastCompleted.set(sessionId, entry)
    } else if (entry.status !== 'unread') {
      lastCompleted.delete(sessionId)
      lastActiveAt.set(sessionId, entry.timestamp)
    }
  }
}

/** Start remembering completed turns. Idempotent; `getSessionSignal` starts it on first use. */
export function startSessionSignalLatch(): void {
  if (stopLatch) return
  recordStatuses(useWorktreeStatusStore.getState().sessionStatuses, {})
  stopLatch = useWorktreeStatusStore.subscribe((state, previous) => {
    if (state.sessionStatuses !== previous.sessionStatuses) {
      recordStatuses(state.sessionStatuses, previous.sessionStatuses)
    }
  })
}

export function resetSessionSignalLatchForTests(): void {
  stopLatch?.()
  stopLatch = null
  lastCompleted.clear()
  lastActiveAt.clear()
}

/** The first pending question's text; null when it has none; undefined when nothing is pending. */
function pendingQuestion(sessionId: string): string | null | undefined {
  const request = useQuestionStore.getState().pendingBySession.get(sessionId)?.[0]
  if (!request) return undefined
  const first = request.questions[0]
  return first?.question?.trim() || first?.header?.trim() || null
}

/**
 * An SDK session's completed entry carries no reason; it was the user's Stop when the abort
 * mark falls between the session's last activity and the end.
 */
function endedByUserAbort(sessionId: string, ended: SessionStatusEntry): boolean {
  const opencodeSessionId = useSessionStore
    .getState()
    .getSessionById(sessionId)?.opencode_session_id
  if (!opencodeSessionId) return false
  const abortedAt = lastSessionAbortTime(opencodeSessionId)
  if (abortedAt === undefined || abortedAt > ended.timestamp) return false
  return abortedAt >= (lastActiveAt.get(sessionId) ?? 0)
}

/** What a paused turn waits on, from the Stop hook's counts; undefined when it gave none. */
function pendingWork(ended: SessionStatusEntry): ClaudeCliPendingWork | undefined {
  if (ended.completion !== 'waiting' || typeof ended.pendingTasks !== 'number') return undefined
  const pendingMonitors = ended.pendingMonitors ?? 0
  const described = ended.monitors ?? []
  return {
    monitors:
      described.length === pendingMonitors
        ? described
        : Array.from({ length: pendingMonitors }, (_, index) => described[index] ?? ''),
    wakeups: ended.pendingWakeups ?? 0,
    agents: Math.max(0, ended.pendingTasks - pendingMonitors)
  }
}

export function getSessionSignal(sessionId: string): SessionSignal {
  startSessionSignalLatch()
  const state = useWorktreeStatusStore.getState()
  const entry = state.sessionStatuses[sessionId] ?? null

  const question = pendingQuestion(sessionId)
  if (question !== undefined) return { kind: 'blocked', reason: 'question', detail: question }

  switch (entry?.status) {
    case 'working':
    case 'planning':
      return { kind: 'working', since: entry.timestamp }
    case 'answering':
      // CLI questions never reach the question store; their text stays in the main process.
      return { kind: 'blocked', reason: 'question', detail: null }
    case 'permission':
      return {
        kind: 'blocked',
        reason: 'permission',
        detail: entry.toolName ? `Permission to use ${entry.toolName}` : null
      }
    case 'command_approval':
      return { kind: 'blocked', reason: 'command_approval', detail: null }
    case 'plan_ready':
      return { kind: 'blocked', reason: 'plan', detail: null }
    default:
      break
  }

  const ended = entry?.status === 'completed' ? entry : lastCompleted.get(sessionId)
  if (!ended) return { kind: 'unknown' }
  const pending = pendingWork(ended)
  return {
    kind: 'ended',
    at: ended.timestamp,
    completion: ended.completion,
    ...(pending ? { pending } : {}),
    apiError: ended.apiError ?? state.sessionApiErrors[sessionId] ?? null,
    reason: ended.reason ?? (endedByUserAbort(sessionId, ended) ? USER_ABORT_REASON : null),
    hookEvent: ended.hookEventName ?? null,
    hasBackgroundWork: countBackgroundWork(state.backgroundWorkBySession[sessionId]) > 0
  }
}
