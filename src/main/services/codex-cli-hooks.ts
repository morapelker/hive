import { getDatabase } from '../db'
import { createLogger } from './logger'
import { CODEX_PROPOSED_PLAN_FINALIZATION } from '@shared/agent-mode-prefixes'
import type { ParsedClaudeHook } from './claude-hook-server'

const log = createLogger({ component: 'CodexCliHooks' })

/**
 * Codex CLI integration: per-spawn hook injection + payload translation.
 *
 * Codex (>=0.129, verified on 0.144) ships a Claude-compatible hooks engine.
 * Unlike grok there is no global-file requirement: hook config rides the spawn
 * args as `-c hooks.<Event>=[…]` TOML overrides (with
 * `--dangerously-bypass-hook-trust` so the injected hooks skip the persisted
 * trust prompt), each command a `curl` that POSTs the stdin payload to the
 * shared hook server on `/codex-hook/<hiveSessionId>/<path>`. Nothing under
 * ~/.codex is ever written.
 *
 * Payloads are translated into the ParsedClaudeHook shape so the entire
 * claude-cli control plane — interaction ledger, subagent gate, status
 * pipeline, plan auto-approve, renderer state machine — is reused unchanged
 * (the same architecture as grok-cli-hooks). Codex specifics:
 * - Payload keys are already snake_case with claude event names; only tool
 *   names need mapping (`request_user_input` is codex's AskUserQuestion).
 * - `permission_mode` reflects the approval policy (always "bypassPermissions"
 *   under Hive's yolo spawn), never plan mode — planning is derived from
 *   Hive's own session.mode and injected on UserPromptSubmit.
 * - Plans follow the CODEX convention, not claude's: codex has no ExitPlanMode
 *   tool, and codex-cli deliberately stays in codex's Default collaboration
 *   mode (entering native Plan mode would pop codex's own interactive
 *   "Implement this plan?" dialog — the claude-style plan dialog we avoid).
 *   Instead we ASK for a plan via CODEX_PLAN_MODE_PREFIX / the super-plan
 *   prefix (the same instruction the `codex` SDK injects out-of-band): codex
 *   reads/reasons without mutating and emits its finished plan wrapped in
 *   `<proposed_plan>…</proposed_plan>`. On a plan-mode Stop we extract that
 *   block (extractProposedPlanText) and, only if present, latch plan_ready. The
 *   synthesized `ExitPlanMode` tool_name is purely Hive's internal plan-ready
 *   status label (shared with claude-cli) so the block routes into the same
 *   plan-card pipeline — it is never a codex tool call.
 * - Implementing sends the canned "Implement the plan." follow-up (the codex
 *   SDK's implementation prompt); codex is already in Default mode, so this
 *   just starts an implementing turn. That UserPromptSubmit is translated into
 *   a synthesized PostToolUse(ExitPlanMode), which the renderer treats as
 *   "plan approved → flip the Hive session to build".
 * - The codex thread id (`session_id`) and rollout path arrive on every hook,
 *   so there is no transcript-dir watcher: the id is reported through a sink
 *   (registered by terminal-pty-bridge) and persisted for `codex resume`.
 */

/**
 * codex's AskUserQuestion equivalent. Only available to the model in codex's
 * native Plan collaboration mode, which codex-cli does not enter — so this hook
 * is wired (→ 'answering') for completeness/future-proofing but does not fire
 * in the prompt-driven plan flow; codex asks any clarifying questions as inline
 * terminal text instead.
 */
export const CODEX_QUESTION_TOOL = 'request_user_input'

// The implement follow-up Hive sends to approve a plan (buildSdkPlanImplementationPrompt
// + the hook-server auto-approve). Recognized only while the session is still
// plan-like (see below), so it's the "plan approved → go to build" signal.
const CODEX_PLAN_IMPLEMENT_MESSAGE = 'Implement the plan.'

const TOOL_MAP: Record<string, string> = {
  [CODEX_QUESTION_TOOL]: 'AskUserQuestion'
}

export interface CodexHookBody {
  hook_event_name?: string
  session_id?: string
  turn_id?: string
  transcript_path?: string | null
  cwd?: string
  model?: string
  permission_mode?: string
  tool_name?: string
  tool_input?: unknown
  tool_use_id?: string
  tool_response?: unknown
  prompt?: string
  stop_hook_active?: boolean
  last_assistant_message?: string | null
  agent_id?: string
  agent_type?: string
  source?: string
}

