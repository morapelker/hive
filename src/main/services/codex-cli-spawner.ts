import type { Session } from '../db/types'
import { getUserEnvironmentVariables } from './env-vars'
import type { DatabaseService } from '../db/database'

/**
 * Builds the PTY spawn spec for a `codex-cli` session — the codex TUI running
 * in a terminal, mirroring claude-cli-spawner.ts for the codex binary.
 *
 * Codex differences that shape the args (verified against codex 0.144):
 * - Yolo is `--dangerously-bypass-approvals-and-sandbox` (the counterpart of
 *   claude's `--dangerously-skip-permissions`, passed in every mode so the
 *   session never blocks on approvals — plan-mode restraint comes from the
 *   collaboration mode, not the approval policy).
 * - There is NO CLI flag for plan mode: the TUI always boots in the Default
 *   collaboration mode. Plan mode is entered post-boot via a Shift+Tab
 *   keystroke driven by the SessionStart hook (see codex-cli-boot-actions.ts),
 *   which is also why a plan-mode prompt must NOT be passed as a positional
 *   arg (it would auto-submit before the mode flip) — the caller withholds it.
 * - Resume is a subcommand (`codex resume <thread-uuid>`), not a flag. The
 *   thread id is captured from the SessionStart hook payload and persisted in
 *   the session's claude_session_id column (generic "CLI session id").
 * - `-c check_for_update_on_startup=false` is always passed: a promptless
 *   `codex resume <id>` otherwise blocks on the interactive "Update
 *   available!" picker (cmux ships the same suppression).
 * - The worktree is stamped trusted via a `projects` config override so a
 *   fresh worktree never blocks on the trust dialog. The override is
 *   per-invocation only — it never touches ~/.codex/config.toml.
 */
export interface CodexCliPtySpawnInput {
  session: Pick<Session, 'mode' | 'model_id' | 'model_variant' | 'claude_session_id'>
  worktreePath: string
  pendingPrompt?: string | null
  codexBinary?: string | null
  codexSessionId?: string | null
  /** Extra `-c hooks.*` args from buildCodexCliHookArgs. */
  hookArgs?: string[] | null
  db?: DatabaseService | null
}

export interface CodexCliPtySpawn {
  command: string
  args: string[]
  cwd: string
  env: Record<string, string>
}

const VALID_EFFORTS = new Set(['ultra', 'max', 'xhigh', 'high', 'medium', 'low'])

export function normalizeCodexCliEffort(variant: string | null | undefined): string | null {
  if (!variant) return null
  const lower = variant.toLowerCase()
  return VALID_EFFORTS.has(lower) ? lower : null
}

/**
 * TOML inline-table override marking the worktree trusted for this invocation.
 * The path is embedded in a TOML basic string; escape backslashes and quotes
 * (Windows paths, exotic worktree names).
 */
function trustProjectOverride(worktreePath: string): string {
  const escaped = worktreePath.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
  return `projects={"${escaped}"={trust_level="trusted"}}`
}

export function buildCodexCliPtySpawn(input: CodexCliPtySpawnInput): CodexCliPtySpawn {
  const resumeId = input.codexSessionId ?? input.session.claude_session_id

  const args: string[] = resumeId ? ['resume', resumeId] : []

  args.push(
    '--dangerously-bypass-approvals-and-sandbox',
    '-c',
    'check_for_update_on_startup=false',
    '-c',
    trustProjectOverride(input.worktreePath)
  )

  if (input.session.model_id) {
    args.push('-m', input.session.model_id)
  }

  const effort = normalizeCodexCliEffort(input.session.model_variant)
  if (effort) {
    args.push('-c', `model_reasoning_effort="${effort}"`)
  }

  if (input.hookArgs?.length) {
    args.push(...input.hookArgs)
  }

  // Final positional arg = the initial prompt, which auto-submits. This is
  // valid for BOTH a fresh launch (`codex [PROMPT]`) and a resume: the
  // interactive `codex resume [SESSION_ID] [PROMPT]` explicitly accepts an
  // "Optional user prompt to start the session" (verified via `codex resume
  // --help` on the >= 0.134 binaries we gate on — the `exec resume` variant is
  // a separate, non-interactive command we don't use).
  const prompt = input.pendingPrompt?.trim()
  if (prompt) {
    args.push(prompt)
  }

  return {
    command: input.codexBinary || 'codex',
    args,
    cwd: input.worktreePath,
    env: getUserEnvironmentVariables(input.db ?? null)
  }
}
