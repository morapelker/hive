import path from 'node:path'
import { getDatabase } from '../db'
import {
  buildClaudeCliHookSettings,
  getClaudeHookServer,
  getLastClaudeCliStatus,
  publishClaudeCliStatus,
  resetClaudeCliBackgroundWork,
  subscribeClaudeCliStatus,
  subscribeCliHookEvents,
  type ClaudeCliStatusPayload
} from './claude-hook-server'
import {
  clearAllClaudeCliInteractions,
  clearClaudeCliInteractions
} from './claude-cli-interaction-ledger'
import {
  clearAllClaudeCliSubagentTracking,
  clearClaudeCliSubagentTracking
} from './claude-cli-subagent-tracker'
import { clearAllClaudeCliBackgroundWork } from './claude-cli-background-work-tracker'
import {
  resetAllClaudeCliModelWatchers,
  resetClaudeCliModelWatcher
} from './claude-cli-model-watcher'
import { setClaudeCliPlanAutoApprove } from './claude-cli-plan-auto-approve'
import { logClaudeBinaryVersion, resolveClaudeBinaryPath } from './claude-binary-resolver'
import { buildClaudeCliPtySpawn } from './claude-cli-spawner'
import { ensureProjectTrustCheck } from './claude-trust'
import { getCustomProviderById } from './custom-providers'
import type { CustomProviderModel } from '@shared/types/custom-provider'
import { externalizeGoalHandoffPlan } from './claude-cli-plan-handoff'
import { reassertClaudeCliPromptSubmit, writeClaudeCliPrompt } from './claude-cli-pty-prompt'
import { watchForClaudeSessionId, type ClaudeSessionWatchHandle } from './claude-session-watcher'
import {
  watchForClaudePlanFollowup,
  type ClaudePlanFollowupWatchHandle
} from './claude-plan-followup-watcher'
import {
  applyClaudeCliTitle,
  processClaudeCliPtyData,
  resetAllClaudeCliTitleState,
  resetClaudeCliTitleState
} from './claude-cli-title-handler'
import { ghosttyService } from './ghostty-service'
import { createLogger } from './logger'
import { ptyService } from './pty-service'
import { getAgentSdkDisplayName, isAgentCli, isCodexCli } from '@shared/types/agent-sdk'
import { resolveCodexBinaryPath } from './codex-binary-resolver'
import { buildCodexCliHookOverrides } from './codex-cli-hooks'
import { buildCodexCliPtySpawn } from './codex-cli-spawner'
import {
  findCodexRolloutByIdPrefix,
  watchCodexTurnEnd,
  watchForCodexSessionId,
  type CodexSessionWatchHandle,
  type CodexTurnWatchHandle
} from './codex-cli-rollout'
import {
  CLAUDE_CLI_API_ERROR_CHANNEL,
  type ClaudeCliApiErrorPayload
} from '@shared/types/claude-cli-api-error'
import {
  buildCodexTerminalTitleOverride,
  extractCodexTitles,
  parseCodexTerminalTitle,
  resetAllCodexTitleState,
  resetCodexTitleState,
  type CodexRunState
} from './codex-cli-title'
import { resetAllCodexCliModelTracking, resetCodexCliModelTracking } from './codex-cli-hook-adapter'

const log = createLogger({ component: 'TerminalPtyBridge' })

const listenerCleanups = new Map<string, { removeData: () => void; removeExit: () => void }>()
const dataBuffers = new Map<string, string>()
const flushScheduled = new Set<string>()
const claudeWatchers = new Map<string, ClaudeSessionWatchHandle>()
const claudePlanFollowupWatchers = new Map<string, ClaudePlanFollowupWatchHandle>()
const claudeCliSessions = new Set<string>()
const claudeCliWorktreeBasenames = new Map<string, string>()
const claudeCliTranscriptSources = new Map<
  string,
  { worktreePath: string; claudeSessionId: string | null }
>()
const claudeCliLastStatus = new Map<string, ClaudeCliStatusPayload>()
let unsubscribeClaudeCliStatus: (() => void) | null = null

// ── Codex CLI (TUI) sessions ──────────────────────────────────────────
// Codex sessions share every generic CLI path above (status subscription,
// interrupt mirroring, exit handling — they are members of claudeCliSessions
// too) and add: prompt delivery through the composer once the TUI reports
// itself Ready (codex has no plan-mode flag and does not parse slash commands
// from argv), a Shift+Tab into Plan mode for plan sessions, thread-id capture
// from the title / rollout folder, and run-state fallbacks for turns that end
// without a Stop hook.
const codexCliSessions = new Set<string>()
const codexWatchers = new Map<string, CodexSessionWatchHandle>()
const codexRunState = new Map<string, CodexRunState | null>()
const codexThreadTitleApplied = new Set<string>()
const codexResolvedPrefixes = new Map<string, string>()
interface CodexPendingStart {
  prompt: string | null
  planMode: boolean
  /** Fires the start if the title channel never speaks (unsupported codex). */
  fallbackTimer: NodeJS.Timeout | null
  /** Armed on a Ready title, cancelled by Starting/Working: the TUI must sit idle this long first. */
  settleTimer: NodeJS.Timeout | null
  sawTitle: boolean
}
const codexPendingStarts = new Map<string, CodexPendingStart>()
const codexWorkingFallbackTimers = new Map<string, NodeJS.Timeout>()
/** Last user prompt per codex session (from the UserPromptSubmit hook) — filters interim thread titles. */
const codexLastPrompt = new Map<string, string>()
/** Rollout tail per codex session while a turn is in flight (turn-end without a Stop hook). */
const codexTurnWatchers = new Map<string, CodexTurnWatchHandle>()
let unsubscribeCodexHookEvents: (() => void) | null = null

