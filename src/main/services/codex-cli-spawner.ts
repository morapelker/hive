import { readFileSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import type { Session } from '../db/types'
import type { DatabaseService } from '../db/database'
import { getUserEnvironmentVariables } from './env-vars'
import { CODEX_REASONING_EFFORTS, normalizeCodexModelSlug } from './codex-models'
import { tomlString } from './codex-cli-hooks'
import { resolveCodexHome } from './codex-cli-rollout'

/**
 * argv construction for a Codex CLI (TUI) session — the codex counterpart of
 * claude-cli-spawner.ts. Differences that matter:
 *
 * - Permissions: claude's `--dangerously-skip-permissions` becomes codex's
 *   `--dangerously-bypass-approvals-and-sandbox` (no approval prompts, no
 *   sandbox) so ticket work runs unattended exactly like the Claude CLI
 *   provider does. Plan mode is a collaboration mode toggled inside the TUI
 *   (Shift+Tab); codex has no flag for it, so the PTY bridge switches modes
 *   after the SessionStart hook (see terminal-pty-bridge.ts).
 * - Model/effort: `-m <slug>` and `-c model_reasoning_effort="<effort>"`.
 * - Resume: `codex resume <thread-id>`; the positional prompt and every flag
 *   are accepted after the subcommand (`SessionTuiCli`).
 * - Folder trust: codex shows a "trust this folder?" onboarding screen when
 *   `projects."<root>".trust_level` is unset, which would swallow an argv
 *   prompt. The root is the main repository for a linked worktree
 *   (`resolve_root_git_project_for_trust`), so both the project path and the
 *   worktree path are marked trusted through a `-c projects={…}` override —
 *   nothing is written to the user's config.toml.
 * - Prompt delivery: codex submits the argv prompt as a plain user message the
 *   moment the session is configured, before any keystroke can switch modes,
 *   and never parses it for slash commands. Plan-mode and slash-prefixed
 *   (`/goal …`) prompts therefore stay out of argv and are pasted into the
 *   composer by the bridge once the TUI is up (`promptViaPty`).
 * - Model deprecation: when the session's model has an `upgrade` in codex's
 *   model catalog, the TUI opens a blocking "switch to <new model>?" prompt at
 *   startup (observed with gpt-5.4-mini → gpt-5.6-luna). Pre-acknowledging the
 *   migration through `-c notice.model_migrations={…}` is exactly what "Use
 *   existing model" persists, so the session keeps the model Hive stamped and
 *   the prompt never blocks the launch.
 */

export interface CodexCliPtySpawnInput {
  session: Pick<Session, 'mode' | 'model_id' | 'model_variant' | 'claude_session_id'>
  worktreePath: string
  /** The project (main repository) path — the trust key codex resolves worktrees to. */
  projectPath?: string | null
  pendingPrompt?: string | null
  codexBinary?: string | null
  /** Overrides the session row's stored thread id for `codex resume`. */
  codexSessionId?: string | null
  /** `-c` pairs from buildCodexCliHookOverrides (hooks + trust state). */
  hookOverrideArgs?: string[] | null
  db?: DatabaseService | null
  /** Injectable for tests; defaults to reading codex's models_cache.json. */
  readModelUpgradeTarget?: (model: string, env: Record<string, string | undefined>) => string | null
}

export interface CodexCliPtySpawn {
  command: string
  args: string[]
  cwd: string
  env: Record<string, string>
  /**
   * A prompt the caller must paste into the running TUI instead of passing via
   * argv (plan mode / slash commands). Null when the prompt rides on argv or
   * there is no prompt.
   */
  promptViaPty: string | null
}

const VALID_EFFORTS = new Set<string>(CODEX_REASONING_EFFORTS)

export function normalizeCodexCliEffort(effort: string | null | undefined): string | null {
  if (!effort) return null
  const lower = effort.toLowerCase()
  return VALID_EFFORTS.has(lower) ? lower : null
}

/** Resolve the `-m` slug for a session, tolerating aliases ('5.5') and dated snapshot ids. */
export function normalizeCodexCliModel(modelId: string | null | undefined): string | null {
  if (!modelId) return null
  return normalizeCodexModelSlug(modelId) ?? modelId.trim() ?? null
}

export function isPlanLikeMode(mode: string | null | undefined): boolean {
  return mode === 'plan' || mode === 'super-plan'
}

/**
 * Whether a prompt has to go through the TUI composer: slash commands are only
 * recognized there, and a plan-mode prompt must not be submitted before the
 * bridge has switched the TUI into Plan mode.
 */
export function requiresPtyPromptDelivery(
  prompt: string | null | undefined,
  mode: string | null | undefined
): boolean {
  if (!prompt || !prompt.trim()) return false
  if (isPlanLikeMode(mode)) return true
  return prompt.trimStart().startsWith('/')
}

/**
 * The `-c projects={…}` override that pre-trusts the session's folders. The
 * whole table rides as one inline value because codex's `-c` key parser splits
 * on `.` without quoted segments, and absolute paths (e.g. `~/.hive-worktrees`)
 * contain dots.
 *
 * Codex keys trust by the canonical (symlink-resolved) path of the git root —
 * on macOS `/tmp/x` is trusted only as `/private/tmp/x` (verified against
 * 0.153.4: the symlink form still showed the trust prompt). Every path is
 * therefore emitted both as given and resolved.
 */
export function buildCodexTrustOverride(
  paths: Array<string | null | undefined>,
  resolvePath: (p: string) => string = realpathOrSelf
): string | null {
  const unique = new Set<string>()
  for (const p of paths) {
    if (!p || p.trim().length === 0) continue
    const trimmed = p.trim()
    unique.add(trimmed)
    unique.add(resolvePath(trimmed))
  }
  if (unique.size === 0) return null
  const entries = [...unique].map((p) => `${tomlString(p)}={trust_level="trusted"}`)
  return `projects={${entries.join(',')}}`
}

function realpathOrSelf(p: string): string {
  try {
    return realpathSync.native(p)
  } catch {
    return p
  }
}

interface CodexModelsCacheEntry {
  slug?: unknown
  model?: unknown
  upgrade?: { model?: unknown } | null
}

/**
 * The deprecation upgrade target codex's cached model catalog
 * (`$CODEX_HOME/models_cache.json`) declares for `model`, or null.
 */
export function readCodexModelUpgradeTarget(
  model: string,
  env: Record<string, string | undefined> = process.env
): string | null {
  try {
    const raw = readFileSync(join(resolveCodexHome(env), 'models_cache.json'), 'utf8')
    const parsed = JSON.parse(raw) as { models?: unknown } | unknown[]
    const list = Array.isArray(parsed)
      ? parsed
      : Array.isArray((parsed as { models?: unknown }).models)
        ? ((parsed as { models: unknown[] }).models as unknown[])
        : []
    for (const entry of list as CodexModelsCacheEntry[]) {
      const slug = typeof entry?.slug === 'string' ? entry.slug : entry?.model
      if (slug !== model) continue
      const target = entry.upgrade?.model
      return typeof target === 'string' && target && target !== model ? target : null
    }
  } catch {
    // No cache yet (fresh install) or unreadable: codex will prompt if needed.
  }
  return null
}

/** `-c notice.model_migrations={…}` pre-acknowledging the model's deprecation prompt, or null. */
export function buildCodexModelMigrationOverride(
  model: string | null,
  upgradeTarget: string | null
): string | null {
  if (!model || !upgradeTarget) return null
  return `notice.model_migrations={${tomlString(model)}=${tomlString(upgradeTarget)}}`
}

export function buildCodexCliPtySpawn(input: CodexCliPtySpawnInput): CodexCliPtySpawn {
  const args: string[] = []

  const resumeId = input.codexSessionId ?? input.session.claude_session_id
  if (resumeId && !resumeId.startsWith('pending::')) {
    args.push('resume', resumeId)
  }

  // Parity with claude's --dangerously-skip-permissions: no approval dialogs,
  // no sandbox. Plan mode is read-only by codex's own tool policy anyway.
  args.push('--dangerously-bypass-approvals-and-sandbox')
  // The update-available picker is a modal that would eat the first prompt
  // (and it means nothing inside Hive's embedded terminal).
  args.push('-c', 'check_for_update_on_startup=false')

  const env = getUserEnvironmentVariables(input.db ?? null)
  const model = normalizeCodexCliModel(input.session.model_id)
  if (model) {
    args.push('-m', model)
    const migration = buildCodexModelMigrationOverride(
      model,
      (input.readModelUpgradeTarget ?? readCodexModelUpgradeTarget)(model, { ...process.env, ...env })
    )
    if (migration) args.push('-c', migration)
  }
  const effort = normalizeCodexCliEffort(input.session.model_variant)
  if (effort) {
    args.push('-c', `model_reasoning_effort=${tomlString(effort)}`)
  }

  const trust = buildCodexTrustOverride([input.projectPath, input.worktreePath])
  if (trust) {
    args.push('-c', trust)
  }

  if (input.hookOverrideArgs?.length) {
    args.push(...input.hookOverrideArgs)
  }

  const prompt = input.pendingPrompt?.trim() || null
  let promptViaPty: string | null = null
  if (prompt) {
    if (requiresPtyPromptDelivery(prompt, input.session.mode)) {
      promptViaPty = prompt
    } else {
      args.push(prompt)
    }
  }

  return {
    command: input.codexBinary || 'codex',
    args,
    cwd: input.worktreePath,
    env,
    promptViaPty
  }
}
