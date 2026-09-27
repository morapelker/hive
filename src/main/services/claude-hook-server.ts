import http from 'http'
import type { SessionStatusType } from '@shared/types/session-status'
import { OPENCODE_STREAM_CHANNEL } from '@shared/opencode-events'
import { createLogger } from './logger'
import { cliHookTransportRouter } from './cli-hook-transport-router'
import { handleClaudeCliHiveTelemetryHook } from './hive-enterprise-claude-cli-telemetry'
import {
  handleClaudeCliModelChangeHook,
  resetAllClaudeCliModelWatchers
} from './claude-cli-model-watcher'
import { scheduleSessionUsageReport } from './usage/session-usage-service'
import { getDatabase } from '../db'
import { publishDesktopBackendEvent } from '../desktop/backend-event-publisher'
import {
  clearAllClaudeCliInteractions,
  clearClaudeCliInteractions,
  hasBlockingClaudeCliInteraction,
  processClaudeCliHook
} from './claude-cli-interaction-ledger'
import {
  clearAllClaudeCliSubagentTracking,
  isTaskNotificationPrompt,
  processClaudeCliSubagentHook,
  setClaudeCliDeferredCompletionHandler,
  type ClaudeCliBackgroundTask
} from './claude-cli-subagent-tracker'
import {
  clearAllClaudeCliBackgroundWork,
  clearClaudeCliBackgroundWork,
  processClaudeCliBackgroundWorkHook
} from './claude-cli-background-work-tracker'
import {
  CLAUDE_CLI_BACKGROUND_WORK_CHANNEL,
  type ClaudeCliBackgroundWorkPayload
} from '@shared/types/claude-cli-background-work'
import {
  CLAUDE_CLI_API_ERROR_CHANNEL,
  type ClaudeCliApiErrorPayload
} from '@shared/types/claude-cli-api-error'
import {
  classifyClaudeCliStopCompletion,
  type ClaudeCliStopCompletionKind
} from '@shared/types/claude-cli-stop-completion'
import {
  clearAllClaudeCliPlanAutoApprove,
  consumeClaudeCliPlanAutoApprove,
  isClaudeCliPlanAutoApproveArmed,
  setClaudeCliPlanAutoApprove
} from './claude-cli-plan-auto-approve'
import { ptyService } from './pty-service'
import { isCodexCli } from '@shared/types/agent-sdk'
import {
  adaptCodexCliHook,
  resetAllCodexCliModelTracking,
  trackCodexCliModel,
  type CodexCliHookBody
} from './codex-cli-hook-adapter'
import { normalizeCodexModelSlug } from './codex-models'

// Delay between replying to the ExitPlanMode PermissionRequest hook and
// pressing "1" on the PTY: claude renders its plan dialog only after the hook
// response lands, and the keypress must hit the dialog, not the composer.
const PLAN_AUTO_APPROVE_KEYSTROKE_DELAY_MS = 500
// Codex shows its "Implement this plan?" selection only after the turn has
// fully completed in the TUI, which happens after the Stop hook (and the
// synthetic plan-ready hook Hive derives from it) has been answered. Wait a
// little longer than claude's dialog before pressing "1" ("Yes, implement
// this plan").
const CODEX_PLAN_AUTO_APPROVE_KEYSTROKE_DELAY_MS = 1200

export type CliHookFamily = 'claude' | 'codex'

export interface ParsedClaudeHook {
  hook_event_name?: string
  tool_name?: string
  tool_use_id?: string
  permission_mode?: string
  prompt?: unknown
  transcript_path?: unknown
  /** Claude's own id of the session the hook belongs to (the transcript's file name). */
  session_id?: unknown
  /** SessionStart: how the session started (`startup` | `resume` | `clear` | `compact`; codex only). */
  source?: unknown
  /** The turn this hook belongs to (codex only; ties hooks to rollout `task_*` records). */
  turn_id?: unknown
  tool_input?: {
    plan?: unknown
    questions?: unknown
    /** Bash: true when the command was launched as a background shell. */
    run_in_background?: unknown
    /** TaskStop: the background task id being stopped. */
    task_id?: unknown
  }
  /** PostToolUse tool result (backgroundTaskId / taskId live here). */
  tool_response?: unknown
  /** Final assistant message of the turn (Stop/StopFailure hooks). Read both spellings: */
  assistant_message?: string
  last_assistant_message?: string
  /** StopFailure: structured API-error classification (server_error, rate_limit, …). */
  error?: string
  error_details?: string
  /** Present on subagent-scoped hooks (SubagentStart/SubagentStop, subagent-scoped Stop). */
  agent_id?: string
  agent_type?: string
  /** Snapshot of in-flight background work at Stop/SubagentStop time. */
  background_tasks?: ClaudeCliBackgroundTask[]
  /** Snapshot of session-scoped scheduled wakeups (ScheduleWakeup / CronCreate / `/loop`) at Stop time. */
  session_crons?: ClaudeCliSessionCron[]
}

