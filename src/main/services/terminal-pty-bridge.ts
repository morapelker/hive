import path from 'node:path'
import { getDatabase } from '../db'
import {
  buildClaudeCliHookSettings,
  getClaudeHookServer,
  getLastClaudeCliStatus,
  publishClaudeCliStatus,
  subscribeClaudeCliStatus,
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
import { setClaudeCliPlanAutoApprove } from './claude-cli-plan-auto-approve'
import { logClaudeBinaryVersion, resolveClaudeBinaryPath } from './claude-binary-resolver'
import { buildClaudeCliPtySpawn, type ClaudeCliPtySpawn } from './claude-cli-spawner'
import { buildCodexCliPtySpawn } from './codex-cli-spawner'
import {
  buildCodexCliHookArgs,
  clearAllCodexSessionTracking,
  clearCodexSessionTracking,
  seedCodexSessionTracking,
  setCodexSessionIdSink
} from './codex-cli-hooks'
import { resolveCodexBinaryPath } from './codex-binary-resolver'
import { isCliAgentSdk, isCodexCli } from '@shared/types/agent-sdk'
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


let codexSessionIdSinkRegistered = false

/**
 * Persist codex thread ids reported by the hook translation layer (the codex
 * analog of watchForClaudeSessionId — the id arrives on every hook payload):
 * store on the session row (the claude_session_id column holds the CLI-native
 * session id for every CLI provider) and notify the renderer over the same
 * channel. Unlike claude, the id is refreshed on change so `/clear` (which
 * starts a new codex thread) keeps resume pointing at the live thread.
 */
function ensureCodexSessionIdSink(): void {
  if (codexSessionIdSinkRegistered) return
  codexSessionIdSinkRegistered = true

  setCodexSessionIdSink((sessionId, codexThreadId) => {
    try {
      const db = getDatabase()
      if (db.getSession(sessionId)?.claude_session_id !== codexThreadId) {
        db.updateSession(sessionId, { claude_session_id: codexThreadId })
      }
    } catch (error) {
      log.warn('Failed to persist Codex CLI thread id', {
        sessionId,
        error: error instanceof Error ? error.message : String(error)
      })
    }
    void import('../desktop/backend-event-publisher')
      .then(({ publishDesktopBackendEvent }) =>
        publishDesktopBackendEvent(`terminal:claude-session-id:${sessionId}`, codexThreadId)
      )
      .catch(() => undefined)
  })
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
  clearCodexSessionTracking(terminalId)
  claudeCliSessions.delete(terminalId)
  claudeCliWorktreeBasenames.delete(terminalId)
  claudeCliTranscriptSources.delete(terminalId)
  claudeCliLastStatus.delete(terminalId)
  resetClaudeCliTitleState(terminalId)
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

    if (claudeCliSessions.has(terminalId)) {
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
      clearCodexSessionTracking(terminalId)
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
    if (!isCliAgentSdk(session.agent_sdk)) {
      return { success: false, error: 'Session is not a CLI agent session' }
    }
    const isCodex = isCodexCli(session.agent_sdk)

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
    // both delivery paths below (spawn args and paste injection).
    if (pendingPrompt) {
      pendingPrompt = externalizeGoalHandoffPlan(pendingPrompt, worktreePath)
    }

    const alreadyExists = ptyService.has(sessionId)
    const { port } = await getClaudeHookServer()
    ensureClaudeCliStatusSubscription()

    let spawn: ClaudeCliPtySpawn
    if (isCodex) {
      const codexBinary = resolveCodexBinaryPath()
      if (!codexBinary) {
        return { success: false, error: 'Codex binary not found on PATH' }
      }
      // Thread ids arrive on hook payloads (via the sink); hooks themselves
      // ride the spawn args as -c overrides — nothing global is written.
      ensureCodexSessionIdSink()
      seedCodexSessionTracking(sessionId, session.claude_session_id)
      // Plan mode is a PROMPT convention for codex-cli (CODEX_PLAN_MODE_PREFIX
      // asks for a `<proposed_plan>` block and forbids mutation) — codex stays
      // in its Default collaboration mode, so the plan prompt is delivered as a
      // normal auto-submitting arg exactly like build mode. We deliberately do
      // NOT flip codex into its native Plan collaboration mode: that mode shows
      // codex's own interactive "Implement this plan?" popup, which is the
      // claude-style plan dialog we want to avoid (see codex-cli-hooks.ts).
      spawn = buildCodexCliPtySpawn({
        session,
        worktreePath,
        pendingPrompt,
        codexBinary,
        hookArgs: buildCodexCliHookArgs(port, sessionId),
        db
      })
    } else {
      const claudeBinary = resolveClaudeBinaryPath()
      if (!claudeBinary) {
        return { success: false, error: 'Claude binary not found on PATH' }
      }
      logClaudeBinaryVersion(claudeBinary)
      const hookSettingsJson = buildClaudeCliHookSettings(port, sessionId)
      spawn = buildClaudeCliPtySpawn({
        session,
        worktreePath,
        pendingPrompt,
        claudeBinary,
        hookSettingsJson,
        db
      })
    }

    log.info('Creating Claude CLI PTY', {
      sessionId,
      command: spawn.command,
      args: spawn.args.map((arg, index) =>
        index === spawn.args.length - 1 && pendingPrompt ? '<prompt>' : arg
      )
    })

    // Codex thread ids arrive on hook payloads (via the sink registered
    // above); the filesystem watcher below is claude-transcript-specific.
    if (!session.claude_session_id && !isCodex) {
      claudeWatchers.get(sessionId)?.close()
      claudeWatchers.set(
        sessionId,
        watchForClaudeSessionId(worktreePath, (claudeSessionId) => {
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
        })
      )
    }
    if (!isCodex) {
      // Feeds the plan-followup watcher, which reads claude transcript files;
      // codex plan followups arrive through hooks instead (UserPromptSubmit in
      // plan mode → planning), so codex sessions never register a source.
      claudeCliTranscriptSources.set(sessionId, {
        worktreePath,
        claudeSessionId: session.claude_session_id
      })
    }

    const { cols, rows } = ptyService.create(sessionId, {
      cwd: spawn.cwd,
      command: spawn.command,
      args: spawn.args,
      env: spawn.env
    })
    if (alreadyExists && pendingPrompt) {
      // ptyService.create reused the live PTY, so the spawn args (and the
      // prompt riding on them) never reached the CLI. Inject it as a paste so
      // a racing promptless create call can't strand the prompt. (codex-cli
      // plan prompts carry their instruction inline and need no mode toggle,
      // so this path is identical for both CLIs.)
      const { delivered } = writeClaudeCliPrompt(sessionId, pendingPrompt)
      if (delivered) {
        // The paste can land before the TUI is input-ready, which buffers
        // the text but drops the submitting CR — leaving the prompt sitting
        // unsent. Re-assert Enter across the boot window so it actually submits.
        reassertClaudeCliPromptSubmit(sessionId)
      }
      log.info('Claude CLI PTY already exists; injecting pending prompt', {
        sessionId,
        delivered
      })
    }
    claudeCliSessions.add(sessionId)
    // A restarted session must never inherit a stale interaction latch.
    clearClaudeCliInteractions(sessionId)
    // ...nor a stale subagent deferral/pending-notification set, which could
    // otherwise swallow the next turn's Stop after a restart.
    clearClaudeCliSubagentTracking(sessionId)
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

export function cleanupTerminals(): void {
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
  clearAllCodexSessionTracking()
  unsubscribeClaudeCliStatus?.()
  unsubscribeClaudeCliStatus = null
  resetAllClaudeCliTitleState()
  ptyService.destroyAll()
  ghosttyService.shutdown()
}
