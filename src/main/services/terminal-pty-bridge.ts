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
import { logGrokBinaryVersion, resolveGrokBinaryPath } from './grok-binary-resolver'
import { buildGrokCliPtySpawn } from './grok-cli-spawner'
import {
  buildGrokCliHookUrlBase,
  clearAllGrokSessionTracking,
  clearGrokSessionTracking,
  ensureGrokHooksInstalled,
  seedGrokSessionTracking,
  setGrokSessionIdSink,
  setGrokSessionModeProvider
} from './grok-cli-hooks'
import { isCliAgentSdk, isGrokCli } from '@shared/types/agent-sdk'
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

// Grok has no CLI flag that actually arms its plan mode (--permission-mode
// plan is a Claude-compat no-op that additionally clobbers --always-approve),
// so plan sessions are activated in the TUI: two Shift+Tab presses cycle
// always-approve → normal → plan, and the pasted first prompt flips grok's
// plan state Pending → Active.
//
// Nothing may be written before grok takes the TTY: pre-boot writes are
// echoed raw by the line discipline (the user sees `^[[Z^[[200~…` gibberish)
// and the keystrokes can be flushed. Readiness is detected from the PTY
// output itself — grok's boot renders a burst of output and then goes quiet
// once the composer is idle — with a ceiling in case output never settles.
const GROK_PLAN_BOOT_QUIET_MS = 700
const GROK_PLAN_BOOT_CEILING_MS = 10_000
const GROK_PLAN_PROMPT_AFTER_TOGGLE_MS = 300

interface GrokPlanDelivery {
  prompt: string | null
  toggles: boolean
  quietTimer: NodeJS.Timeout | null
  ceilingTimer: NodeJS.Timeout
  removeData: () => void
}

const grokPlanDeliveries = new Map<string, GrokPlanDelivery>()

function deliverGrokPlanActivation(sessionId: string): void {
  const entry = grokPlanDeliveries.get(sessionId)
  if (!entry) return
  grokPlanDeliveries.delete(sessionId)
  if (entry.quietTimer) clearTimeout(entry.quietTimer)
  clearTimeout(entry.ceilingTimer)
  entry.removeData()

  if (!ptyService.has(sessionId)) return
  if (entry.toggles) {
    ptyService.write(sessionId, '\x1b[Z\x1b[Z')
  }
  const pending = entry.prompt
  if (!pending) return
  setTimeout(
    () => {
      const { delivered } = writeClaudeCliPrompt(sessionId, pending)
      if (delivered) {
        reassertClaudeCliPromptSubmit(sessionId)
      }
    },
    entry.toggles ? GROK_PLAN_PROMPT_AFTER_TOGGLE_MS : 0
  )
}

function scheduleGrokPlanActivation(
  sessionId: string,
  prompt: string | null,
  opts: { toggles: boolean }
): void {
  const existing = grokPlanDeliveries.get(sessionId)
  if (existing) {
    // A racing prompt-carrying create call merges its prompt into the pending
    // activation instead of pasting into a still-booting TUI.
    if (prompt) existing.prompt = prompt
    return
  }

  let sawTuiOutput = false
  const entry: GrokPlanDelivery = {
    prompt,
    toggles: opts.toggles,
    quietTimer: null,
    ceilingTimer: setTimeout(() => deliverGrokPlanActivation(sessionId), GROK_PLAN_BOOT_CEILING_MS),
    removeData: ptyService.onData(sessionId, (data) => {
      // Pre-boot user keystrokes are echoed by the line discipline as plain
      // text; only escape-sequence-bearing output (title OSC, alt-screen,
      // TUI redraws) counts as evidence the TUI is up. Once seen, debounce:
      // each output chunk pushes readiness out until rendering goes quiet.
      if (!sawTuiOutput) {
        if (!data.includes('\x1b')) return
        sawTuiOutput = true
      }
      if (entry.quietTimer) clearTimeout(entry.quietTimer)
      entry.quietTimer = setTimeout(
        () => deliverGrokPlanActivation(sessionId),
        GROK_PLAN_BOOT_QUIET_MS
      )
    })
  }
  grokPlanDeliveries.set(sessionId, entry)
}

function cancelGrokPlanActivation(sessionId: string): void {
  const entry = grokPlanDeliveries.get(sessionId)
  if (entry) {
    if (entry.quietTimer) clearTimeout(entry.quietTimer)
    clearTimeout(entry.ceilingTimer)
    entry.removeData()
    grokPlanDeliveries.delete(sessionId)
  }
}

let grokSessionIdSinkRegistered = false

/**
 * Persist grok session ids reported by the hook adapter (the grok analog of
 * watchForClaudeSessionId): store on the session row (the claude_session_id
 * column holds the CLI-native session id for every CLI provider) and notify
 * the renderer over the same channel.
 */