export interface ClaudeCliSessionCron {
  id?: string
  schedule?: string
  recurring?: boolean
  prompt?: string
}

export interface ClaudeCliStatusPayload {
  sessionId: string
  status: SessionStatusType
  metadata?: {
    reason?: string
    hookEventName?: string
    hookPath?: string
    toolName?: string
    plan?: string
    taskNotification?: boolean
    /** StopFailure: the turn ended with this API-error classification. */
    apiError?: string
    /**
     * Main-agent Stop (claude only): whether this Stop is the real completion
     * or a pause while background tasks / scheduled wakeups are pending.
     * Absent on every other status publish (no Stop hook was involved).
     */
    completion?: ClaudeCliStopCompletionKind
    /** Main-agent Stop: in-flight background tasks at stop time. */
    pendingTasks?: number
    /** Main-agent Stop: scheduled wakeups at stop time. */
    pendingWakeups?: number
  }
}

const log = createLogger({ component: 'ClaudeHookServer' })
const host = '127.0.0.1'
let server: http.Server | null = null
let boundPort: number | null = null
let startingPromise: Promise<{ port: number }> | null = null
const lastStatusBySession = new Map<string, SessionStatusType>()
const statusSubscribers = new Set<(payload: ClaudeCliStatusPayload) => void>()
// Sessions whose first UserPromptSubmit we've already announced (so the
// "automatically create ticket" feature fires at most once per session). The
// renderer's getBySession idempotency check is the real guard; this just keeps
// us from re-emitting on every prompt.
const firstPromptAnnounced = new Set<string>()

function hookUrl(port: number, hiveSessionId: string, path: string): string {
  return `http://${host}:${port}/hook/${encodeURIComponent(hiveSessionId)}/${path}`
}

export function buildClaudeCliHookSettings(port: number, hiveSessionId: string): string {
  return JSON.stringify({
    hooks: {
      SessionStart: [
        {
          hooks: [{ type: 'http', url: hookUrl(port, hiveSessionId, 'session') }]
        }
      ],
      SessionEnd: [
        {
          hooks: [{ type: 'http', url: hookUrl(port, hiveSessionId, 'session') }]
        }
      ],
      UserPromptSubmit: [
        {
          hooks: [{ type: 'http', url: hookUrl(port, hiveSessionId, 'start') }]
        }
      ],
      Stop: [
        {
          hooks: [{ type: 'http', url: hookUrl(port, hiveSessionId, 'stop') }]
        }
      ],
      // Fires instead of Stop when the turn ends because of an API error
      // (claude v2.1.241+). Without it a failed turn leaves the session
      // "working" forever — no Stop ever arrives.
      StopFailure: [
        {
          matcher: '*',
          hooks: [{ type: 'http', url: hookUrl(port, hiveSessionId, 'stop') }]
        }
      ],
      SubagentStart: [
        {
          hooks: [{ type: 'http', url: hookUrl(port, hiveSessionId, 'subagent') }]
        }
      ],
      SubagentStop: [
        {
          hooks: [{ type: 'http', url: hookUrl(port, hiveSessionId, 'subagent') }]
        }
      ],
      PreToolUse: [
        {
          matcher: 'ExitPlanMode|AskUserQuestion',
          // A generous timeout (default is 600s) so a question/plan held open
          // while a human answers via Telegram isn't cancelled early. Harmless
          // when not held — it's a ceiling, not a delay.
          hooks: [{ type: 'http', url: hookUrl(port, hiveSessionId, 'tool'), timeout: 600 }]
        }
      ],
      PostToolUse: [
        {
          matcher: '*',
          hooks: [{ type: 'http', url: hookUrl(port, hiveSessionId, 'tool') }]
        }
      ],
      PostToolUseFailure: [
        {
          matcher: '*',
          hooks: [{ type: 'http', url: hookUrl(port, hiveSessionId, 'tool') }]
        }
      ],
      PermissionRequest: [
        {
          matcher: '*',
          hooks: [{ type: 'http', url: hookUrl(port, hiveSessionId, 'permission') }]
        }
      ]
    }
  })
}

export function mapHookEventToStatus(hook: ParsedClaudeHook): SessionStatusType | null {
  switch (hook.hook_event_name) {
    case 'SessionStart':
    case 'SessionEnd':
    case 'Stop':
    // An API error ends the turn just like a Stop; the error classification
    // rides the status metadata + the dedicated api-error channel.
    case 'StopFailure':
      return 'completed'
    case 'UserPromptSubmit':
      return hook.permission_mode === 'plan' ? 'planning' : 'working'
    case 'PreToolUse':
      if (hook.tool_name === 'ExitPlanMode') return 'plan_ready'
      if (hook.tool_name === 'AskUserQuestion') return 'answering'
      return null
    case 'PostToolUseFailure':
      if (hook.tool_name === 'ExitPlanMode') return 'planning'
      return 'working'
    case 'PostToolUse':
      return 'working'
    case 'PermissionRequest':
      if (hook.tool_name === 'ExitPlanMode') return 'plan_ready'
      if (hook.tool_name === 'AskUserQuestion') return 'answering'
      return 'permission'
    case 'SubagentStart':
    case 'SubagentStop':
      return null
    default:
      return null
  }
}

