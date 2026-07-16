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
import { getCustomProviderById } from './custom-providers'
import { logGrokBinaryVersion, resolveGrokBinaryPath } from './grok-binary-resolver'
import { buildGrokCliPtySpawn } from './grok-cli-spawner'
import {
  buildGrokCliHookUrlBase,
  clearAllGrokSessionTracking,
  clearGrokSessionTracking,
  ensureGrokHooksInstalled,
  getGrokPlanState,
  seedGrokSessionTracking,
  setGrokSessionIdSink,
  setGrokSessionModeProvider
} from './grok-cli-hooks'
import {
  GROK_PROMPT_AFTER_TOGGLE_MS,
  clearAllGrokCliTerminals,
  registerGrokCliTerminal,
  stampGrokModeToggle,
  unregisterGrokCliTerminal
} from './grok-input-pacing'
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
// once the composer is idle. The ceiling only waives the quiet-period wait
// for a TUI that never stops rendering; it never waives having SEEN TUI
// output — if grok never draws, nothing is ever written (a write could only
// echo raw or corrupt whatever eventually starts).
const GROK_PLAN_BOOT_QUIET_MS = 700
const GROK_PLAN_BOOT_CEILING_MS = 10_000

/**
 * Which direction the mode toggles move grok before the prompt is pasted:
 * 'enter-plan' cycles always-approve → normal → plan (two Shift+Tabs) to arm
 * a fresh plan session; 'exit-plan' presses once (plan → always-approve) to
 * leave a resume-restored plan session before a build prompt; null pastes
 * without touching the mode.
 */
type GrokModeToggles = 'enter-plan' | 'exit-plan' | null

const GROK_TOGGLE_KEYS: Record<Exclude<GrokModeToggles, null>, string> = {
  'enter-plan': '\x1b[Z\x1b[Z',
  'exit-plan': '\x1b[Z'
}

interface GrokPlanDelivery {
  prompt: string | null
  toggles: GrokModeToggles
  quietTimer: NodeJS.Timeout | null
  ceilingTimer: NodeJS.Timeout
  removeData: () => void
  /** True once escape-sequence-bearing PTY output proved the TUI is drawing. */
  sawTuiOutput: boolean
  /** True once the ceiling elapsed; the next TUI output delivers immediately. */
  ceilingElapsed: boolean
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
    ptyService.write(sessionId, GROK_TOGGLE_KEYS[entry.toggles])
    // A renderer prompt racing in behind these toggles must also wait out
    // the settle window (writeCliTerminalPaced reads this stamp).
    stampGrokModeToggle(sessionId)
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
    entry.toggles ? GROK_PROMPT_AFTER_TOGGLE_MS : 0
  )
}