/**
 * The most recent prompt handed to each CLI PTY and when. A session start can
 * reach createClaudeCliTerminal twice with the same prompt (the launch path
 * and the mounting session view both carry it); the second call finds the PTY
 * alive and would paste the prompt on top of the argv copy, which codex queues
 * as a second turn. Anything delivered within this window is not re-pasted.
 */
const recentPromptDeliveries = new Map<string, { prompt: string; at: number }>()
const PROMPT_REDELIVERY_WINDOW_MS = 60_000

function rememberPromptDelivery(sessionId: string, prompt: string): void {
  recentPromptDeliveries.set(sessionId, { prompt: prompt.trim(), at: Date.now() })
}

function wasPromptJustDelivered(sessionId: string, prompt: string): boolean {
  const recent = recentPromptDeliveries.get(sessionId)
  return (
    !!recent &&
    recent.prompt === prompt.trim() &&
    Date.now() - recent.at < PROMPT_REDELIVERY_WINDOW_MS
  )
}

function closeCodexTurnWatcher(sessionId: string): void {
  codexTurnWatchers.get(sessionId)?.close()
  codexTurnWatchers.delete(sessionId)
}

/**
 * Codex runs its Stop hook only for turns that end with an answer; a turn
 * that fails (API error, inaccessible model) ends silently for hooks. The
 * rollout records every turn's end (`task_complete` with an `error`, or
 * `turn_aborted`), so from each UserPromptSubmit the transcript is tailed and
 * an end record that arrives without a Stop flips the session to completed —
 * flagging the failure like claude's StopFailure does.
 */
function armCodexTurnWatcher(
  sessionId: string,
  transcriptPath: string,
  turnId: string | null
): void {
  closeCodexTurnWatcher(sessionId)
  codexTurnWatchers.set(
    sessionId,
    watchCodexTurnEnd(transcriptPath, turnId, (end) => {
      codexTurnWatchers.delete(sessionId)
      if (!codexCliSessions.has(sessionId)) return
      const last = getLastClaudeCliStatus(sessionId)
      if (last !== 'working' && last !== 'planning' && last !== undefined) return
      log.info('Codex turn ended without a Stop hook; completing from the rollout', {
        sessionId,
        kind: end.kind,
        hasError: !!end.error
      })
      clearClaudeCliInteractions(sessionId)
      clearClaudeCliSubagentTracking(sessionId)
      if (end.error) {
        const apiError: ClaudeCliApiErrorPayload = {
          sessionId,
          error: 'codex_turn_failed',
          errorDetails: end.error
        }
        void import('../desktop/backend-event-publisher')
          .then(({ publishDesktopBackendEvent }) =>
            publishDesktopBackendEvent(CLAUDE_CLI_API_ERROR_CHANNEL, apiError)
          )
          .catch(() => undefined)
      }
      publishClaudeCliStatus({
        sessionId,
        status: 'completed',
        metadata: {
          reason: end.kind === 'aborted' ? 'codex_turn_aborted' : 'codex_turn_ended',
          ...(end.error ? { apiError: 'codex_turn_failed' } : {})
        }
      })
    })
  )
}

function ensureCodexHookSubscription(): void {
  if (unsubscribeCodexHookEvents) return
  unsubscribeCodexHookEvents = subscribeCliHookEvents((event) => {
    if (event.cli !== 'codex' || !codexCliSessions.has(event.sessionId)) return
    const hook = event.hook
    if (hook.agent_id) return
    if (hook.hook_event_name === 'UserPromptSubmit') {
      if (typeof hook.prompt === 'string') codexLastPrompt.set(event.sessionId, hook.prompt)
      if (typeof hook.transcript_path === 'string' && hook.transcript_path) {
        armCodexTurnWatcher(
          event.sessionId,
          hook.transcript_path,
          typeof hook.turn_id === 'string' ? hook.turn_id : null
        )
      }
    } else if (hook.hook_event_name === 'Stop' || hook.hook_event_name === 'SessionEnd') {
      // The hook pipeline owns this turn end; the rollout tail is redundant.
      closeCodexTurnWatcher(event.sessionId)
    }
  })
}

/**
 * Codex names a thread in two steps: the moment a turn starts the title shows
 * the prompt's first characters, and once the turn is idle a generated summary
 * replaces it ("Plan adding repository license"). Only the summary is worth
 * naming the session (and its branch) after, so a title is accepted when the
 * TUI is idle and the text is not just the head of the prompt.
 */
function isInterimCodexThreadTitle(sessionId: string, title: string): boolean {
  const prompt = codexLastPrompt.get(sessionId)
  if (!prompt) return false
  const normalizedPrompt = prompt.replace(/\s+/g, ' ').trim()
  const normalizedTitle = title.replace(/\s+/g, ' ').trim()
  return (
    normalizedPrompt.startsWith(normalizedTitle) ||
    normalizedTitle.startsWith(normalizedPrompt.slice(0, Math.min(24, normalizedPrompt.length)))
  )
}