function codexHookUrl(port: number, hiveSessionId: string, path: string): string {
  return `http://127.0.0.1:${port}/codex-hook/${encodeURIComponent(hiveSessionId)}/${path}`
}

/**
 * The POSIX hook command. Codex runs it via `sh -c`; it writes the payload JSON
 * to stdin and parses stdout for a decision. The hook server always replies
 * `{}` ("no verdict"); on a bridge outage (server down / curl timeout) we must
 * STILL emit a valid `{}` — codex's Stop hook treats empty stdout on exit 0 as
 * invalid, so the `|| echo '{}'` fallback keeps a transient outage from
 * erroring every turn.
 */
function curlHookCommandPosix(url: string, maxTimeSeconds: number): string {
  return `curl -s -m ${maxTimeSeconds} -X POST -H 'Content-Type: application/json' --data-binary @- '${url}' 2>/dev/null || echo '{}'`
}

/**
 * The Windows hook command. Codex runs it via `cmd.exe /C`, so it needs
 * double-quoted args, `2>nul`, and a bare `echo {}` (cmd.exe's echo keeps the
 * quotes of `echo '{}'`). Supplied via codex's `commandWindows` override so the
 * hooks still POST after the .cmd/.bat shim is wrapped for the PTY.
 */
function curlHookCommandWindows(url: string, maxTimeSeconds: number): string {
  return `curl -s -m ${maxTimeSeconds} -X POST -H "Content-Type: application/json" --data-binary @- "${url}" 2>nul || echo {}`
}

function hookOverride(
  event: string,
  url: string,
  opts: { timeoutSeconds: number; matcher?: string }
): string[] {
  const maxTime = Math.max(5, opts.timeoutSeconds - 10)
  const command = curlHookCommandPosix(url, maxTime)
  const commandWindows = curlHookCommandWindows(url, maxTime)
  const matcher = opts.matcher ? `matcher="${opts.matcher}",` : ''
  // TOML inline value; the commands are triple-quoted literal strings so no
  // escaping is needed inside (they must simply never contain three quotes).
  const value = `hooks.${event}=[{${matcher}hooks=[{type="command",command='''${command}''',commandWindows='''${commandWindows}''',timeout=${opts.timeoutSeconds}}]}]`
  return ['-c', value]
}

/**
 * Per-invocation hook wiring for a codex-cli spawn. `--enable hooks` covers
 * configs where the feature was explicitly disabled;
 * `--dangerously-bypass-hook-trust` skips the persisted-trust prompt for these
 * Hive-injected overrides.
 */
export function buildCodexCliHookArgs(port: number, hiveSessionId: string): string[] {
  const url = (path: string): string => codexHookUrl(port, hiveSessionId, path)
  return [
    '--enable',
    'hooks',
    '--dangerously-bypass-hook-trust',
    ...hookOverride('SessionStart', url('session'), { timeoutSeconds: 20 }),
    ...hookOverride('UserPromptSubmit', url('start'), { timeoutSeconds: 20 }),
    ...hookOverride('Stop', url('stop'), { timeoutSeconds: 20 }),
    // Questions only; the generous timeout is a ceiling for hooks a transport
    // may one day hold open, not a delay.
    ...hookOverride('PreToolUse', url('tool'), {
      timeoutSeconds: 600,
      matcher: CODEX_QUESTION_TOOL
    }),
    ...hookOverride('PostToolUse', url('tool'), { timeoutSeconds: 20 }),
    ...hookOverride('PermissionRequest', url('permission'), { timeoutSeconds: 600 })
  ]
}

// ---------------------------------------------------------------------------
// Session tracking + thread-id sink
// ---------------------------------------------------------------------------

interface CodexSessionTracking {
  /** Last thread id reported through the sink (dedupes per-hook reporting). */
  reportedThreadId: string | null
}

const tracking = new Map<string, CodexSessionTracking>()

type CodexSessionIdSink = (hiveSessionId: string, codexThreadId: string) => void
let codexSessionIdSink: CodexSessionIdSink | null = null