function scheduleGrokPlanActivation(
  sessionId: string,
  prompt: string | null,
  opts: { toggles: GrokModeToggles }
): void {
  const existing = grokPlanDeliveries.get(sessionId)
  if (existing) {
    // A racing prompt-carrying create call merges its prompt into the pending
    // activation instead of pasting into a still-booting TUI.
    if (prompt) existing.prompt = prompt
    return
  }

  const entry: GrokPlanDelivery = {
    prompt,
    toggles: opts.toggles,
    quietTimer: null,
    sawTuiOutput: false,
    ceilingElapsed: false,
    ceilingTimer: setTimeout(() => {
      if (entry.sawTuiOutput) {
        // Output that never settles: stop waiting for quiet and deliver.
        deliverGrokPlanActivation(sessionId)
      } else {
        // No TUI yet — writing now would hit a bare PTY. Deliver on the
        // first real output instead (the entry is torn down with the PTY if
        // grok never comes up).
        entry.ceilingElapsed = true
      }
    }, GROK_PLAN_BOOT_CEILING_MS),
    removeData: ptyService.onData(sessionId, (data) => {
      // Pre-boot user keystrokes are echoed by the line discipline as plain
      // text; only escape-sequence-bearing output (title OSC, alt-screen,
      // TUI redraws) counts as evidence the TUI is up. Once seen, debounce:
      // each output chunk pushes readiness out until rendering goes quiet.
      if (!entry.sawTuiOutput) {
        if (!data.includes('\x1b')) return
        entry.sawTuiOutput = true
        if (entry.ceilingElapsed) {
          deliverGrokPlanActivation(sessionId)
          return
        }
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
  unregisterGrokCliTerminal(terminalId)
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
    unregisterGrokCliTerminal(terminalId)
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
    // Grok resume state, computed in the branch below (null = fresh session).
    let grokResumedPlanState: ReturnType<typeof getGrokPlanState> | null = null
    let grokBuildNeedsPlanExit = false
    let grokPromptViaPaste = false
    // Claude-only: set in the else-branch below; read by the log redaction.
    let customProviderCommand: string | null = null
    if (isGrok) {
      const grokBinary = resolveGrokBinaryPath()
      if (!grokBinary) {
        return { success: false, error: 'Grok binary not found on PATH' }
      }
      logGrokBinaryVersion(grokBinary)
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
      // Built promptless first: whether the prompt may ride as a spawn arg
      // depends on grok's persisted plan state, which is read with this
      // spawn's env (GROK_HOME can be Hive-configured).
      spawn = buildGrokCliPtySpawn({
        session,
        worktreePath,
        pendingPrompt: null,
        grokBinary,
        hookUrlBase: buildGrokCliHookUrlBase(port, sessionId),
        db
      })
      // Grok has no --settings flag; hooks live in a static file under the
      // GROK_HOME this spawn will actually run with (the user's Hive env vars
      // can point it away from ~/.grok) that relays payloads to the URL
      // carried in the spawn environment.
      ensureGrokHooksInstalled(spawn.env)

      const planLike = session.mode === 'plan' || session.mode === 'super-plan'
      grokResumedPlanState = session.claude_session_id
        ? getGrokPlanState(worktreePath, session.claude_session_id, spawn.env)
        : null
      // A build-mode resume whose grok session persisted an ACTIVE plan state
      // (the Hive mode flipped while the PTY was down, so the Shift+Tab sync
      // had nothing to write into) must toggle out of plan before the prompt,
      // via the scheduler below — never as a spawn arg that would land as
      // another planning turn.
      grokBuildNeedsPlanExit = !planLike && grokResumedPlanState === 'active'
      // A cmd.exe-wrapped shim spawn must never carry the prompt as an arg:
      // cmd interprets metacharacters (& | %VAR%) even in quoted args, which
      // both mangles ordinary prompts and lets untrusted ticket text execute
      // commands. Deliver by readiness-gated paste instead (scheduler below).
      grokPromptViaPaste = spawn.command === 'cmd.exe'
      if (!planLike && !grokBuildNeedsPlanExit && !grokPromptViaPaste && pendingPrompt?.trim()) {
        // Normal build spawn: restore the positional prompt.
        spawn.args.push(pendingPrompt.trim())
      }
    } else {
      // Custom-provider sessions run a user-configured command (possibly a shell
      // alias) through the login shell instead of the resolved claude binary, so
      // PATH resolution and version logging don't apply to them. A deleted or
      // blanked provider degrades to plain claude (matching the renderer launch
      // paths) rather than permanently bricking the session's resumable
      // transcript behind a hard error.
      if (session.custom_provider_id) {
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
        } else {
          log.warn('Custom provider missing or blank; falling back to plain claude', {
            sessionId,
            customProviderId: session.custom_provider_id
          })
        }
      }

      let claudeBinary: string | null = null
      if (!customProviderCommand) {
        claudeBinary = resolveClaudeBinaryPath()
        if (!claudeBinary) {
          return { success: false, error: 'Claude binary not found on PATH' }
        }
        logClaudeBinaryVersion(claudeBinary)
      }

      const hookSettingsJson = buildClaudeCliHookSettings(port, sessionId)
      spawn = buildClaudeCliPtySpawn({
        session,
        worktreePath,
        pendingPrompt,
        claudeBinary,
        hookSettingsJson,
        db,
        customProviderCommand
      })
    }

    log.info('Creating Claude CLI PTY', {
      sessionId,
      command: spawn.command,
      args: spawn.args.map((arg, index) => {
        if (index === spawn.args.length - 1 && pendingPrompt) return '<prompt>'
        // The custom command may embed inline secrets (ANTHROPIC_AUTH_TOKEN=…)
        // — never write it to the log verbatim. The wrapper puts the shell
        // script at index 1 and (for POSIX shells) argv0 at index 2; fish has
        // no argv0 slot, so index 2 is a Hive flag there (always '--'-prefixed).
        if (customProviderCommand && index === 1) return '<custom-provider-command>'
        if (customProviderCommand && index === 2 && !arg.startsWith('--')) {
          return '<custom-provider-argv0>'
        }
        return arg
      })
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
      // grok's plan state Pending→Active). A resume restores grok's persisted
      // plan state, so consult it: a session that is already Active must not
      // be toggled (that would cycle it OUT of plan), but one whose plan was
      // never armed — or was approved before the Hive mode flipped back to
      // plan while the PTY was down — still needs the activation. When the
      // state can't be read, err on not toggling.
      scheduleGrokPlanActivation(sessionId, pendingPrompt, {
        toggles:
          grokResumedPlanState === null || grokResumedPlanState === 'inactive' ? 'enter-plan' : null
      })
    } else if (grokBuildNeedsPlanExit && !alreadyExists) {
      // Build-mode resume of a grok session whose persisted plan state is
      // still Active: leave plan (one Shift+Tab, plan → always-approve)
      // before delivering the prompt, or it would run as a planning turn.
      scheduleGrokPlanActivation(sessionId, pendingPrompt, { toggles: 'exit-plan' })
    } else if (grokPromptViaPaste && pendingPrompt && !alreadyExists) {
      // cmd.exe-wrapped shim spawn: the prompt stayed off the command line
      // (cmd metacharacter hazard) — paste it once the TUI is ready.
      scheduleGrokPlanActivation(sessionId, pendingPrompt, { toggles: null })
    } else if (alreadyExists && pendingPrompt) {
      if (isGrok && grokPlanDeliveries.has(sessionId)) {
        // The racing promptless call already scheduled the activation —
        // merge the prompt into it rather than pasting into a booting TUI.
        scheduleGrokPlanActivation(sessionId, pendingPrompt, { toggles: null })
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
    if (isGrok) {
      registerGrokCliTerminal(sessionId)
    }
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
  clearAllGrokCliTerminals()
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