/** Shift+Tab — cycles the codex TUI's collaboration mode (Default ↔ Plan). */
const CODEX_MODE_TOGGLE_KEY = '\x1b[Z'
/** Time for the TUI to switch modes before the prompt is pasted. */
const CODEX_MODE_TOGGLE_SETTLE_MS = 200
/**
 * Codex reports `Ready` once as the TUI paints, then `Starting` while MCP
 * servers come up, then `Ready` again. The collaboration-mode toggle is a
 * no-op until the mode list has been fetched, so Shift+Tab (and the paste) go
 * out only after the TUI has stayed Ready this long (verified against 0.153.4:
 * a toggle right after the first Ready is ignored, one after the post-Starting
 * Ready switches to Plan mode).
 */
const CODEX_READY_SETTLE_MS = 1_200
/**
 * If no `Ready` title ever arrives (title channel unsupported by the installed
 * codex), deliver the pending prompt anyway after this long; the submit
 * re-assert covers a composer that is still booting.
 */
const CODEX_READY_FALLBACK_MS = 8_000
/**
 * The title flips to `Working` before codex runs its UserPromptSubmit hook.
 * Publishing 'working' straight from the title would win the status dedup and
 * strip the hook's metadata (explicit-send / plan-mode signals the renderer
 * needs), so the title-derived 'working' waits this long and only fires when
 * no hook has moved the session off idle — i.e. when hooks are not running.
 */
const CODEX_WORKING_FALLBACK_MS = 2_000

function clearCodexPendingStart(sessionId: string): void {
  const pending = codexPendingStarts.get(sessionId)
  if (pending?.fallbackTimer) clearTimeout(pending.fallbackTimer)
  if (pending?.settleTimer) clearTimeout(pending.settleTimer)
  codexPendingStarts.delete(sessionId)
}

/** A title arrived: the channel works, so the silent-channel fallback is no longer needed. */
function noteCodexTitleSeen(sessionId: string): void {
  const pending = codexPendingStarts.get(sessionId)
  if (!pending || pending.sawTitle) return
  pending.sawTitle = true
  if (pending.fallbackTimer) clearTimeout(pending.fallbackTimer)
  pending.fallbackTimer = null
}

function armCodexReadySettle(sessionId: string): void {
  const pending = codexPendingStarts.get(sessionId)
  if (!pending) return
  if (pending.settleTimer) clearTimeout(pending.settleTimer)
  pending.settleTimer = setTimeout(() => {
    const current = codexPendingStarts.get(sessionId)
    if (current) current.settleTimer = null
    runCodexPendingStart(sessionId, 'title_ready')
  }, CODEX_READY_SETTLE_MS)
}

function cancelCodexReadySettle(sessionId: string): void {
  const pending = codexPendingStarts.get(sessionId)
  if (!pending?.settleTimer) return
  clearTimeout(pending.settleTimer)
  pending.settleTimer = null
}

/**
 * Deliver what a fresh codex spawn withheld from argv: switch into Plan mode
 * when the session is a plan session, then paste the prompt (if any) as a
 * bracketed paste + Enter, re-asserting Enter across the boot window.
 */
function runCodexPendingStart(sessionId: string, reason: string): void {
  const pending = codexPendingStarts.get(sessionId)
  if (!pending) return
  clearCodexPendingStart(sessionId)
  if (!ptyService.has(sessionId)) return
  log.info('Codex CLI ready; delivering pending start', {
    sessionId,
    reason,
    planMode: pending.planMode,
    hasPrompt: !!pending.prompt
  })
  if (pending.planMode) {
    ptyService.write(sessionId, CODEX_MODE_TOGGLE_KEY)
  }
  const prompt = pending.prompt
  if (!prompt) return
  const deliver = (): void => {
    if (!ptyService.has(sessionId)) return
    const { delivered } = writeClaudeCliPrompt(sessionId, prompt)
    if (delivered) {
      rememberPromptDelivery(sessionId, prompt)
      reassertClaudeCliPromptSubmit(sessionId)
    }
  }
  if (pending.planMode) {
    setTimeout(deliver, CODEX_MODE_TOGGLE_SETTLE_MS)
  } else {
    deliver()
  }
}

function persistCodexThreadId(sessionId: string, threadId: string, source: string): boolean {
  try {
    const db = getDatabase()
    const settled = db.getSession(sessionId)?.claude_session_id ?? null
    if (settled && !settled.startsWith('pending::')) return true
    const claimedBy = db.getSessionByClaudeSessionId(threadId)
    if (claimedBy && claimedBy.id !== sessionId) {
      log.warn('Discovered codex thread id already claimed by another session', {
        sessionId,
        threadId,
        claimedBySessionId: claimedBy.id
      })
      return false
    }
    db.updateSession(sessionId, { claude_session_id: threadId })
    log.info('Persisted Codex CLI thread id', { sessionId, threadId, source })
    void import('../desktop/backend-event-publisher')
      .then(({ publishDesktopBackendEvent }) =>
        publishDesktopBackendEvent(`terminal:claude-session-id:${sessionId}`, threadId)
      )
      .catch(() => undefined)
    return true
  } catch (error) {
    log.warn('Failed to persist Codex CLI thread id', {
      sessionId,
      threadId,
      error: error instanceof Error ? error.message : String(error)
    })
    return false
  }
}

