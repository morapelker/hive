import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { homedir } from 'os'
import path from 'node:path'
import { createLogger } from './logger'
import type { ParsedClaudeHook } from './claude-hook-server'

const log = createLogger({ component: 'GrokCliHooks' })

/**
 * Grok Build CLI integration: hook installation + payload translation.
 *
 * Grok has no `--settings` flag, so per-session hook config can't ride the
 * spawn args the way claude-cli's does. Instead a single static file in
 * ~/.grok/hooks/ (global hooks are always trusted, unlike project hooks which
 * require folder trust) holds command hooks that read HIVE_GROK_HOOK_URL from
 * the grok process environment — set per spawn by buildGrokCliPtySpawn with
 * the Hive session id and hook-server port baked into the URL — and curl the
 * stdin payload to it. Sessions not spawned by Hive have the variable unset
 * and the hooks no-op with an empty `{}` reply (the same pattern cmux uses
 * for its grok integration).
 *
 * Payloads are then translated into the ParsedClaudeHook shape so the entire
 * claude-cli control plane — interaction ledger, subagent gate, status
 * pipeline, renderer state machine — is reused unchanged. Empirics
 * (grok 0.2.101):
 * - camelCase keys, snake_case event values (`hookEventName: "pre_tool_use"`)
 * - tool names are snake_case (`exit_plan_mode`, `ask_user_question`) with
 *   claude-compatible input shapes (ask_user_question sends the same
 *   `questions` array as AskUserQuestion)
 * - `exit_plan_mode` has an EMPTY toolInput; the plan text lives in plan.md
 *   next to the session's updates.jsonl (payload `transcriptPath`)
 * - there is no PermissionRequest hook; a Notification with
 *   `notificationType: "permission_prompt"` fires when a dialog is shown
 *   (verified absent under --always-approve), always right after the
 *   blocking tool's pre_tool_use — pairing them recovers the tool identity
 * - user prompts arrive wrapped in <user_query>…</user_query> tags
 */

/** Bump when the generated hook file content changes shape. */
const GROK_HOOK_MARKER = 'hive-grok-hook-v1'
const GROK_HOOK_FILE_NAME = 'hive-session.json'

function grokHome(): string {
  return process.env.GROK_HOME?.trim() || path.join(homedir(), '.grok')
}

/**
 * A curl relay for one hook path, generated for the platform this machine's
 * grok will run the hook on (the file is written by the same host).
 *
 * POSIX: `$(printenv …)` is used instead of `$VAR` so grok's own load-time
 * variable expansion (which would bake in an empty string while the config
 * loads) can't corrupt the command; the value must resolve at runtime in the
 * spawned shell, where each Hive session's URL differs.
 *
 * Windows: cmd syntax — `%VAR%` is untouched by grok's `${VAR}`/`$VAR`
 * load-time expansion and resolves at execution; curl ships with Win10+.
 */
function hookCommand(hookPath: string, curlMaxTimeSecs: number): string {
  if (process.platform === 'win32') {
    return (
      `if not defined HIVE_GROK_HOOK_URL (echo {}) else ` +
      `(curl -s -X POST -H "Content-Type: application/json" --data-binary @- --max-time ${curlMaxTimeSecs} ` +
      `"%HIVE_GROK_HOOK_URL%/${hookPath}" || echo {})`
    )
  }
  return (
    `: ${GROK_HOOK_MARKER}; printenv HIVE_GROK_HOOK_URL >/dev/null 2>&1 || { cat >/dev/null; echo '{}'; exit 0; }; ` +
    `curl -s -X POST -H 'Content-Type: application/json' --data-binary @- --max-time ${curlMaxTimeSecs} ` +
    `"$(printenv HIVE_GROK_HOOK_URL)/${hookPath}" || echo '{}'`
  )
}

function hookEntry(
  hookPath: string,
  opts?: { matcher?: string; timeoutSecs?: number }
): Record<string, unknown> {
  const timeoutSecs = opts?.timeoutSecs ?? 30
  return {
    ...(opts?.matcher ? { matcher: opts.matcher } : {}),
    hooks: [
      {
        type: 'command',
        command: hookCommand(hookPath, Math.max(5, timeoutSecs - 5)),
        timeout: timeoutSecs
      }
    ]
  }
}