function extractPlanText(hook: ParsedClaudeHook): string | undefined {
  return typeof hook.tool_input?.plan === 'string' ? hook.tool_input.plan : undefined
}

function buildStatusMetadata(
  hook: ParsedClaudeHook,
  hookPath: string,
  cli: CliHookFamily
): NonNullable<ClaudeCliStatusPayload['metadata']> {
  const metadata: NonNullable<ClaudeCliStatusPayload['metadata']> = {
    hookEventName: hook.hook_event_name,
    hookPath
  }

  if (hook.tool_name) {
    metadata.toolName = hook.tool_name
  }

  // Completion vs pause: a main-agent Stop is the real end of the work only
  // when claude reports nothing in flight and nothing scheduled. Codex hooks
  // are adapted from a different lifecycle and never carry these arrays.
  if (cli === 'claude' && hook.hook_event_name === 'Stop' && !hook.agent_id) {
    const completion = classifyClaudeCliStopCompletion(hook)
    metadata.completion = completion.kind
    metadata.pendingTasks = completion.pendingTasks
    metadata.pendingWakeups = completion.pendingWakeups
  }

  const plan = extractPlanText(hook)
  if (plan !== undefined) {
    metadata.plan = plan
  }

  if (hook.hook_event_name === 'UserPromptSubmit' && isTaskNotificationPrompt(hook.prompt)) {
    metadata.taskNotification = true
  }

  if (hook.hook_event_name === 'StopFailure') {
    metadata.apiError = typeof hook.error === 'string' ? hook.error : 'unknown'
  }

  return metadata
}

/** Hive sessions whose Claude session id is known to be on the row (or was just written). */
const claudeSessionIdKnown = new Set<string>()

export function __resetClaudeCliSessionIdCaptureForTests(): void {
  claudeSessionIdKnown.clear()
}

/**
 * Persist Claude's session id from a hook payload on the Hive session that
 * still has none. The PTY bridge learns the id by watching for the newest
 * transcript in the worktree, and that heuristic misses (a resume, two
 * spawns in one worktree, a transcript written elsewhere) — for those
 * sessions the usage reporter could never find the transcript. Every hook
 * carries `session_id`, so the first one settles it. A claimed id (another
 * Hive session already owns it) is left alone, as the bridge does.
 */
export function captureClaudeCliSessionId(hiveSessionId: string, hook: ParsedClaudeHook): void {
  if (claudeSessionIdKnown.has(hiveSessionId)) return
  const claudeSessionId = hook.session_id
  if (typeof claudeSessionId !== 'string' || claudeSessionId.length === 0) return
  // Subagent-scoped hooks carry the parent's session_id too, but only a
  // main-session hook is certain to; keep to those.
  if (hook.agent_id) return
  try {
    const db = getDatabase()
    const session = db.getSession(hiveSessionId)
    if (!session) {
      // Not a Hive session row (an e2e stub, a foreign hook): nothing to settle, ever.
      claudeSessionIdKnown.add(hiveSessionId)
      return
    }
    if (session.claude_session_id && !session.claude_session_id.startsWith('pending::')) {
      claudeSessionIdKnown.add(hiveSessionId)
      return
    }
    const claimedBy = db.getSessionByClaudeSessionId(claudeSessionId)
    if (claimedBy && claimedBy.id !== hiveSessionId) {
      // Every hook of the turn would repeat the lookup and the warning: settle it once.
      claudeSessionIdKnown.add(hiveSessionId)
      log.warn('Hook Claude session id already claimed by another session', {
        sessionId: hiveSessionId,
        claudeSessionId,
        claimedBySessionId: claimedBy.id
      })
      return
    }
    db.updateSession(hiveSessionId, { claude_session_id: claudeSessionId })
    claudeSessionIdKnown.add(hiveSessionId)
    log.info('Persisted Claude CLI session id from a hook', {
      sessionId: hiveSessionId,
      claudeSessionId
    })
    void Promise.resolve(
      publishDesktopBackendEvent(`terminal:claude-session-id:${hiveSessionId}`, claudeSessionId)
    ).catch(() => undefined)
  } catch (error) {
    log.warn('Failed to persist the Claude CLI session id from a hook', {
      sessionId: hiveSessionId,
      error: error instanceof Error ? error.message : String(error)
    })
  }
}