/** React to one codex terminal title (`Ready | <thread-id> | <thread title>`). */
function handleCodexTitle(sessionId: string, rawTitle: string): void {
  const info = parseCodexTerminalTitle(rawTitle)

  noteCodexTitleSeen(sessionId)
  if (info.runState) {
    const previous = codexRunState.get(sessionId) ?? null
    codexRunState.set(sessionId, info.runState)
    if (info.runState === 'Ready') {
      armCodexReadySettle(sessionId)
      // A turn that ended without a Stop hook (an API error, hooks not
      // running) still flips the title back to Ready: mirror it so the
      // session does not sit on 'working' forever. Normal turns already
      // published 'completed' from the Stop hook (dedup makes this a no-op).
      if (previous && previous !== 'Ready' && previous !== 'Starting') {
        const last = getLastClaudeCliStatus(sessionId)
        if (last === 'working' || last === 'planning') {
          clearClaudeCliInteractions(sessionId)
          publishClaudeCliStatus({
            sessionId,
            status: 'completed',
            metadata: { reason: 'codex_title_ready' }
          })
        }
      }
    } else {
      cancelCodexReadySettle(sessionId)
    }
    if (info.runState !== 'Ready' && info.runState !== 'Starting') {
      if (!codexWorkingFallbackTimers.has(sessionId)) {
        codexWorkingFallbackTimers.set(
          sessionId,
          setTimeout(() => {
            codexWorkingFallbackTimers.delete(sessionId)
            if (!codexCliSessions.has(sessionId)) return
            const last = getLastClaudeCliStatus(sessionId)
            if (last === undefined || last === 'completed' || last === 'unread') {
              publishClaudeCliStatus({
                sessionId,
                status: 'working',
                metadata: { reason: 'codex_title_working' }
              })
            }
          }, CODEX_WORKING_FALLBACK_MS)
        )
      }
    }
  }

  if (info.threadIdPrefix && codexResolvedPrefixes.get(sessionId) !== info.threadIdPrefix) {
    codexResolvedPrefixes.set(sessionId, info.threadIdPrefix)
    let stored: string | null = null
    try {
      stored = getDatabase().getSession(sessionId)?.claude_session_id ?? null
    } catch {
      stored = null
    }
    if (!stored || stored.startsWith('pending::')) {
      const resolved = info.threadIdIsComplete
        ? { threadId: info.threadIdPrefix }
        : findCodexRolloutByIdPrefix(info.threadIdPrefix)
      if (resolved && persistCodexThreadId(sessionId, resolved.threadId, 'terminal_title')) {
        codexWatchers.get(sessionId)?.close()
        codexWatchers.delete(sessionId)
      }
    }
  }

  if (
    info.threadTitle &&
    info.runState === 'Ready' &&
    !codexThreadTitleApplied.has(sessionId) &&
    !isInterimCodexThreadTitle(sessionId, info.threadTitle)
  ) {
    codexThreadTitleApplied.add(sessionId)
    applyClaudeCliTitle({ sessionId, title: info.threadTitle, db: getDatabase() }).catch(() => {
      // applyClaudeCliTitle logs and swallows internally.
    })
  }
}

function resetCodexSessionState(sessionId: string): void {
  clearCodexPendingStart(sessionId)
  const workingTimer = codexWorkingFallbackTimers.get(sessionId)
  if (workingTimer) clearTimeout(workingTimer)
  codexWorkingFallbackTimers.delete(sessionId)
  codexWatchers.get(sessionId)?.close()
  codexWatchers.delete(sessionId)
  codexCliSessions.delete(sessionId)
  codexRunState.delete(sessionId)
  codexThreadTitleApplied.delete(sessionId)
  codexResolvedPrefixes.delete(sessionId)
  codexLastPrompt.delete(sessionId)
  closeCodexTurnWatcher(sessionId)
  recentPromptDeliveries.delete(sessionId)
  resetCodexTitleState(sessionId)
  resetCodexCliModelTracking(sessionId)
}

/** Whether a live CLI session is the codex TUI (for callers choosing keystroke semantics). */
export function isCodexCliTerminal(sessionId: string): boolean {
  return codexCliSessions.has(sessionId)
}

function closeClaudePlanFollowupWatcher(sessionId: string): void {
  claudePlanFollowupWatchers.get(sessionId)?.close()
  claudePlanFollowupWatchers.delete(sessionId)
}

function armClaudePlanFollowupWatcher(sessionId: string): void {
  const source = claudeCliTranscriptSources.get(sessionId)
  if (!source?.claudeSessionId) return

  closeClaudePlanFollowupWatcher(sessionId)
  claudePlanFollowupWatchers.set(
    sessionId,
    watchForClaudePlanFollowup(source.worktreePath, source.claudeSessionId, () => {
      closeClaudePlanFollowupWatcher(sessionId)
      // Bypasses the interaction ledger deliberately: a plan followup implies a
      // user prompt, whose UserPromptSubmit hook clears the ledger anyway.
      publishClaudeCliStatus({
        sessionId,
        status: 'planning',
        metadata: { reason: 'claude_cli_plan_followup' }
      })
    })
  )
}