export function buildGrokHookFileContent(): string {
  return JSON.stringify(
    {
      hooks: {
        SessionStart: [hookEntry('session')],
        SessionEnd: [hookEntry('session')],
        UserPromptSubmit: [hookEntry('start')],
        Stop: [hookEntry('stop')],
        SubagentStop: [hookEntry('subagent')],
        // No matcher: every pre_tool_use is needed so permission_prompt
        // notifications can be paired with the tool that raised them. The
        // generous timeout is a ceiling for question/plan hooks a transport
        // may hold open, not a delay.
        PreToolUse: [hookEntry('tool', { timeoutSecs: 600 })],
        PostToolUse: [hookEntry('tool')],
        PostToolUseFailure: [hookEntry('tool')],
        Notification: [hookEntry('permission', { matcher: 'permission_prompt', timeoutSecs: 600 })]
      }
    },
    null,
    2
  )
}

/**
 * Idempotently install the global grok hook file. Called before every grok
 * spawn; rewrites only when content differs (upgrades across Hive versions).
 */
export function ensureGrokHooksInstalled(): void {
  const hooksDir = path.join(grokHome(), 'hooks')
  const hookFile = path.join(hooksDir, GROK_HOOK_FILE_NAME)
  const content = buildGrokHookFileContent()

  try {
    if (existsSync(hookFile) && readFileSync(hookFile, 'utf-8') === content) return
    mkdirSync(hooksDir, { recursive: true })
    writeFileSync(hookFile, content, 'utf-8')
    log.info('Installed grok hook file', { hookFile })
  } catch (error) {
    // Non-fatal: the session still runs, just without status hooks.
    log.warn('Failed to install grok hook file', {
      hookFile,
      error: error instanceof Error ? error.message : String(error)
    })
  }
}

/** Base URL exported to the grok process as HIVE_GROK_HOOK_URL. */
export function buildGrokCliHookUrlBase(port: number, hiveSessionId: string): string {
  return `http://127.0.0.1:${port}/grok-hook/${encodeURIComponent(hiveSessionId)}`
}

// ---------------------------------------------------------------------------
// Payload translation
// ---------------------------------------------------------------------------

export interface GrokHookBody {
  hookEventName?: string
  sessionId?: string
  transcriptPath?: string
  prompt?: string
  toolName?: string
  toolUseId?: string
  toolInput?: unknown
  permissionMode?: string
  notificationType?: string
  message?: string
  agentId?: string
  source?: string
  reason?: string
}

const EVENT_MAP: Record<string, string> = {
  session_start: 'SessionStart',
  session_end: 'SessionEnd',
  user_prompt_submit: 'UserPromptSubmit',
  stop: 'Stop',
  subagent_stop: 'SubagentStop',
  pre_tool_use: 'PreToolUse',
  post_tool_use: 'PostToolUse',
  post_tool_use_failure: 'PostToolUseFailure'
}

/**
 * Grok tool names whose claude-cli equivalents drive pipeline behavior
 * (ledger classification, status mapping, renderer plan/question cards).
 * Unmapped names pass through unchanged.
 */
const TOOL_MAP: Record<string, string> = {
  exit_plan_mode: 'ExitPlanMode',
  enter_plan_mode: 'EnterPlanMode',
  ask_user_question: 'AskUserQuestion'
}

interface GrokSessionTracking {
  /** The root grok session id for this Hive session (child/subagent grok sessions differ). */
  rootGrokSessionId: string | null
  /** Most recent root pre_tool_use — pairs permission_prompt notifications with their tool. */
  lastPreToolUse: {
    toolName: string
    toolUseId?: string
    transcriptPath?: string
    toolInput?: unknown
  } | null
  /**
   * Grok's live permission mode, refreshed from each root pre_tool_use
   * payload. NOTE: grok's plan state is a separate state machine, NOT a
   * permission mode — during an active plan session this reports the mode
   * armed underneath (bypassPermissions for --always-approve spawns), so it
   * must never be used to decide "is this session planning".
   */
  permissionMode: string | null
  /**
   * Whether grok's plan session is active, seeded from the Hive session mode
   * at spawn and updated from exit_plan_mode outcomes (PostToolUse = plan
   * approved → off; PostToolUseFailure = revisions requested → still on;
   * PostToolUse of enter_plan_mode → on). user_prompt_submit carries no plan
   * signal of its own, but the pipeline maps UserPromptSubmit→planning off
   * the injected permission_mode — which in turn drives the renderer's
   * plan-followup handling across ALL planning rounds, not just the first.
   */
  planActive: boolean
  /**
   * The Hive session mode as last observed, so mid-session mode switches made
   * in Hive (setSessionMode only sends Shift+Tab keystrokes to the TUI — no
   * hook fires) are reconciled into planActive on the next prompt: a CHANGED
   * db mode is a user decision and wins; an unchanged one leaves grok-driven
   * transitions (enter/exit_plan_mode) in charge.
   */
  lastDbMode: string | null
}

const tracking = new Map<string, GrokSessionTracking>()