export function publishClaudeCliStatus(payload: ClaudeCliStatusPayload): void {
  if (lastStatusBySession.get(payload.sessionId) === payload.status) {
    return
  }

  // Every CLI stop path funnels through here as a 'completed' publish (Stop/
  // SessionEnd hooks, deferred watchdog, user interrupt, pty exit) — the one
  // choke point to trigger accurate usage reporting from the transcript.
  if (payload.status === 'completed') {
    scheduleSessionUsageReport(
      payload.sessionId,
      String(payload.metadata?.reason ?? 'claude-cli-completed')
    )
  }

  lastStatusBySession.set(payload.sessionId, payload.status)
  for (const subscriber of statusSubscribers) {
    subscriber(payload)
  }
  void Promise.resolve(publishDesktopBackendEvent('claude-cli:status', payload)).catch(
    () => undefined
  )
}

function publishClaudeCliBackgroundWork(payload: ClaudeCliBackgroundWorkPayload): void {
  void Promise.resolve(
    publishDesktopBackendEvent(CLAUDE_CLI_BACKGROUND_WORK_CHANNEL, payload)
  ).catch(() => undefined)
}

/**
 * Drop a session's background-work counts and, if it had any, tell the
 * renderer they are gone. For teardown paths that fire no SessionEnd hook
 * (PTY exit, destroy, restart) — the CLI's background tasks die with the
 * process, so the badge must not linger.
 */
export function resetClaudeCliBackgroundWork(sessionId: string): void {
  if (clearClaudeCliBackgroundWork(sessionId)) {
    publishClaudeCliBackgroundWork({
      sessionId,
      runningShells: 0,
      runningMonitors: 0,
      runningSubagents: 0
    })
  }
}

/**
 * Read the most recently published live status for a Claude CLI session, or
 * undefined if none has been published in this process. Used to gate actions
 * (e.g. teleport) on whether the session is actively running vs idle/stopped.
 */
export function getLastClaudeCliStatus(sessionId: string): SessionStatusType | undefined {
  return lastStatusBySession.get(sessionId)
}

/**
 * Drop a session's last-published status. Call from the PTY exit / destroy
 * teardown paths so the dedup map does not grow for the lifetime of the app and
 * a session re-created with the same id starts with fresh dedup state (otherwise
 * a stale 'completed' would swallow the restarted session's first status).
 */
export function clearClaudeCliStatus(sessionId: string): void {
  lastStatusBySession.delete(sessionId)
}

export function subscribeClaudeCliStatus(
  subscriber: (payload: ClaudeCliStatusPayload) => void
): () => void {
  statusSubscribers.add(subscriber)
  return () => {
    statusSubscribers.delete(subscriber)
  }
}

interface HookRoute {
  sessionId: string
  hookPath: string
  cli: CliHookFamily
}

/**
 * `/hook/<session>/<path>` carries claude's own http hooks; `/codex-hook/…`
 * carries codex hook payloads forwarded by the curl shim
 * (codex-cli-hooks.ts), which are adapted to the claude shape before entering
 * the shared pipeline.
 */
function parseHookPath(url: string | undefined): HookRoute | null {
  if (!url) return null

  try {
    const parsed = new URL(url, `http://${host}`)
    const segments = parsed.pathname.split('/').filter(Boolean)
    if (segments.length !== 3) return null
    const cli: CliHookFamily | null =
      segments[0] === 'hook' ? 'claude' : segments[0] === 'codex-hook' ? 'codex' : null
    if (!cli) return null

    return {
      sessionId: decodeURIComponent(segments[1]),
      hookPath: segments[2],
      cli
    }
  } catch {
    return null
  }
}

function readRequestBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = ''

    req.setEncoding('utf8')
    req.on('data', (chunk) => {
      body += chunk
    })
    req.on('end', () => resolve(body))
    req.on('error', reject)
  })
}

// ── Raw hook subscription (bridge-side consumers) ─────────────────────

export interface CliHookEvent {
  sessionId: string
  cli: CliHookFamily
  hook: ParsedClaudeHook
}

const hookSubscribers = new Set<(event: CliHookEvent) => void>()

/**
 * Observe every parsed hook (after CLI adaptation, before status mapping).
 * Unlike the status stream this is not deduplicated, so consumers can react
 * to e.g. a SessionStart that maps to an already-published 'completed'.
 */
export function subscribeCliHookEvents(subscriber: (event: CliHookEvent) => void): () => void {
  hookSubscribers.add(subscriber)
  return () => {
    hookSubscribers.delete(subscriber)
  }
}

function emitCliHookEvent(event: CliHookEvent): void {
  for (const subscriber of hookSubscribers) {
    try {
      subscriber(event)
    } catch (error) {
      log.warn('CLI hook subscriber threw', {
        sessionId: event.sessionId,
        error: error instanceof Error ? error.message : String(error)
      })
    }
  }
}

