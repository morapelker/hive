import type { Session } from '../db/types'
import { getUserEnvironmentVariables } from './env-vars'
import type { DatabaseService } from '../db/database'

export interface ClaudeCliPtySpawnInput {
  session: Pick<
    Session,
    'mode' | 'model_id' | 'model_variant' | 'claude_session_id'
  >
  worktreePath: string
  pendingPrompt?: string | null
  claudeBinary?: string | null
  claudeSessionId?: string | null
  hookSettingsJson?: string | null
  db?: DatabaseService | null
}

export interface ClaudeCliPtySpawn {
  command: string
  args: string[]
  cwd: string
  env: Record<string, string>
}

const VALID_MODELS = new Set(['fable', 'opus', 'sonnet', 'haiku'])
const VALID_EFFORTS = new Set(['low', 'medium', 'high', 'xhigh', 'max'])

/**
 * "ultracode" is not a valid claude `--effort` value. It is enabled through the
 * `ultracode` setting (xhigh effort plus standing dynamic-workflow
 * orchestration) injected into the `--settings` JSON instead of via `--effort`.
 */
const ULTRACODE = 'ultracode'

export function isUltracodeEffort(value: string | null | undefined): boolean {
  return typeof value === 'string' && value.toLowerCase() === ULTRACODE
}

/**
 * Merge `{ ultracode: true }` into the existing claude `--settings` JSON,
 * preserving the hook config already in it. Falls back to a fresh object when
 * there is no prior settings string or it cannot be parsed, so a malformed blob
 * never breaks spawning.
 */
function withUltracodeSetting(hookSettingsJson: string | null | undefined): string {
  let settings: Record<string, unknown> = {}
  if (hookSettingsJson) {
    try {
      const parsed = JSON.parse(hookSettingsJson)
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        settings = parsed as Record<string, unknown>
      }
    } catch {
      settings = {}
    }
  }
  settings[ULTRACODE] = true
  return JSON.stringify(settings)
}

export function normalizeClaudeCliModel(modelId: string | null | undefined): string | null {
  if (!modelId) return null
  const lower = modelId.toLowerCase()
  if (VALID_MODELS.has(lower)) return lower
  if (lower.includes('fable')) return 'fable'
  if (lower.includes('opus')) return 'opus'
  if (lower.includes('sonnet')) return 'sonnet'
  if (lower.includes('haiku')) return 'haiku'
  return null
}

function normalizeClaudeCliEffort(effort: string | null | undefined): string | null {
  if (!effort) return null
  const lower = effort.toLowerCase()
  return VALID_EFFORTS.has(lower) ? lower : null
}

export function buildClaudeCliPtySpawn(input: ClaudeCliPtySpawnInput): ClaudeCliPtySpawn {
  const mode = input.session.mode
  const args =
    mode === 'plan' || mode === 'super-plan'
      ? ['--allow-dangerously-skip-permissions', '--permission-mode', 'plan']
      : ['--dangerously-skip-permissions']

  const model = normalizeClaudeCliModel(input.session.model_id)
  if (model) {
    args.push('--model', model)
  }

  const ultracode = isUltracodeEffort(input.session.model_variant)
  const effort = normalizeClaudeCliEffort(input.session.model_variant)
  if (effort) {
    args.push('--effort', effort)
  }

  const resumeId = input.claudeSessionId ?? input.session.claude_session_id
  if (resumeId) {
    args.push('--resume', resumeId)
  }

  if (ultracode) {
    // ultracode is enabled via the settings JSON, not `--effort`. Merge it into
    // the hook settings (or a fresh object when there are none) so the flag is
    // always present when selected.
    args.push('--settings', withUltracodeSetting(input.hookSettingsJson))
  } else if (input.hookSettingsJson) {
    args.push('--settings', input.hookSettingsJson)
  }

  const prompt = input.pendingPrompt?.trim()
  if (prompt) {
    args.push(prompt)
  }

  return {
    command: input.claudeBinary || 'claude',
    args,
    cwd: input.worktreePath,
    env: getUserEnvironmentVariables(input.db ?? null)
  }
}
