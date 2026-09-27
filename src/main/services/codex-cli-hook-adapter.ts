import type { ParsedClaudeHook } from './claude-hook-server'
import { readCodexPlanText } from './codex-cli-rollout'

/**
 * Normalizes codex hook payloads into the Claude-shaped hooks the shared CLI
 * pipeline (status mapping, interaction ledger, subagent/background trackers,
 * transports, renderer status listener) already understands. The events and
 * most fields match one-to-one (session_id, transcript_path, cwd, tool_name,
 * tool_input, tool_use_id, tool_response, prompt, last_assistant_message,
 * agent_id/agent_type); the differences this module bridges:
 *
 * - Questions: codex asks through the `request_user_input` function tool
 *   (PreToolUse → blocks until answered in the TUI → PostToolUse). It becomes
 *   `AskUserQuestion` with the questions re-shaped to Claude's schema, so the
 *   ledger latches `answering` and releases it on PostToolUse.
 * - Interrupt: codex has a dedicated hook for Esc/Ctrl+C (claude has none); it
 *   is a turn end, so it becomes a `Stop` tagged `user_interrupt`.
 * - Plan mode: codex has no ExitPlanMode tool and hook payloads never expose
 *   the collaboration mode (`permission_mode` is only default/bypassPermissions).
 *   Hive drives the TUI's Plan mode itself (Shift+Tab) and knows the session's
 *   mode from its row, so:
 *     · `permission_mode` is rewritten to `plan` while the session is in plan
 *       mode, which is what maps UserPromptSubmit to `planning`;
 *     · a `Stop` in plan mode whose turn produced a Plan item is preceded by a
 *       synthetic `PreToolUse ExitPlanMode` carrying the plan text (the
 *       renderer shows the plan card, the ticket moves to review) — the Stop
 *       itself follows so telemetry/usage/transports see the turn end;
 *     · the TUI's "Implement this plan?" → "Yes" submits the literal prompt
 *       `Implement the plan.` (or the clear-context variant); that
 *       UserPromptSubmit is preceded by a synthetic `PostToolUse ExitPlanMode`,
 *       the exact signal the renderer treats as "plan approved, now building".
 * - PreCompact/PostCompact carry nothing the pipeline needs and are dropped.
 */

export interface CodexCliHookBody {
  hook_event_name?: string
  session_id?: unknown
  turn_id?: unknown
  transcript_path?: unknown
  cwd?: unknown
  model?: unknown
  permission_mode?: unknown
  source?: unknown
  reason?: unknown
  prompt?: unknown
  tool_name?: unknown
  tool_input?: unknown
  tool_response?: unknown
  tool_use_id?: unknown
  stop_hook_active?: unknown
  last_assistant_message?: unknown
  agent_id?: unknown
  agent_type?: unknown
}

export interface AdaptedCodexCliHook {
  hook: ParsedClaudeHook
  /** Overrides the published status metadata reason (e.g. `user_interrupt`). */
  reason?: string
}

export interface AdaptCodexCliHookContext {
  /** Whether Hive currently holds this session in Plan mode (from the session row). */
  planMode: boolean
  /** Injectable for tests; defaults to reading the rollout on disk. */
  readPlanText?: (transcriptPath: string, turnId: string | null) => string | null
}

/** Verbatim prompts the codex TUI submits when the user accepts a proposed plan (tui/src/chatwidget/plan_implementation.rs). */
export const CODEX_PLAN_IMPLEMENT_PROMPT = 'Implement the plan.'
export const CODEX_PLAN_IMPLEMENT_CLEAR_CONTEXT_PREFIX =
  "A previous agent produced the plan below to accomplish the user's task."

export const CODEX_REQUEST_USER_INPUT_TOOL = 'request_user_input'