// ── Codex-specific per-hook bookkeeping ───────────────────────────────

/**
 * Whether Hive holds this codex session in Plan mode. Codex hook payloads
 * carry no collaboration mode, so the session row (kept in sync by the
 * renderer's mode toggle and by the implement/handoff flows) is the truth the
 * adapter maps onto claude's `permission_mode: 'plan'`.
 */
function isCodexSessionInPlanMode(hiveSessionId: string): boolean {
  try {
    const session = getDatabase().getSession(hiveSessionId)
    return session?.mode === 'plan' || session?.mode === 'super-plan'
  } catch {
    return false
  }
}

/**
 * Codex thread ids can change under a live PTY: "Yes, clear context and
 * implement" and `/new` start a fresh thread (SessionStart with source `clear`)
 * that the TUI now shows and that a later `codex resume` must target. Rebind
 * the row to the newest thread; a `resume` SessionStart names the thread we
 * asked for and never rebinds. Ids claimed by another Hive session are left
 * alone, as the shared capture does.
 */
function captureCodexCliSessionId(hiveSessionId: string, hook: ParsedClaudeHook): void {
  if (hook.hook_event_name !== 'SessionStart' || hook.agent_id) {
    captureClaudeCliSessionId(hiveSessionId, hook)
    return
  }
  const threadId = hook.session_id
  if (typeof threadId !== 'string' || threadId.length === 0) return
  try {
    const db = getDatabase()
    const session = db.getSession(hiveSessionId)
    if (!session) {
      claudeSessionIdKnown.add(hiveSessionId)
      return
    }
    const stored = session.claude_session_id
    const hasStored = !!stored && !stored.startsWith('pending::')
    if (hasStored && stored === threadId) {
      claudeSessionIdKnown.add(hiveSessionId)
      return
    }
    if (hasStored && hook.source === 'resume') {
      // Resuming re-announces the id we asked for; a mismatch here would be
      // codex picking a different thread, which it does not do.
      claudeSessionIdKnown.add(hiveSessionId)
      return
    }
    const claimedBy = db.getSessionByClaudeSessionId(threadId)
    if (claimedBy && claimedBy.id !== hiveSessionId) {
      log.warn('Codex thread id already claimed by another session', {
        sessionId: hiveSessionId,
        threadId,
        claimedBySessionId: claimedBy.id
      })
      return
    }
    db.updateSession(hiveSessionId, { claude_session_id: threadId })
    claudeSessionIdKnown.add(hiveSessionId)
    log.info(hasStored ? 'Codex CLI session moved to a new thread' : 'Persisted Codex CLI thread id from a hook', {
      sessionId: hiveSessionId,
      threadId,
      previous: hasStored ? stored : null,
      source: typeof hook.source === 'string' ? hook.source : undefined
    })
    void Promise.resolve(
      publishDesktopBackendEvent(`terminal:claude-session-id:${hiveSessionId}`, threadId)
    ).catch(() => undefined)
  } catch (error) {
    log.warn('Failed to persist the Codex CLI thread id from a hook', {
      sessionId: hiveSessionId,
      error: error instanceof Error ? error.message : String(error)
    })
  }
}

/**
 * Codex names the model on every hook. On an observed switch (the TUI's
 * /model, an automatic fallback) update the row and tell the renderer, the
 * same way the Claude transcript watcher does.
 */
function handleCodexCliModelHook(hiveSessionId: string, body: CodexCliHookBody): void {
  if (typeof body.agent_id === 'string' && body.agent_id) return
  const switched = trackCodexCliModel(hiveSessionId, body.model)
  if (!switched) return
  try {
    const db = getDatabase()
    const session = db.getSession(hiveSessionId)
    if (!session || !isCodexCli(session.agent_sdk)) return
    const modelId = normalizeCodexModelSlug(switched) ?? switched
    if (modelId === (normalizeCodexModelSlug(session.model_id) ?? session.model_id)) return
    db.updateSession(hiveSessionId, { model_id: modelId })
    log.info('codex-cli switched models mid-session', {
      sessionId: hiveSessionId,
      from: session.model_id,
      to: modelId
    })
    void Promise.resolve(
      publishDesktopBackendEvent(OPENCODE_STREAM_CHANNEL, {
        type: 'session.model_changed',
        sessionId: hiveSessionId,
        data: { modelId, previousModelId: session.model_id, rawModel: switched }
      })
    ).catch(() => undefined)
  } catch (error) {
    log.warn('Failed to apply a codex-cli model change', {
      sessionId: hiveSessionId,
      error: error instanceof Error ? error.message : String(error)
    })
  }
}

function isSyntheticCodexPlanHook(hook: ParsedClaudeHook): boolean {
  return (
    hook.tool_name === 'ExitPlanMode' &&
    typeof hook.tool_use_id === 'string' &&
    hook.tool_use_id.startsWith('codex-plan:')
  )
}