/** Registered once by terminal-pty-bridge to persist detected codex thread ids. */
export function setCodexSessionIdSink(sink: CodexSessionIdSink | null): void {
  codexSessionIdSink = sink
}

/**
 * Seed tracking at spawn time with the thread id we are resuming (or null for
 * a fresh session, in which case the first hook's session_id is reported
 * through the sink). `/clear` starts a new thread mid-PTY; the changed id is
 * reported again so resume stays fresh.
 */
export function seedCodexSessionTracking(
  hiveSessionId: string,
  codexThreadId: string | null
): void {
  tracking.set(hiveSessionId, { reportedThreadId: codexThreadId })
}

export function clearCodexSessionTracking(hiveSessionId: string): void {
  tracking.delete(hiveSessionId)
}

export function clearAllCodexSessionTracking(): void {
  tracking.clear()
}

function getOrCreateTracking(hiveSessionId: string): CodexSessionTracking {
  let state = tracking.get(hiveSessionId)
  if (!state) {
    state = { reportedThreadId: null }
    tracking.set(hiveSessionId, state)
  }
  return state
}

// ---------------------------------------------------------------------------
// Payload translation
// ---------------------------------------------------------------------------

function isPlanLikeHiveMode(hiveSessionId: string): boolean {
  try {
    const mode = getDatabase().getSession(hiveSessionId)?.mode
    return mode === 'plan' || mode === 'super-plan'
  } catch {
    return false
  }
}

function isCodexPlanApprovalPrompt(prompt: unknown): boolean {
  return typeof prompt === 'string' && prompt.trim() === CODEX_PLAN_IMPLEMENT_MESSAGE
}

/**
 * Whether a submitted prompt is a Hive-orchestrated codex-cli plan prompt (vs a
 * raw prompt the user typed directly into the codex TUI). Both codex-cli plan
 * prefixes — CODEX_PLAN_MODE_PREFIX and CODEX_CLI_SUPER_PLAN_MODE_PREFIX — embed
 * CODEX_PROPOSED_PLAN_FINALIZATION (the `<proposed_plan>` instruction), which a
 * raw TUI prompt never carries. We match on `includes` rather than a prefix
 * check because goal mode wraps the whole thing as `/goal … Goal success
 * criteria: …`, so the plan prefix is not at position 0.
 *
 * This gates plan-mode status: codex is spawned in bypass/yolo mode, so a raw
 * TUI prompt in a plan-persisted session can mutate files and is NOT a read-only
 * planning turn — only prefixed prompts actually instruct codex to plan.
 */
function isCodexPlanPrefixedPrompt(prompt: unknown): boolean {
  return typeof prompt === 'string' && prompt.includes(CODEX_PROPOSED_PLAN_FINALIZATION)
}

/**
 * Extract the markdown inside a `<proposed_plan>…</proposed_plan>` block — the
 * codex plan convention (there is no ExitPlanMode tool). We ask codex to emit
 * this block via CODEX_PLAN_MODE_PREFIX / CODEX_SUPER_PLAN_MODE_PREFIX, exactly
 * as the `codex` app-server SDK does; the block IS the "plan ready" signal.
 * Mirrors extractProposedPlanMarkdown in codex-implementer.ts. Returns the
 * trimmed inner content, or null when the text carries no complete block (e.g.
 * a plan turn that only asked a request_user_input question).
 */
export function extractProposedPlanText(text: string | null | undefined): string | null {
  if (typeof text !== 'string') return null
  // Scan ALL blocks and return the first with non-empty content: the model may
  // narrate the tag name or emit an empty/example block before the real plan
  // (a lazy first-match would then lock onto the empty one and drop the plan).
  for (const match of text.matchAll(/<proposed_plan>\s*([\s\S]*?)\s*<\/proposed_plan>/gi)) {
    const inner = match[1]?.trim()
    if (inner) return inner
  }
  return null
}

/**
 * Translate a codex hook payload for `hiveSessionId` into the ParsedClaudeHook
 * shape the claude-cli pipeline consumes. Returns null for events the pipeline
 * must not see (subagent-scoped hooks, unknown events).
 */