type GrokSessionIdSink = (hiveSessionId: string, grokSessionId: string) => void
let grokSessionIdSink: GrokSessionIdSink | null = null

/** Registered once by terminal-pty-bridge to persist detected grok session ids. */
export function setGrokSessionIdSink(sink: GrokSessionIdSink | null): void {
  grokSessionIdSink = sink
}

type GrokSessionModeProvider = (hiveSessionId: string) => string | null
let grokSessionModeProvider: GrokSessionModeProvider | null = null

/** Registered by terminal-pty-bridge: reads the session's current Hive mode from the DB. */
export function setGrokSessionModeProvider(provider: GrokSessionModeProvider | null): void {
  grokSessionModeProvider = provider
}

/**
 * Seed tracking at spawn time with the session id we are resuming (or null
 * for a fresh session, in which case the first hook's sessionId becomes the
 * root and is reported through the sink) and the plan state implied by the
 * spawn (the pty bridge arms grok's plan mode for plan-mode Hive sessions).
 */
export function seedGrokSessionTracking(
  hiveSessionId: string,
  grokSessionId: string | null,
  opts?: { planMode?: boolean; dbMode?: string | null }
): void {
  tracking.set(hiveSessionId, {
    rootGrokSessionId: grokSessionId,
    lastPreToolUse: null,
    permissionMode: null,
    planActive: opts?.planMode ?? false,
    lastDbMode: opts?.dbMode ?? null
  })
}

export function clearGrokSessionTracking(hiveSessionId: string): void {
  tracking.delete(hiveSessionId)
}

export function clearAllGrokSessionTracking(): void {
  tracking.clear()
}

function getOrCreateTracking(hiveSessionId: string): GrokSessionTracking {
  let state = tracking.get(hiveSessionId)
  if (!state) {
    state = {
      rootGrokSessionId: null,
      lastPreToolUse: null,
      permissionMode: null,
      planActive: false,
      lastDbMode: null
    }
    tracking.set(hiveSessionId, state)
  }
  return state
}

function unwrapUserQuery(prompt: string): string {
  const match = /^\s*<user_query>\s*([\s\S]*?)\s*<\/user_query>\s*$/.exec(prompt)
  return match ? match[1] : prompt
}

function readPlanFile(transcriptPath: string | undefined): string | undefined {
  if (!transcriptPath) return undefined
  try {
    const planPath = path.join(path.dirname(transcriptPath), 'plan.md')
    if (!existsSync(planPath)) return undefined
    const content = readFileSync(planPath, 'utf-8').trim()
    return content.length > 0 ? content : undefined
  } catch {
    return undefined
  }
}

/**
 * Translate a grok hook payload for `hiveSessionId` into the ParsedClaudeHook
 * shape the claude-cli pipeline consumes. Returns null for events the
 * pipeline must not see (subagent child-session lifecycle noise, notification
 * types other than permission prompts).
 */
/**
 * Events whose sessionId is trusted to name the ROOT grok session when
 * tracking was seeded without one (fresh spawn). Root adoption must never
 * happen from tool/subagent hooks: a subagent child session's lifecycle can
 * interleave with the root's, and adopting a child id as root would flip
 * every later root hook to subagent-scoped (dropped Stops, mis-routed
 * ledger state).
 */
const ROOT_ADOPTION_EVENTS = new Set(['session_start', 'user_prompt_submit'])