interface ProcessHookOptions {
  /** metadata.reason for the mapped status (e.g. `user_interrupt` for codex's Interrupt hook). */
  reason?: string
}

/**
 * Run one Claude-shaped hook through the shared pipeline. Returns true when a
 * transport took ownership of the HTTP response (held open for a remote
 * answer); the caller then must not end it.
 */
function processCliHook(
  route: HookRoute,
  body: ParsedClaudeHook,
  res: http.ServerResponse,
  options: ProcessHookOptions = {}
): boolean {
  let owned = false
  emitCliHookEvent({ sessionId: route.sessionId, cli: route.cli, hook: body })
  if (route.cli === 'codex') {
    captureCodexCliSessionId(route.sessionId, body)
  } else {
    captureClaudeCliSessionId(route.sessionId, body)
  }
  const status = mapHookEventToStatus(body)
  const mapped: ClaudeCliStatusPayload | null = status
    ? {
        sessionId: route.sessionId,
        status,
        metadata: {
          ...buildStatusMetadata(body, route.hookPath, route.cli),
          ...(options.reason ? { reason: options.reason } : {})
        }
      }
    : null
  // Live background shell/monitor counts for the kanban ticket badge.
  // Independent of the status pipeline below: counting must see every
  // hook (including ones the subagent gate swallows), and count changes
  // ride a dedicated channel so the status dedup can't eat them.
  const backgroundWork = processClaudeCliBackgroundWorkHook(route.sessionId, body)
  if (backgroundWork) {
    publishClaudeCliBackgroundWork({ sessionId: route.sessionId, ...backgroundWork })
  }
  // API errors end the turn as StopFailure instead of Stop. The structured
  // classification rides its own channel so the status dedup can't eat it
  // (e.g. when a watchdog already published 'completed' for this turn).
  // Subagent-scoped failures (agent_id set) are not a main-turn failure.
  if (body.hook_event_name === 'StopFailure' && !body.agent_id) {
    const apiError: ClaudeCliApiErrorPayload = {
      sessionId: route.sessionId,
      error: typeof body.error === 'string' ? body.error : 'unknown'
    }
    if (typeof body.error_details === 'string') apiError.errorDetails = body.error_details
    const lastMessage = body.last_assistant_message ?? body.assistant_message
    if (typeof lastMessage === 'string') apiError.lastAssistantMessage = lastMessage
    log.warn('Claude CLI turn ended with an API error', {
      sessionId: route.sessionId,
      error: apiError.error,
      errorDetails: apiError.errorDetails
    })
    void Promise.resolve(
      publishDesktopBackendEvent(CLAUDE_CLI_API_ERROR_CHANNEL, apiError)
    ).catch(() => undefined)
  }
  // Background Task subagents can keep running after the main agent's
  // Stop fires; the tracker decides whether this Stop is truly final
  // ('pass'), must be swallowed because work is still in flight
  // ('defer_stop'), or is scoped to a subagent turn and never a session
  // completion ('subagent_scoped'). Only a 'pass' should reach the
  // ledger/telemetry/status publish — a deferred Stop's RESET would
  // otherwise clobber a subagent's latched question/permission.
  const gate = processClaudeCliSubagentHook(route.sessionId, body, mapped)
  if (gate.kind === 'pass') {
    // The interaction ledger latches blocking statuses (question/permission/
    // plan approval) so parallel sub-agent hooks can't clobber them, and
    // re-surfaces queued interactions as each one resolves.
    for (const payload of processClaudeCliHook(route.sessionId, body, mapped)) {
      publishClaudeCliStatus(payload)
    }
    void handleClaudeCliHiveTelemetryHook(route.sessionId, body)
    // Mid-session model change (usage-limit/safety degrade, /model): the
    // transcript is the only surface that records it for PTY sessions.
    // Main-session hooks only — a subagent-scoped hook's transcript_path
    // points at the subagent's own file. Codex names the model on every
    // hook payload instead (handled by the codex route before adaptation).
    if (route.cli === 'claude') {
      handleClaudeCliModelChangeHook(route.sessionId, body)
    }
  }
  // First user prompt of this CLI session → tell the renderer so it can
  // auto-create a kanban ticket (if the setting is on). Fires for prompts
  // typed straight into the terminal as well as composer/handoff prompts.
  // A task-notification resume is an auto-generated continuation turn,
  // not a user-authored prompt, so it must never count as "first prompt"
  // (and must not be recorded as announced — a later real prompt should
  // still announce).
  if (
    body.hook_event_name === 'UserPromptSubmit' &&
    typeof body.prompt === 'string' &&
    body.prompt.trim().length > 0 &&
    !isTaskNotificationPrompt(body.prompt) &&
    !firstPromptAnnounced.has(route.sessionId)
  ) {
    firstPromptAnnounced.add(route.sessionId)
    void publishDesktopBackendEvent(OPENCODE_STREAM_CHANNEL, {
      type: 'claude-cli.first-prompt-detected',
      sessionId: route.sessionId,
      data: { promptText: body.prompt }
    })
  }
  // Plan auto-approve: an armed session's ExitPlanMode is answered here
  // instead of by the user. The setMode permission is only honored on the
  // PermissionRequest hook (not PreToolUse), so the PreToolUse must fall
  // through unheld — which also means transports (Telegram/Discord) must
  // not grab it, or the plan would go to the phone instead. Subagent
  // ExitPlanMode hooks (agent_id set) never consume the main plan's arm.
  const autoApproveExitPlan =
    body.tool_name === 'ExitPlanMode' &&
    !body.agent_id &&
    isClaudeCliPlanAutoApproveArmed(route.sessionId)
  const bypassTransport =
    autoApproveExitPlan &&
    (body.hook_event_name === 'PreToolUse' || body.hook_event_name === 'PermissionRequest')

  // For forwarded CLI sessions a transport may take ownership of the
  // response (held open until answered). Otherwise behavior is unchanged.
  // suppressIdle keeps a deferred/subagent-scoped Stop from telling the
  // transport the session went idle while background work is in flight.
  // Codex hooks are never held: its request_user_input tool cannot take
  // answers through the hook reply, and its plan approval is a TUI
  // selection, so transports only observe (busy/idle/question notices).
  if (!bypassTransport) {
    owned = cliHookTransportRouter.routeHook(route.sessionId, body, res, {
      // Also suppress idle when a StopFailure preserved a background
      // subagent's latched question/permission (the ledger kept it) —
      // the session is still blocked awaiting input, not idle.
      suppressIdle:
        gate.kind !== 'pass' ||
        (body.hook_event_name === 'StopFailure' &&
          hasBlockingClaudeCliInteraction(route.sessionId)),
      ...(route.cli === 'codex' ? { disableHeldInteractions: true } : {})
    })
  }

  if (
    route.cli === 'claude' &&
    autoApproveExitPlan &&
    body.hook_event_name === 'PermissionRequest' &&
    !res.writableEnded
  ) {
    // Hook responses cannot approve the plan dialog: on claude v2.1.201 a
    // PermissionRequest hookSpecificOutput.decision (allow + setMode) is
    // accepted but the interactive dialog is shown anyway (verified
    // empirically — claude-playground keeps a keystroke fallback for the
    // same reason). So reply '{}' to let the dialog render, then press "1"
    // ("Yes, and bypass permissions") on the PTY — approval and
    // bypassPermissions in the same stroke, exactly like a manual approve.
    const approvedSessionId = route.sessionId
    consumeClaudeCliPlanAutoApprove(approvedSessionId)
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end('{}')
    setTimeout(() => {
      if (!ptyService.has(approvedSessionId)) {
        log.warn('Plan auto-approve keystroke skipped: PTY is gone', {
          sessionId: approvedSessionId
        })
        return
      }
      ptyService.write(approvedSessionId, '1')
      log.info('Auto-approved ExitPlanMode plan', { sessionId: approvedSessionId })
    }, PLAN_AUTO_APPROVE_KEYSTROKE_DELAY_MS)
  }

  if (
    route.cli === 'codex' &&
    autoApproveExitPlan &&
    body.hook_event_name === 'PreToolUse' &&
    isSyntheticCodexPlanHook(body)
  ) {
    // Codex's plan approval is the "Implement this plan?" selection the TUI
    // opens once the turn completes: item 1 is "Yes, implement this plan".
    const approvedSessionId = route.sessionId
    consumeClaudeCliPlanAutoApprove(approvedSessionId)
    setTimeout(() => {
      if (!ptyService.has(approvedSessionId)) {
        log.warn('Codex plan auto-approve keystroke skipped: PTY is gone', {
          sessionId: approvedSessionId
        })
        return
      }
      ptyService.write(approvedSessionId, '1')
      log.info('Auto-approved codex proposed plan', { sessionId: approvedSessionId })
    }, CODEX_PLAN_AUTO_APPROVE_KEYSTROKE_DELAY_MS)
  }

  if (body.hook_event_name === 'SessionEnd') {
    setClaudeCliPlanAutoApprove(route.sessionId, false)
  }
  return owned
}