export function translateCodexHook(
  hiveSessionId: string,
  raw: CodexHookBody
): ParsedClaudeHook | null {
  // Subagent-scoped hooks (collab agents) carry agent_id; they must not drive
  // the main session's status or thread-id tracking.
  if (raw.agent_id) return null

  const state = getOrCreateTracking(hiveSessionId)
  if (typeof raw.session_id === 'string' && raw.session_id && raw.session_id !== state.reportedThreadId) {
    state.reportedThreadId = raw.session_id
    codexSessionIdSink?.(hiveSessionId, raw.session_id)
  }

  const event = raw.hook_event_name ?? ''
  const transcriptPath =
    typeof raw.transcript_path === 'string' && raw.transcript_path ? raw.transcript_path : undefined

  switch (event) {
    case 'SessionStart':
      return { hook_event_name: 'SessionStart', transcript_path: transcriptPath }

    case 'UserPromptSubmit': {
      // Codex never reports plan mode itself; plan-driven handling is keyed off
      // Hive's persisted session mode.
      const planLike = isPlanLikeHiveMode(hiveSessionId)
      // The "Implement the plan." follow-up is the plan-approval signal ONLY
      // while the session is still plan-like (auto-approve fires before the
      // renderer flips the mode; the manual implement path flips to build
      // first, so it falls through to a normal working prompt here). Gating on
      // planLike keeps a literal "Implement the plan." typed in a build-mode
      // session from emitting a spurious plan-approved event.
      if (planLike && isCodexPlanApprovalPrompt(raw.prompt)) {
        // Synthesized PostToolUse(ExitPlanMode) releases the plan_ready latch
        // and drives the renderer's "plan approved → build" handling.
        return {
          hook_event_name: 'PostToolUse',
          tool_name: 'ExitPlanMode',
          transcript_path: transcriptPath
        }
      }
      const hook: ParsedClaudeHook = {
        hook_event_name: 'UserPromptSubmit',
        prompt: raw.prompt,
        transcript_path: transcriptPath
      }
      // Only report a plan turn when the prompt actually carries the codex plan
      // convention. A raw prompt typed straight into the yolo-mode codex TUI
      // while the session is persisted as plan/super-plan is NOT read-only
      // planning — treating it as such would mislabel a mutating turn as
      // "planning" (see isCodexPlanPrefixedPrompt).
      if (planLike && isCodexPlanPrefixedPrompt(raw.prompt)) {
        hook.permission_mode = 'plan'
      }
      return hook
    }

    case 'PreToolUse':
    case 'PostToolUse':
    case 'PermissionRequest': {
      const toolName = raw.tool_name ? (TOOL_MAP[raw.tool_name] ?? raw.tool_name) : undefined
      const hook: ParsedClaudeHook = {
        hook_event_name: event,
        transcript_path: transcriptPath
      }
      if (toolName) hook.tool_name = toolName
      if (raw.tool_use_id) hook.tool_use_id = raw.tool_use_id
      if (raw.tool_input && typeof raw.tool_input === 'object') {
        hook.tool_input = raw.tool_input as ParsedClaudeHook['tool_input']
      }
      return hook
    }

    case 'Stop': {
      const lastAssistantMessage =
        typeof raw.last_assistant_message === 'string' && raw.last_assistant_message.trim()
          ? raw.last_assistant_message
          : undefined
      // In plan mode, a completed `<proposed_plan>` block in the final message
      // is codex's "plan ready" signal. Only then do we latch plan_ready; a
      // plan turn that merely asked a question (request_user_input) has no
      // block and stays a normal Stop. `ExitPlanMode` here is Hive's internal
      // plan-ready status name shared with claude-cli — NOT a codex tool call
      // (codex has none) — it just routes into the shared plan-card pipeline.
      if (isPlanLikeHiveMode(hiveSessionId)) {
        const planText = extractProposedPlanText(lastAssistantMessage)
        if (planText) {
          log.info('Codex <proposed_plan> received; latching plan_ready', {
            sessionId: hiveSessionId
          })
          return {
            hook_event_name: 'PermissionRequest',
            tool_name: 'ExitPlanMode',
            tool_input: { plan: planText },
            transcript_path: transcriptPath
          }
        }
      }
      return {
        hook_event_name: 'Stop',
        transcript_path: transcriptPath,
        last_assistant_message: lastAssistantMessage
      }
    }

    default:
      return null
  }
}