export function translateGrokHook(
  hiveSessionId: string,
  raw: GrokHookBody
): ParsedClaudeHook | null {
  const state = getOrCreateTracking(hiveSessionId)
  const grokSessionId = typeof raw.sessionId === 'string' ? raw.sessionId : null

  if (
    grokSessionId &&
    !state.rootGrokSessionId &&
    !raw.agentId &&
    ROOT_ADOPTION_EVENTS.has(raw.hookEventName ?? '')
  ) {
    state.rootGrokSessionId = grokSessionId
    grokSessionIdSink?.(hiveSessionId, grokSessionId)
  }
  const isRootEvent = !grokSessionId || grokSessionId === state.rootGrokSessionId
  // Subagent-scoped hooks mirror claude's agent_id convention so the subagent
  // gate treats them as never-a-session-completion.
  const agentId = !isRootEvent ? (raw.agentId ?? grokSessionId ?? undefined) : raw.agentId

  const event = raw.hookEventName ?? ''

  if (event === 'notification') {
    // Only dialogs block a session; everything else (turn_complete etc.) is
    // filtered by the hook matcher, but re-check to fail closed.
    if (raw.notificationType !== 'permission_prompt' || !isRootEvent) return null
    const paired = state.lastPreToolUse
    const hook: ParsedClaudeHook = {
      hook_event_name: 'PermissionRequest',
      tool_name: paired?.toolName,
      tool_use_id: paired?.toolUseId,
      transcript_path: raw.transcriptPath
    }
    if (paired?.toolInput !== undefined && paired.toolInput !== null) {
      hook.tool_input = paired.toolInput as ParsedClaudeHook['tool_input']
    }
    if (paired?.toolName === 'ExitPlanMode') {
      const plan = readPlanFile(raw.transcriptPath ?? paired.transcriptPath)
      if (plan !== undefined) hook.tool_input = { plan }
    }
    return hook
  }

  const mappedEvent = EVENT_MAP[event]
  if (!mappedEvent) return null

  // Child grok sessions (subagents) start/end their own lifecycle; letting
  // those reset the ledger/tracker would clobber the root session's state.
  if (!isRootEvent && (mappedEvent === 'SessionStart' || mappedEvent === 'SessionEnd')) {
    return null
  }
  if (!isRootEvent && mappedEvent === 'UserPromptSubmit') {
    return null
  }

  const toolName = raw.toolName ? (TOOL_MAP[raw.toolName] ?? raw.toolName) : undefined

  const hook: ParsedClaudeHook = {
    hook_event_name: mappedEvent,
    transcript_path: raw.transcriptPath
  }
  if (toolName) hook.tool_name = toolName
  if (raw.toolUseId) hook.tool_use_id = raw.toolUseId
  if (agentId) hook.agent_id = agentId
  // Grok's tool inputs are claude-shaped (ask_user_question carries the same
  // `questions` array as AskUserQuestion) — pass them through so consumers
  // like the transport hold (question.asked) see them. exit_plan_mode is the
  // exception: its input is empty and is overridden from plan.md below.
  if (raw.toolInput !== undefined && raw.toolInput !== null) {
    hook.tool_input = raw.toolInput as ParsedClaudeHook['tool_input']
  }

  if (mappedEvent === 'UserPromptSubmit') {
    if (typeof raw.prompt === 'string') {
      hook.prompt = unwrapUserQuery(raw.prompt)
    }
    // A Hive-side mode switch since the last look (ticket toggle, approval
    // persist) is a user decision and overrides the hook-derived plan state;
    // an unchanged db mode leaves grok-driven transitions in charge.
    const dbMode = grokSessionModeProvider?.(hiveSessionId) ?? null
    if (dbMode !== null && dbMode !== state.lastDbMode) {
      state.planActive = dbMode === 'plan' || dbMode === 'super-plan'
      state.lastDbMode = dbMode
    }
    // Plan iteration rounds must keep mapping to 'planning': the plan signal
    // comes from the tracked plan state, never from grok's permission mode
    // (which reads bypassPermissions underneath an active plan session).
    if (state.planActive) {
      hook.permission_mode = 'plan'
    } else if (state.permissionMode) {
      hook.permission_mode = state.permissionMode
    }
  }

  if (mappedEvent === 'PreToolUse' && isRootEvent) {
    if (raw.permissionMode) {
      state.permissionMode = raw.permissionMode
    }
    if (toolName) {
      state.lastPreToolUse = {
        toolName,
        toolUseId: raw.toolUseId,
        transcriptPath: raw.transcriptPath,
        toolInput: raw.toolInput
      }
    }
  }
  if (
    (mappedEvent === 'PostToolUse' || mappedEvent === 'PostToolUseFailure') &&
    isRootEvent &&
    state.lastPreToolUse &&
    raw.toolUseId &&
    state.lastPreToolUse.toolUseId === raw.toolUseId
  ) {
    state.lastPreToolUse = null
  }

  // Track grok's plan lifecycle from the tools that drive it: an approved
  // exit_plan_mode ends the plan session (a failed one means revisions were
  // requested — planning continues), and an approved enter_plan_mode starts
  // one mid-session.
  if (isRootEvent && toolName === 'ExitPlanMode' && mappedEvent === 'PostToolUse') {
    state.planActive = false
  }
  if (isRootEvent && toolName === 'EnterPlanMode' && mappedEvent === 'PostToolUse') {
    state.planActive = true
  }

  // The plan text is not in exit_plan_mode's (empty) toolInput — surface the
  // session's plan.md so plan_ready statuses carry the plan for the renderer
  // card, matching claude's ExitPlanMode tool_input.plan.
  if (toolName === 'ExitPlanMode' && mappedEvent !== 'PostToolUseFailure') {
    const plan = readPlanFile(raw.transcriptPath)
    if (plan !== undefined) hook.tool_input = { plan }
  }

  return hook
}