async function handleHook(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const remoteAddress = req.socket.remoteAddress
  if (remoteAddress !== host) {
    res.writeHead(403, { 'content-type': 'application/json' })
    res.end('{}')
    return
  }

  if (req.method !== 'POST') {
    res.writeHead(405, { 'content-type': 'application/json' })
    res.end('{}')
    return
  }

  // Read+parse the body before responding so the Telegram bridge can decide
  // whether to hold the response open (to answer a question/plan remotely). The
  // status publish below is unchanged and still drives the in-app badge.
  const route = parseHookPath(req.url)
  let owned = false
  try {
    const rawBody = await readRequestBody(req)
    const parsedBody = JSON.parse(rawBody || '{}') as ParsedClaudeHook
    if (route?.cli === 'codex') {
      const codexBody = parsedBody as CodexCliHookBody
      handleCodexCliModelHook(route.sessionId, codexBody)
      const adapted = adaptCodexCliHook(codexBody, {
        planMode: isCodexSessionInPlanMode(route.sessionId)
      })
      for (const { hook, reason } of adapted) {
        // A codex reply is never held, so ownership cannot pass to a transport.
        processCliHook(route, hook, res, { reason })
      }
    } else if (route) {
      owned = processCliHook(route, parsedBody, res)
    }
  } catch (error) {
    log.warn('Failed to parse Claude hook payload', {
      error: error instanceof Error ? error.message : String(error)
    })
  }

  if (!owned && !res.writableEnded) {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end('{}')
  }
}