function ensureClaudeCliStatusSubscription(): void {
  if (unsubscribeClaudeCliStatus) return

  unsubscribeClaudeCliStatus = subscribeClaudeCliStatus((payload) => {
    if (!claudeCliSessions.has(payload.sessionId)) return

    claudeCliLastStatus.set(payload.sessionId, payload)
    if (payload.status === 'plan_ready') {
      armClaudePlanFollowupWatcher(payload.sessionId)
      return
    }

    if (
      payload.status === 'working' &&
      payload.metadata?.hookEventName === 'PostToolUse' &&
      payload.metadata.toolName === 'ExitPlanMode'
    ) {
      closeClaudePlanFollowupWatcher(payload.sessionId)
      return
    }

    if (
      payload.status === 'planning' &&
      payload.metadata?.hookEventName === 'PostToolUseFailure' &&
      payload.metadata.toolName === 'ExitPlanMode'
    ) {
      closeClaudePlanFollowupWatcher(payload.sessionId)
    }
  })
}

// Lone Escape / Ctrl+C. A bare Escape keypress arrives as exactly '\x1b';
// multi-byte sequences (arrow keys, bracketed pastes) never match exactly.
const INTERRUPT_KEYS = new Set(['\x1b', '\x03'])
const INTERRUPTIBLE_STATUSES = new Set(['working', 'planning', 'permission', 'answering'])

/**
 * Claude Code never fires its Stop hook when the user interrupts a running
 * turn with Escape/Ctrl+C, and the CLI keeps running so the pty_exit fallback
 * never fires either — the session would stay stuck on 'working'. Mirror the
 * keypress itself into a status update instead. Escaping a question or
 * permission dialog fires no hook at all (verified empirically), so those
 * statuses are interruptible too; plan_ready is excluded because rejecting a
 * plan fires PostToolUseFailure(ExitPlanMode), which the pipeline handles.
 */
export function handleClaudeCliTerminalInput(terminalId: string, data: string): void {
  if (!claudeCliSessions.has(terminalId)) return
  if (!INTERRUPT_KEYS.has(data)) return
  const last = getLastClaudeCliStatus(terminalId)
  if (!last || !INTERRUPTIBLE_STATUSES.has(last)) return
  // No hook fires for an interrupted/denied interaction — drop any pending
  // latch so the next hook cannot re-surface a phantom permission.
  clearClaudeCliInteractions(terminalId)
  clearClaudeCliSubagentTracking(terminalId)
  publishClaudeCliStatus({
    sessionId: terminalId,
    status: 'completed',
    metadata: { reason: 'user_interrupt' }
  })
}

export function destroyNodePtyTerminal(terminalId: string): void {
  const cleanup = listenerCleanups.get(terminalId)
  if (cleanup) {
    cleanup.removeData()
    cleanup.removeExit()
    listenerCleanups.delete(terminalId)
  }
  dataBuffers.delete(terminalId)
  flushScheduled.delete(terminalId)
  claudeWatchers.get(terminalId)?.close()
  claudeWatchers.delete(terminalId)
  closeClaudePlanFollowupWatcher(terminalId)
  clearClaudeCliInteractions(terminalId)
  clearClaudeCliSubagentTracking(terminalId)
  resetClaudeCliBackgroundWork(terminalId)
  claudeCliSessions.delete(terminalId)
  claudeCliWorktreeBasenames.delete(terminalId)
  claudeCliTranscriptSources.delete(terminalId)
  claudeCliLastStatus.delete(terminalId)
  resetClaudeCliTitleState(terminalId)
  resetClaudeCliModelWatcher(terminalId)
  resetCodexSessionState(terminalId)
  ptyService.destroy(terminalId)
}

function attachNodePtyListeners(terminalId: string): void {
  const existing = listenerCleanups.get(terminalId)
  if (existing) {
    existing.removeData()
    existing.removeExit()
    listenerCleanups.delete(terminalId)
  }

  const removeData = ptyService.onData(terminalId, (data) => {
    const existing = dataBuffers.get(terminalId)
    dataBuffers.set(terminalId, existing ? existing + data : data)

    if (codexCliSessions.has(terminalId)) {
      // Codex titles are Hive-configured status lines (run-state, thread id,
      // thread title), not a conversation summary — parsed by the codex handler.
      for (const title of extractCodexTitles(terminalId, data)) {
        handleCodexTitle(terminalId, title)
      }
    } else if (claudeCliSessions.has(terminalId)) {
      const title = processClaudeCliPtyData(terminalId, data, {
        worktreeBasename: claudeCliWorktreeBasenames.get(terminalId)
      })
      if (title) {
        applyClaudeCliTitle({
          sessionId: terminalId,
          title,
          db: getDatabase()
        }).catch(() => {
          // applyClaudeCliTitle logs and swallows internally.
        })
      }
    }

    if (!flushScheduled.has(terminalId)) {
      flushScheduled.add(terminalId)
      setImmediate(() => {
        flushScheduled.delete(terminalId)
        const buffered = dataBuffers.get(terminalId)
        dataBuffers.delete(terminalId)
        if (buffered) {
          void import('../desktop/backend-event-publisher')
            .then(({ publishDesktopBackendEvent }) =>
              publishDesktopBackendEvent(`terminal:data:${terminalId}`, buffered)
            )
            .catch(() => undefined)
        }
      })
    }
  })

  const removeExit = ptyService.onExit(terminalId, (code) => {
    void import('../desktop/backend-event-publisher')
      .then(({ publishDesktopBackendEvent }) =>
        publishDesktopBackendEvent(`terminal:exit:${terminalId}`, code)
      )
      .catch(() => undefined)
    listenerCleanups.delete(terminalId)
    dataBuffers.delete(terminalId)
    flushScheduled.delete(terminalId)
    claudeWatchers.get(terminalId)?.close()
    claudeWatchers.delete(terminalId)
    closeClaudePlanFollowupWatcher(terminalId)
    if (claudeCliSessions.has(terminalId)) {
      clearClaudeCliInteractions(terminalId)
      clearClaudeCliSubagentTracking(terminalId)
      // The CLI process just died, taking its background shells/monitors with
      // it (survivors are orphans reported only to a future session).
      resetClaudeCliBackgroundWork(terminalId)
      setClaudeCliPlanAutoApprove(terminalId, false)
      publishClaudeCliStatus({
        sessionId: terminalId,
        status: 'completed',
        metadata: { reason: 'pty_exit' }
      })
      claudeCliSessions.delete(terminalId)
    }
    claudeCliWorktreeBasenames.delete(terminalId)
    claudeCliTranscriptSources.delete(terminalId)
    claudeCliLastStatus.delete(terminalId)
    resetClaudeCliTitleState(terminalId)
    resetClaudeCliModelWatcher(terminalId)
    resetCodexSessionState(terminalId)
  })

  listenerCleanups.set(terminalId, { removeData, removeExit })
}