export function isCodexPlanImplementPrompt(prompt: unknown): boolean {
  if (typeof prompt !== 'string') return false
  const trimmed = prompt.trim()
  return (
    trimmed === CODEX_PLAN_IMPLEMENT_PROMPT ||
    trimmed.startsWith(CODEX_PLAN_IMPLEMENT_CLEAR_CONTEXT_PREFIX)
  )
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

/**
 * codex `request_user_input` args → Claude `AskUserQuestion` input.
 * codex: `{questions:[{id, header, question, options:[{label, description}], isOther?, isSecret?}]}`
 * claude: `{questions:[{question, header, options:[{label, description}], multiSelect}]}`
 */
export function adaptCodexQuestionsInput(toolInput: unknown): { questions: Array<Record<string, unknown>> } {
  const record = asRecord(toolInput)
  const rawQuestions = Array.isArray(record?.questions) ? record.questions : []
  const questions = rawQuestions
    .map((raw) => asRecord(raw))
    .filter((q): q is Record<string, unknown> => q !== null)
    .map((q) => {
      const options = Array.isArray(q.options)
        ? q.options
            .map((o) => asRecord(o))
            .filter((o): o is Record<string, unknown> => o !== null)
            .map((o) => ({
              label: str(o.label) ?? '',
              description: str(o.description) ?? ''
            }))
        : []
      return {
        question: str(q.question) ?? '',
        header: str(q.header) ?? '',
        options,
        multiSelect: false,
        ...(str(q.id) ? { id: q.id } : {})
      }
    })
  return { questions }
}

function baseHook(body: CodexCliHookBody, ctx: AdaptCodexCliHookContext): ParsedClaudeHook {
  const hook: ParsedClaudeHook = {
    hook_event_name: body.hook_event_name,
    session_id: body.session_id,
    transcript_path: body.transcript_path,
    permission_mode: ctx.planMode ? 'plan' : str(body.permission_mode)
  }
  if (str(body.agent_id)) hook.agent_id = body.agent_id as string
  if (str(body.agent_type)) hook.agent_type = body.agent_type as string
  if (body.source !== undefined) hook.source = body.source
  if (str(body.turn_id)) hook.turn_id = body.turn_id
  return hook
}

export function adaptCodexCliHook(
  body: CodexCliHookBody,
  ctx: AdaptCodexCliHookContext
): AdaptedCodexCliHook[] {
  const event = body.hook_event_name
  if (!event) return []

  switch (event) {
    case 'PreCompact':
    case 'PostCompact':
      return []

    case 'SessionStart':
    case 'SessionEnd':
    case 'SubagentStart':
    case 'SubagentStop':
      return [{ hook: baseHook(body, ctx) }]

    case 'Interrupt': {
      const hook = baseHook(body, ctx)
      hook.hook_event_name = 'Stop'
      return [{ hook, reason: 'user_interrupt' }]
    }

    case 'Stop': {
      const stop = baseHook(body, ctx)
      const lastMessage = str(body.last_assistant_message)
      if (lastMessage !== undefined) stop.last_assistant_message = lastMessage
      const results: AdaptedCodexCliHook[] = []
      if (ctx.planMode && !str(body.agent_id)) {
        const transcriptPath = str(body.transcript_path)
        const turnId = str(body.turn_id) ?? null
        const plan = transcriptPath
          ? (ctx.readPlanText ?? readCodexPlanText)(transcriptPath, turnId)
          : null
        if (plan) {
          const planReady = baseHook(body, ctx)
          planReady.hook_event_name = 'PreToolUse'
          planReady.tool_name = 'ExitPlanMode'
          planReady.tool_use_id = `codex-plan:${turnId ?? 'unknown'}`
          planReady.tool_input = { plan }
          results.push({ hook: planReady })
        }
      }
      results.push({ hook: stop })
      return results
    }

    case 'UserPromptSubmit': {
      const prompt = str(body.prompt)
      const submit = baseHook(body, ctx)
      submit.prompt = body.prompt
      if (isCodexPlanImplementPrompt(prompt)) {
        // The user accepted the proposed plan: codex switched itself to
        // Default mode for this turn, so the prompt is a build turn.
        submit.permission_mode = str(body.permission_mode) ?? 'default'
        const implemented = baseHook(body, ctx)
        implemented.hook_event_name = 'PostToolUse'
        implemented.tool_name = 'ExitPlanMode'
        implemented.tool_use_id = `codex-plan:${str(body.turn_id) ?? 'unknown'}`
        implemented.tool_input = {}
        return [{ hook: implemented }, { hook: submit }]
      }
      return [{ hook: submit }]
    }

    case 'PreToolUse':
    case 'PostToolUse':
    case 'PermissionRequest': {
      const hook = baseHook(body, ctx)
      const toolName = str(body.tool_name)
      if (toolName === CODEX_REQUEST_USER_INPUT_TOOL) {
        hook.tool_name = 'AskUserQuestion'
        hook.tool_input = adaptCodexQuestionsInput(body.tool_input)
      } else {
        hook.tool_name = toolName
        hook.tool_input = (asRecord(body.tool_input) ?? {}) as ParsedClaudeHook['tool_input']
      }
      if (str(body.tool_use_id)) hook.tool_use_id = body.tool_use_id as string
      if (event === 'PostToolUse') hook.tool_response = body.tool_response
      return [{ hook }]
    }

    default:
      return []
  }
}

// ── Mid-session model tracking ────────────────────────────────────────

const lastModelBySession = new Map<string, string>()

/**
 * Every codex hook names the model that produced the turn. Mirror the Claude
 * model watcher's rule: only an observed transition between consecutive hook
 * models is a switch made by the CLI (a `/model` in the TUI, an automatic
 * fallback); the first observation seeds the baseline so a user picking a new
 * model in Hive (row updated, CLI still on the old model until respawn) is
 * never reverted. Returns the new model when a transition was observed.
 */
export function trackCodexCliModel(sessionId: string, model: unknown): string | null {
  if (typeof model !== 'string' || model.trim().length === 0) return null
  const current = model.trim()
  const previous = lastModelBySession.get(sessionId)
  lastModelBySession.set(sessionId, current)
  if (previous === undefined || previous === current) return null
  return current
}

export function resetCodexCliModelTracking(sessionId: string): void {
  lastModelBySession.delete(sessionId)
}

export function resetAllCodexCliModelTracking(): void {
  lastModelBySession.clear()
}