export async function getClaudeHookServer(): Promise<{ port: number }> {
  // Re-registered on every call (the setter is idempotent) because
  // closeClaudeHookServer clears it — a subsequent getClaudeHookServer() must
  // restore it even when reusing an already-listening server.
  setClaudeCliDeferredCompletionHandler((sessionId, payload, lastAssistantMessage) => {
    if (hasBlockingClaudeCliInteraction(sessionId)) return false
    clearClaudeCliInteractions(sessionId)
    // Intentionally does not record telemetry idle here (no recordIdle call):
    // this path fires when the resume turn's own Stop never showed up, so
    // there is no matching hook payload to drive recordIdle off of. Known
    // accepted gap: this can leave a dangling `activePromptBySession` entry
    // in the telemetry module, which would inflate the *next* turn's usage
    // delta with this turn's untallied tokens.
    publishClaudeCliStatus({
      ...payload,
      metadata: { ...payload.metadata, reason: 'deferred_completion_watchdog' }
    })
    cliHookTransportRouter.notifySessionIdle(sessionId, lastAssistantMessage)
    return true
  })

  if (server && boundPort !== null) {
    return { port: boundPort }
  }

  if (startingPromise) {
    return startingPromise
  }

  server = http.createServer((req, res) => {
    void handleHook(req, res)
  })

  // Held hook responses (a question/plan awaiting a Telegram answer) can stay
  // open for minutes; disable Node's own request/socket timeouts so they aren't
  // dropped mid-wait. The per-hook `timeout` in the injected settings is the
  // real upper bound, with the bridge's safety timer just under it.
  server.requestTimeout = 0
  server.headersTimeout = 0
  server.timeout = 0

  startingPromise = (async () => {
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error): void => {
        server?.off('listening', onListening)
        reject(error)
      }
      const onListening = (): void => {
        server?.off('error', onError)
        resolve()
      }

      server?.once('error', onError)
      server?.once('listening', onListening)
      server?.listen(0, host)
    })

    const address = server?.address()
    if (!address || typeof address === 'string') {
      throw new Error('Claude hook server failed to bind a TCP port')
    }

    boundPort = address.port
    log.info(`ClaudeHookServer listening on http://${host}:${boundPort}`)
    return { port: boundPort }
  })()

  try {
    return await startingPromise
  } catch (error) {
    server = null
    boundPort = null
    throw error
  } finally {
    startingPromise = null
  }
}

export async function closeClaudeHookServer(): Promise<void> {
  // Unblock any held hook responses first, otherwise their open sockets keep the
  // server alive and `close()` hangs at shutdown.
  cliHookTransportRouter.cancelAll()

  if (!server) {
    boundPort = null
    startingPromise = null
    lastStatusBySession.clear()
    statusSubscribers.clear()
    clearAllClaudeCliInteractions()
    clearAllClaudeCliSubagentTracking()
    clearAllClaudeCliBackgroundWork()
    clearAllClaudeCliPlanAutoApprove()
    resetAllClaudeCliModelWatchers()
    resetAllCodexCliModelTracking()
    hookSubscribers.clear()
    setClaudeCliDeferredCompletionHandler(null)
    return
  }

  const closingServer = server
  server = null

  await new Promise<void>((resolve, reject) => {
    closingServer.close((error) => {
      if (error) reject(error)
      else resolve()
    })
  })

  log.info('ClaudeHookServer closed')
  boundPort = null
  startingPromise = null
  lastStatusBySession.clear()
  statusSubscribers.clear()
  clearAllClaudeCliInteractions()
  clearAllClaudeCliSubagentTracking()
  clearAllClaudeCliBackgroundWork()
  clearAllClaudeCliPlanAutoApprove()
  resetAllClaudeCliModelWatchers()
  resetAllCodexCliModelTracking()
  hookSubscribers.clear()
  setClaudeCliDeferredCompletionHandler(null)
}