export async function createClaudeCliTerminal(
  sessionId: string,
  opts?: { pendingPrompt?: string | null }
): Promise<{ success: boolean; cols?: number; rows?: number; error?: string }> {
  let pendingPrompt = opts?.pendingPrompt ?? null
  log.info('RPC: terminalOps.createClaudeCli', { sessionId, hasPrompt: !!pendingPrompt })
  try {
    const db = getDatabase()
    const session = db.getSession(sessionId)
    if (!session) {
      return { success: false, error: 'Session not found' }
    }
    if (!isAgentCli(session.agent_sdk)) {
      return { success: false, error: 'Session is not a CLI session' }
    }
    const codex = isCodexCli(session.agent_sdk)
    const cliName = getAgentSdkDisplayName(session.agent_sdk)

    let worktreePath: string | null = null
    if (session.worktree_id) {
      worktreePath = db.getWorktree(session.worktree_id)?.path ?? null
    } else if (session.connection_id) {
      worktreePath = db.getConnection(session.connection_id)?.path ?? null
    }
    if (!worktreePath) {
      return { success: false, error: 'Could not resolve session working directory' }
    }

    // Oversized claude-cli goal-mode handoffs are rejected (>~4k chars). Externalize the
    // plan to PLAN_{uuid}.md in the worktree and send a short reference instead. Runs before
    // both delivery paths below (spawn args and paste injection). Codex's /goal takes the
    // same shape of prompt through its composer, so the same externalization applies.
    if (pendingPrompt) {
      pendingPrompt = externalizeGoalHandoffPlan(pendingPrompt, worktreePath)
    }

    // Custom-provider sessions run a user-configured command (possibly a shell
    // alias) through the login shell instead of the resolved claude binary, so
    // PATH resolution and version logging don't apply to them. A deleted or
    // blanked provider degrades to plain claude (matching the renderer launch
    // paths) rather than permanently bricking the session's resumable
    // transcript behind a hard error. Custom providers are a claude-only
    // concept; a codex-cli row never carries one.
    let customProviderCommand: string | null = null
    let customProviderModels: CustomProviderModel[] | null = null
    if (!codex && session.custom_provider_id) {
      // The wrapper spawns through a POSIX login shell ($SHELL -ilc) — Windows
      // GUI apps have no SHELL and no /bin/zsh, so fail with a clear message
      // instead of a broken spawn (and never silently switch to stock claude).
      if (process.platform === 'win32') {
        return {
          success: false,
          error: 'Custom providers are not supported on Windows yet'
        }
      }
      const provider = getCustomProviderById(db, session.custom_provider_id)
      if (provider?.command.trim()) {
        customProviderCommand = provider.command
        customProviderModels = provider.models ?? null
      } else {
        log.warn('Custom provider missing or blank; falling back to plain claude', {
          sessionId,
          customProviderId: session.custom_provider_id
        })
      }
    }

    let claudeBinary: string | null = null
    let codexBinary: string | null = null
    if (codex) {
      codexBinary = resolveCodexBinaryPath()
      if (!codexBinary) {
        return { success: false, error: 'Codex binary not found on PATH' }
      }
    } else if (!customProviderCommand) {
      claudeBinary = resolveClaudeBinaryPath()
      if (!claudeBinary) {
        return { success: false, error: 'Claude binary not found on PATH' }
      }
      logClaudeBinaryVersion(claudeBinary)
    }

    const alreadyExists = ptyService.has(sessionId)
    if (!codex) {
      // The claude CLI stalls a fresh spawn on its folder-trust dialog (which
      // would swallow an argv prompt behind an interactive question), so make
      // sure the project root is trusted in ~/.claude.json before the PTY starts.
      // One config check per project — afterwards this is a single DB read.
      // Codex gets its trust as a `-c projects=…` override in the spawn args.
      await ensureProjectTrustCheck(db, session.project_id)
    }
    const { port } = await getClaudeHookServer()
    ensureClaudeCliStatusSubscription()

    let spawn: { command: string; args: string[]; cwd: string; env: Record<string, string> }
    let codexPromptViaPty: string | null = null
    if (codex) {
      const projectPath = db.getProject(session.project_id)?.path ?? null
      const hookOverrides = buildCodexCliHookOverrides(port, sessionId)
      const codexSpawn = buildCodexCliPtySpawn({
        session,
        worktreePath,
        projectPath,
        pendingPrompt,
        codexBinary,
        hookOverrideArgs: [...hookOverrides.args, '-c', buildCodexTerminalTitleOverride()],
        db
      })
      spawn = codexSpawn
      codexPromptViaPty = codexSpawn.promptViaPty
    } else {
      const hookSettingsJson = buildClaudeCliHookSettings(port, sessionId)
      spawn = buildClaudeCliPtySpawn({
        session,
        worktreePath,
        pendingPrompt,
        claudeBinary,
        hookSettingsJson,
        db,
        customProviderCommand,
        customProviderModels
      })
    }

    log.info(`Creating ${cliName} PTY`, {
      sessionId,
      command: spawn.command,
      args: spawn.args.map((arg, index) => {
        if (index === spawn.args.length - 1 && pendingPrompt && !codexPromptViaPty) return '<prompt>'
        // The custom command may embed inline secrets (ANTHROPIC_AUTH_TOKEN=…)
        // — never write it to the log verbatim. The wrapper puts the shell
        // script at index 1 and (for POSIX shells) argv0 at index 2; fish has
        // no argv0 slot, so index 2 is a Hive flag there (always '--'-prefixed).
        if (customProviderCommand && index === 1) return '<custom-provider-command>'
        if (customProviderCommand && index === 2 && !arg.startsWith('--')) {
          return '<custom-provider-argv0>'
        }
        // Hook overrides embed the per-session hook URLs many times over;
        // one marker keeps the log line readable.
        if (codex && arg.startsWith('hooks.')) return `hooks.${arg.slice(6).split('=')[0]}=<…>`
        return arg
      })
    })

    if (!session.claude_session_id) {
      if (codex) {
        codexWatchers.get(sessionId)?.close()
        codexWatchers.set(
          sessionId,
          watchForCodexSessionId(worktreePath, (threadId) => {
            const accepted = persistCodexThreadId(sessionId, threadId, 'rollout_watcher')
            if (accepted) codexWatchers.delete(sessionId)
            return accepted
          })
        )
      } else {
        claudeWatchers.get(sessionId)?.close()
        claudeWatchers.set(
          sessionId,
          watchForClaudeSessionId(worktreePath, (claudeSessionId) => {
            // A hook payload may have settled the id meanwhile (the hook server's
            // captureClaudeCliSessionId): that one is authoritative — the CLI
            // named it — so the heuristic must not overwrite it with whatever
            // transcript appeared newest in the worktree.
            try {
              const settled = db.getSession(sessionId)?.claude_session_id ?? null
              if (settled && !settled.startsWith('pending::')) {
                if (settled !== claudeSessionId) {
                  log.info(
                    'Claude session id already settled by a hook; ignoring the newest transcript',
                    {
                      sessionId,
                      claudeSessionId,
                      settled
                    }
                  )
                }
                claudeCliTranscriptSources.set(sessionId, { worktreePath, claudeSessionId: settled })
                claudeWatchers.delete(sessionId)
                return true
              }
            } catch (error) {
              log.warn('Failed to re-read the Claude session id', {
                sessionId,
                error: error instanceof Error ? error.message : String(error)
              })
            }
            // The newest-jsonl heuristic can match a transcript created by a
            // concurrent spawn in the same worktree. A claude session id belongs
            // to exactly one Hive session — reject an already-claimed id (the
            // watcher keeps looking) instead of cross-stamping both sessions
            // into resuming the same transcript.
            try {
              const claimedBy = db.getSessionByClaudeSessionId(claudeSessionId)
              if (claimedBy && claimedBy.id !== sessionId) {
                log.warn('Discovered Claude session id already claimed by another session', {
                  sessionId,
                  claudeSessionId,
                  claimedBySessionId: claimedBy.id
                })
                return false
              }
            } catch (error) {
              log.warn('Failed to check Claude session id claim', {
                sessionId,
                error: error instanceof Error ? error.message : String(error)
              })
            }
            try {
              db.updateSession(sessionId, { claude_session_id: claudeSessionId })
            } catch (error) {
              log.warn('Failed to persist Claude CLI session id', {
                sessionId,
                error: error instanceof Error ? error.message : String(error)
              })
            }
            void import('../desktop/backend-event-publisher')
              .then(({ publishDesktopBackendEvent }) =>
                publishDesktopBackendEvent(`terminal:claude-session-id:${sessionId}`, claudeSessionId)
              )
              .catch(() => undefined)
            claudeCliTranscriptSources.set(sessionId, { worktreePath, claudeSessionId })
            if (claudeCliLastStatus.get(sessionId)?.status === 'plan_ready') {
              armClaudePlanFollowupWatcher(sessionId)
            }
            claudeWatchers.delete(sessionId)
            return true
          })
        )
      }
    }
    claudeCliTranscriptSources.set(sessionId, {
      worktreePath,
      claudeSessionId: session.claude_session_id
    })

    const { cols, rows } = ptyService.create(sessionId, {
      cwd: spawn.cwd,
      command: spawn.command,
      args: spawn.args,
      env: spawn.env
    })
    if (alreadyExists && pendingPrompt && wasPromptJustDelivered(sessionId, pendingPrompt)) {
      // The launch path and the mounting session view both carry the same
      // prompt; the earlier call already put it on argv (or pasted it). A
      // second paste would submit the prompt twice.
      log.info(`${cliName} PTY already exists; pending prompt was just delivered, not re-pasting`, {
        sessionId
      })
    } else if (alreadyExists && pendingPrompt) {
      // ptyService.create reused the live PTY, so the spawn args (and the
      // prompt riding on them) never reached the CLI. Inject it as a paste so
      // a racing promptless create call can't strand the prompt. (For codex
      // the running TUI is already in its mode; a paste is exactly right.)
      const { delivered } = writeClaudeCliPrompt(sessionId, pendingPrompt)
      if (delivered) {
        rememberPromptDelivery(sessionId, pendingPrompt)
        // The paste can land before the TUI is input-ready, which buffers
        // the text but drops the submitting CR — leaving the prompt sitting
        // unsent. Re-assert Enter across the boot window so it actually submits.
        reassertClaudeCliPromptSubmit(sessionId)
      }
      log.info(`${cliName} PTY already exists; injecting pending prompt`, {
        sessionId,
        delivered
      })
    } else if (!alreadyExists && pendingPrompt && !codexPromptViaPty) {
      // The prompt rides on argv of the fresh spawn.
      rememberPromptDelivery(sessionId, pendingPrompt)
    }
    if (codex && !alreadyExists) {
      // Fresh codex spawn: the TUI boots in Default mode and would submit an
      // argv prompt before any keystroke, so plan sessions (Shift+Tab into
      // Plan) and slash-command prompts wait for the title channel's Ready.
      const planMode = session.mode === 'plan' || session.mode === 'super-plan'
      if (planMode || codexPromptViaPty) {
        clearCodexPendingStart(sessionId)
        codexPendingStarts.set(sessionId, {
          prompt: codexPromptViaPty,
          planMode,
          fallbackTimer: setTimeout(() => {
            runCodexPendingStart(sessionId, 'ready_timeout')
          }, CODEX_READY_FALLBACK_MS),
          settleTimer: null,
          sawTitle: false
        })
      }
    }
    claudeCliSessions.add(sessionId)
    if (codex) {
      codexCliSessions.add(sessionId)
      if (!alreadyExists) codexRunState.set(sessionId, null)
      ensureCodexHookSubscription()
    }
    // A restarted session must never inherit a stale interaction latch.
    clearClaudeCliInteractions(sessionId)
    // ...nor a stale subagent deferral/pending-notification set, which could
    // otherwise swallow the next turn's Stop after a restart.
    clearClaudeCliSubagentTracking(sessionId)
    // ...nor a dead previous process's background shell/monitor counts. Only
    // on a true (re)spawn: when the live PTY was reused above, its CLI
    // process — and its background tasks — are still running, and the
    // Stop-snapshot reconciliation only prunes tracked ids (it never adopts),
    // so a reset here could not self-heal until those tasks ended.
    if (!alreadyExists) {
      resetClaudeCliBackgroundWork(sessionId)
    }
    claudeCliWorktreeBasenames.set(sessionId, path.basename(worktreePath))
    if (!pendingPrompt) {
      publishClaudeCliStatus({
        sessionId,
        status: 'completed',
        metadata: { reason: 'pty_start' }
      })
    }

    if (!alreadyExists) {
      attachNodePtyListeners(sessionId)
    }

    return { success: true, cols, rows }
  } catch (error) {
    log.error(
      'RPC: terminalOps.createClaudeCli failed',
      error instanceof Error ? error : new Error(String(error)),
      { sessionId }
    )
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error'
    }
  }
}

