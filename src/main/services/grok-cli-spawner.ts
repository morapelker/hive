import type { Session } from '../db/types'
import { getUserEnvironmentVariables } from './env-vars'
import type { DatabaseService } from '../db/database'

export interface GrokCliPtySpawnInput {
  session: Pick<Session, 'mode' | 'model_id' | 'model_variant' | 'claude_session_id'>
  worktreePath: string
  pendingPrompt?: string | null
  grokBinary?: string | null
  grokSessionId?: string | null
  /** Per-session hook callback base URL, exported as HIVE_GROK_HOOK_URL. */
  hookUrlBase?: string | null
  db?: DatabaseService | null
}

export interface GrokCliPtySpawn {
  command: string
  args: string[]
  cwd: string
  env: Record<string, string>
}

/**
 * Grok only ships grok-family model ids (`grok models`); anything else stored
 * on the session (e.g. after a handoff from a Claude session) must not be
 * forwarded or grok exits with an unknown-model error.
 */
export function normalizeGrokCliModel(modelId: string | null | undefined): string | null {
  if (!modelId) return null
  const lower = modelId.toLowerCase()
  return lower.startsWith('grok') ? lower : null
}

// `grok --reasoning-effort banana` → "use one of: high, medium, low"
const VALID_GROK_EFFORTS = new Set(['low', 'medium', 'high'])

/**
 * Foreign variants left on the row by cross-provider handoffs (xhigh, max,
 * ultra, ultracode) must be dropped, not forwarded — grok exits on unknown
 * effort levels.
 */
export function normalizeGrokCliEffort(effort: string | null | undefined): string | null {
  if (!effort) return null
  const lower = effort.toLowerCase()
  return VALID_GROK_EFFORTS.has(lower) ? lower : null
}

/**
 * Build the PTY spawn for a Grok Build CLI session, mirroring
 * buildClaudeCliPtySpawn.
 *
 * Every mode runs `--always-approve` (grok's bypassPermissions), matching
 * claude-cli's `--dangerously-skip-permissions` yolo default. Plan mode is
 * NOT a spawn flag: grok accepts `--permission-mode plan` only for Claude
 * compatibility (and it clobbers --always-approve — verified empirically on
 * 0.2.101); real plan sessions are toggled in the TUI. The pty bridge
 * activates plan mode with Shift+Tab keystrokes after boot and delivers the
 * prompt as a paste (the first prompt is what flips grok's plan state
 * Pending→Active), so plan-mode spawns must not carry a positional prompt.
 */
export function buildGrokCliPtySpawn(input: GrokCliPtySpawnInput): GrokCliPtySpawn {
  const args = ['--always-approve']

  const model = normalizeGrokCliModel(input.session.model_id)
  if (model) {
    args.push('--model', model)
  }

  const effort = normalizeGrokCliEffort(input.session.model_variant)
  if (effort) {
    args.push('--reasoning-effort', effort)
  }

  const resumeId = input.grokSessionId ?? input.session.claude_session_id
  if (resumeId) {
    args.push('--resume', resumeId)
  }

  const prompt = input.pendingPrompt?.trim()
  if (prompt) {
    args.push(prompt)
  }

  const env = getUserEnvironmentVariables(input.db ?? null)
  if (input.hookUrlBase) {
    // Read by the static global hook file (~/.grok/hooks/hive-session.json):
    // hooks no-op for grok sessions not spawned by Hive (var unset) and post
    // to this session's URL otherwise. The URL embeds the Hive session id, so
    // no per-session hook file writes are needed.
    env.HIVE_GROK_HOOK_URL = input.hookUrlBase
  }

  let command = input.grokBinary || 'grok'
  let finalArgs = args
  if (process.platform === 'win32' && !command.toLowerCase().endsWith('.exe')) {
    // `where grok` can resolve an npm-style shim (grok.cmd / extensionless
    // script); Windows process creation cannot spawn those without a shell,
    // so route them through cmd.exe.
    finalArgs = ['/c', command, ...args]
    command = 'cmd.exe'
  }

  return {
    command,
    args: finalArgs,
    cwd: input.worktreePath,
    env
  }
}