function ensureGrokSessionIdSink(): void {
  if (grokSessionIdSinkRegistered) return
  grokSessionIdSinkRegistered = true

  setGrokSessionIdSink((sessionId, grokSessionId) => {
    try {
      const db = getDatabase()
      if (!db.getSession(sessionId)?.claude_session_id) {
        db.updateSession(sessionId, { claude_session_id: grokSessionId })
      }
    } catch (error) {
      log.warn('Failed to persist Grok CLI session id', {
        sessionId,
        error: error instanceof Error ? error.message : String(error)
      })
    }
    void import('../desktop/backend-event-publisher')
      .then(({ publishDesktopBackendEvent }) =>
        publishDesktopBackendEvent(`terminal:claude-session-id:${sessionId}`, grokSessionId)
      )
      .catch(() => undefined)
  })

  // Lets the adapter reconcile mid-session plan/build switches made in Hive
  // (setSessionMode only sends Shift+Tab keystrokes — no hook fires for them).
  setGrokSessionModeProvider((sessionId) => {
    try {
      return getDatabase().getSession(sessionId)?.mode ?? null
    } catch {
      return null
    }
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
  clearGrokSessionTracking(terminalId)
  cancelGrokPlanActivation(terminalId)
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
      clearGrokSessionTracking(terminalId)
      cancelGrokPlanActivation(terminalId)
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
    const isGrok = isGrokCli(session.agent_sdk)

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
    if (isGrok) {
      const grokBinary = resolveGrokBinaryPath()
      if (!grokBinary) {
        return { success: false, error: 'Grok binary not found on PATH' }
      }
      logGrokBinaryVersion(grokBinary)
      // Grok has no --settings flag; hooks live in a static global file that
      // relays payloads to the URL carried in this spawn's environment.
      ensureGrokHooksInstalled()
      ensureGrokSessionIdSink()
      if (!alreadyExists) {
        // Seeding replaces live tracking (lastPreToolUse pairing, tracked
        // permission mode) — a racing/repeat create call that reuses the PTY
        // must not wipe an in-flight tool/permission sequence.
        seedGrokSessionTracking(sessionId, session.claude_session_id, {
          planMode: session.mode === 'plan' || session.mode === 'super-plan',
          dbMode: session.mode
        })
      }
      spawn = buildGrokCliPtySpawn({
        session,
        worktreePath,
        // Plan-mode prompts are delivered post-boot by the activation
        // scheduler below, never as a spawn arg.
        pendingPrompt:
          session.mode === 'plan' || session.mode === 'super-plan' ? null : pendingPrompt,
        grokBinary,
        hookUrlBase: buildGrokCliHookUrlBase(port, sessionId),
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

    // Grok session ids arrive on hook payloads (via the sink registered
    // above); the filesystem watcher below is claude-transcript-specific.
    if (!session.claude_session_id && !isGrok) {
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
    if (!isGrok) {
      // Feeds the plan-followup watcher, which reads claude transcript files;
      // grok's plan followups arrive through hooks instead (UserPromptSubmit
      // in plan mode → planning), so grok sessions never register a source.
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
    const grokPlanSession = isGrok && (session.mode === 'plan' || session.mode === 'super-plan')
    if (grokPlanSession && !alreadyExists) {
      // Fresh PTY for a grok plan session: activate plan mode with Shift+Tab
      // keystrokes once the TUI boots, then paste the prompt (which flips
      // grok's plan state Pending→Active). Resumed sessions restore their
      // persisted plan state, so they only get the delayed paste.
      scheduleGrokPlanActivation(sessionId, pendingPrompt, {
        toggles: !session.claude_session_id
      })
    } else if (alreadyExists && pendingPrompt) {
      if (grokPlanSession && grokPlanDeliveries.has(sessionId)) {
        // The racing promptless call already scheduled the activation —
        // merge the prompt into it rather than pasting into a booting TUI.
        scheduleGrokPlanActivation(sessionId, pendingPrompt, { toggles: false })
        log.info('Grok plan activation pending; merged prompt into it', { sessionId })
      } else {
        // ptyService.create reused the live PTY, so the spawn args (and the
        // prompt riding on them) never reached claude. Inject it as a paste so
        // a racing promptless create call can't strand the prompt.
        const { delivered } = writeClaudeCliPrompt(sessionId, pendingPrompt)
        if (delivered) {
          // The paste can land before claude's TUI is input-ready, which buffers
          // the text but drops the submitting CR — leaving the prompt sitting
          // unsent. Re-assert Enter across the boot window so it actually submits.
          reassertClaudeCliPromptSubmit(sessionId)
        }
        log.info('Claude CLI PTY already exists; injecting pending prompt', {
          sessionId,
          delivered
        })
      }
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
  clearAllGrokSessionTracking()
  for (const sessionId of grokPlanDeliveries.keys()) {
    cancelGrokPlanActivation(sessionId)
  }
  setGrokSessionIdSink(null)
  setGrokSessionModeProvider(null)
  grokSessionIdSinkRegistered = false
  unsubscribeClaudeCliStatus?.()
  unsubscribeClaudeCliStatus = null
  resetAllClaudeCliTitleState()
  ptyService.destroyAll()
  ghosttyService.shutdown()
}