export function cleanupTerminals(): Promise<void> {
  log.info('Cleaning up all terminals')
  for (const [, cleanup] of listenerCleanups) {
    cleanup.removeData()
    cleanup.removeExit()
  }
  listenerCleanups.clear()
  dataBuffers.clear()
  flushScheduled.clear()
  for (const [, watcher] of claudeWatchers) {
    watcher.close()
  }
  claudeWatchers.clear()
  for (const [, watcher] of claudePlanFollowupWatchers) {
    watcher.close()
  }
  claudePlanFollowupWatchers.clear()
  claudeCliSessions.clear()
  claudeCliWorktreeBasenames.clear()
  claudeCliTranscriptSources.clear()
  claudeCliLastStatus.clear()
  clearAllClaudeCliInteractions()
  clearAllClaudeCliSubagentTracking()
  clearAllClaudeCliBackgroundWork()
  resetAllClaudeCliModelWatchers()
  for (const sessionId of [...codexCliSessions]) resetCodexSessionState(sessionId)
  for (const [, watcher] of codexWatchers) watcher.close()
  codexWatchers.clear()
  for (const [, watcher] of codexTurnWatchers) watcher.close()
  codexTurnWatchers.clear()
  recentPromptDeliveries.clear()
  codexPendingStarts.clear()
  codexCliSessions.clear()
  codexLastPrompt.clear()
  unsubscribeCodexHookEvents?.()
  unsubscribeCodexHookEvents = null
  resetAllCodexTitleState()
  resetAllCodexCliModelTracking()
  unsubscribeClaudeCliStatus?.()
  unsubscribeClaudeCliStatus = null
  resetAllClaudeCliTitleState()
  // HUP + bounded-grace SIGKILL sweep: awaited by the quit chain so
  // HUP-surviving agents are reaped before the process exits.
  const reaped = ptyService.destroyAllAndReap()
  ghosttyService.shutdown()
  return reaped
}
