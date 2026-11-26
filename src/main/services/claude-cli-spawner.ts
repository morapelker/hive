import type { Session } from '../db/types'
import {
  CUSTOM_MODEL_PROVIDER_ID,
  matchCustomProviderModel,
  resolveCustomProviderEffort,
  type CustomProviderModel
} from '@shared/types/custom-provider'
import { getUserEnvironmentVariables } from './env-vars'
import { getClaudeApiProxyEnv } from './claude-api-proxy/claude-api-proxy-env'
import type { DatabaseService } from '../db/database'

export interface ClaudeCliPtySpawnInput {
  session: Pick<
    Session,
    'mode' | 'model_provider_id' | 'model_id' | 'model_variant' | 'claude_session_id'
  >
  worktreePath: string
  pendingPrompt?: string | null
  claudeBinary?: string | null
  claudeSessionId?: string | null
  hookSettingsJson?: string | null
  db?: DatabaseService | null
  /**
   * A custom provider's launch command (may be a shell alias or a full command
   * line with env prefixes). When set, the spawn runs through the user's
   * interactive login shell so aliases resolve, and Hive's --model/--effort
   * flags are suppressed — the command itself decides the model — unless the
   * session's model matches one the provider declares (customProviderModels).
   */
  customProviderCommand?: string | null
  /**
   * The custom provider's declared models. When the session's `model_id`
   * matches a declared slug, that slug is passed verbatim as `--model` (and the
   * declared effort as `--effort`) after the command, overriding alias-baked
   * flags via claude's last-flag-wins semantics.
   */
  customProviderModels?: CustomProviderModel[] | null
  /**
   * Which of Claude Code's two renderers the session draws with. `fullscreen` (the default)
   * forces the fullscreen one whatever the user saved; `inherit` adds nothing and leaves the
   * choice to Claude Code and the user's own settings. Every session shown in the app's
   * terminal is fullscreen; only the tmux launch on a remote server inherits.
   */
  renderer?: ClaudeCliRenderer
}

export interface ClaudeCliPtySpawn {
  command: string
  args: string[]
  cwd: string
  env: Record<string, string>
  /**
   * The claude session id that went on argv as `--resume`, or null for a
   * brand-new session. The bridge keys its launch watch on this: a resumed
   * transcript is not a launch.
   */
  resumeSessionId: string | null
}

const VALID_MODELS = new Set(['fable', 'opus', 'sonnet', 'haiku'])
const VALID_EFFORTS = new Set(['low', 'medium', 'high', 'xhigh', 'max'])

/**
 * "ultracode" is not a valid claude `--effort` value. It is enabled through the
 * `ultracode` setting (standing dynamic-workflow orchestration) injected into
 * the `--settings` JSON, alongside an explicit `--effort xhigh` so the effort
 * never depends on the setting's implied default.
 */
const ULTRACODE = 'ultracode'
const ULTRACODE_EFFORT = 'xhigh'

export function isUltracodeEffort(value: string | null | undefined): boolean {
  return typeof value === 'string' && value.toLowerCase() === ULTRACODE
}

export type ClaudeCliRenderer = 'fullscreen' | 'inherit'

/**
 * The environment that puts Claude Code in its fullscreen renderer (alternate screen, repaint
 * in place) instead of the classic one, which writes the whole conversation into scrollback
 * again on every terminal resize (claude-code issue 46834). The app always asks for
 * fullscreen.
 *
 * `CLAUDE_CODE_NO_FLICKER=1` wins over the `tui` setting the user saved (`/tui default`), in
 * any settings file, without that file being edited. `CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN`
 * wins over both when it is on, so it is turned off here in case the user's shell exports it.
 * Checked against Claude Code 2.1.325.
 */
export const CLAUDE_CLI_FULLSCREEN_ENV: Readonly<Record<string, string>> = Object.freeze({
  CLAUDE_CODE_NO_FLICKER: '1',
  CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN: '0'
})

const CLAUDE_CLI_SCROLL_SPEED_ENV = 'CLAUDE_CODE_SCROLL_SPEED'

/**
 * How many lines one wheel step scrolls a fullscreen conversation. In fullscreen mode the
 * wheel no longer moves the terminal's scrollback: xterm.js reports each step to Claude Code,
 * which scrolls one line per report unless it knows the terminal sends one report per notch.
 * It recognises xterm.js by its XTVERSION reply (or VS Code's TERM_PROGRAM) and then uses 3,
 * but xterm.js 6 does not answer XTVERSION, so in the app's terminal it stays at 1: a wheel
 * notch moves a single line and a trackpad swipe a handful. 3 is the value Claude Code picks
 * for xterm.js itself and the one its docs give for such terminals.
 */
export const CLAUDE_CLI_DEFAULT_SCROLL_SPEED = '3'

/**
 * The scroll speed as a default only: nothing is set when the environment the app runs in
 * already has one, the user's variables in Settings are applied after it, and it is kept out
 * of the `--settings` JSON, so a `CLAUDE_CODE_SCROLL_SPEED` in the `env` block of one of the
 * user's own settings files (where the docs say `/scroll-speed` saves it) still wins: Claude
 * Code applies those blocks over the environment of the process.
 */
function claudeCliScrollSpeedDefault(): Record<string, string> {
  if (process.env[CLAUDE_CLI_SCROLL_SPEED_ENV]?.trim()) return {}
  return { [CLAUDE_CLI_SCROLL_SPEED_ENV]: CLAUDE_CLI_DEFAULT_SCROLL_SPEED }
}

/**
 * The claude `--settings` JSON for a spawn: the hook config the caller built, plus what this
 * launch adds to it. Falls back to a fresh object when there is no prior settings string or it
 * cannot be parsed, so a malformed blob never breaks spawning. Null when there is nothing to
 * pass.
 *
 * - `ultracode`: `{ ultracode: true }`, the standing dynamic-workflow orchestration.
 * - `fullscreen`: the fullscreen variables again, as an `env` block. An `env` block in one of
 *   the user's settings files is applied over the process environment, so a saved
 *   `CLAUDE_CODE_NO_FLICKER=0` there would undo the variables of the spawn. `--settings` ranks
 *   above the user, project and local files, and its block is the one that holds.
 */
function buildClaudeCliSettingsArg(
  hookSettingsJson: string | null | undefined,
  additions: { ultracode: boolean; fullscreen: boolean }
): string | null {
  if (!additions.ultracode && !additions.fullscreen) return hookSettingsJson || null
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
  if (additions.ultracode) settings[ULTRACODE] = true
  if (additions.fullscreen) {
    const existingEnv =
      settings.env && typeof settings.env === 'object' && !Array.isArray(settings.env)
        ? (settings.env as Record<string, unknown>)
        : {}
    settings.env = { ...existingEnv, ...CLAUDE_CLI_FULLSCREEN_ENV }
  }
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
  const customCommand = input.customProviderCommand?.trim() || null
  const args =
    mode === 'plan' || mode === 'super-plan'
      ? ['--allow-dangerously-skip-permissions', '--permission-mode', 'plan']
      : ['--dangerously-skip-permissions']

  // Custom providers own their model selection (often baked into the command
  // as an alias flag) — a Hive-side --model/--effort appended after the alias's
  // own flags would win and silently override it. Exception: when the provider
  // declares models and this session carries one of their slugs, the user
  // explicitly picked it, so pass it verbatim (last-flag-wins is now desired).
  // Stale stock-claude values in model_id (pre-feature sessions) never match a
  // declared slug and stay suppressed.
  // The slug match additionally requires the 'custom' marker: legacy sessions
  // carry stock stamps (model_provider_id 'anthropic', model_id 'sonnet'), and
  // a provider later declaring a slug named like a stock alias must not start
  // overriding the alias-baked model on their respawn.
  const customModel =
    customCommand && input.session.model_provider_id === CUSTOM_MODEL_PROVIDER_ID
      ? matchCustomProviderModel(input.customProviderModels, input.session.model_id)
      : null
  // A custom-provider session whose provider was deleted/blanked degrades to
  // plain claude with its proxy slug still in model_id — never let that slug
  // reach normalizeClaudeCliModel, whose substring matching could turn e.g.
  // 'kimi-sonnet' into a real --model sonnet on stock claude.
  const orphanedCustomModel =
    !customCommand && input.session.model_provider_id === CUSTOM_MODEL_PROVIDER_ID
  const model = customCommand
    ? (customModel?.slug.trim() ?? null)
    : orphanedCustomModel
      ? null
      : normalizeClaudeCliModel(input.session.model_id)
  if (model) {
    args.push('--model', model)
  }

  // Ultracode is Hive-injected claude settings — suppress it for custom
  // providers along with --model/--effort; it is never offered for provider
  // models, so a remembered ultracode variant would ride along invisibly.
  const ultracode =
    customCommand || orphanedCustomModel ? false : isUltracodeEffort(input.session.model_variant)
  const effort = customCommand
    ? customModel
      ? normalizeClaudeCliEffort(resolveCustomProviderEffort(customModel, input.session.model_variant))
      : null
    : orphanedCustomModel
      ? null
      : ultracode
        ? ULTRACODE_EFFORT
        : normalizeClaudeCliEffort(input.session.model_variant)
  if (effort) {
    args.push('--effort', effort)
  }

  // A `pending::` placeholder is the SDK path's not-yet-materialised id (the
  // codex spawner guards the same way); it is never a transcript to resume.
  const resumeId = input.claudeSessionId ?? input.session.claude_session_id
  const resumeSessionId = resumeId && !resumeId.startsWith('pending::') ? resumeId : null
  if (resumeSessionId) {
    args.push('--resume', resumeSessionId)
  }

  // ultracode is enabled via the settings JSON (its effort rides as `--effort xhigh` above),
  // and the fullscreen renderer is pinned there too. Both are merged into the hook settings
  // (or a fresh object when there are none), so each is always present when it applies.
  const fullscreen = (input.renderer ?? 'fullscreen') === 'fullscreen'
  const settingsArg = buildClaudeCliSettingsArg(input.hookSettingsJson, { ultracode, fullscreen })
  if (settingsArg) {
    args.push('--settings', settingsArg)
  }

  const prompt = input.pendingPrompt?.trim()
  if (prompt) {
    // A prompt that opens with a dash (a markdown list) would be parsed as an unknown option,
    // and the CLI would exit before doing anything.
    if (prompt.startsWith('-')) args.push('--')
    args.push(prompt)
  }

  // The local API proxy's env goes LAST: a user-level ANTHROPIC_BASE_URL in
  // Settings still applies, as the proxy's upstream, rather than bypassing the
  // proxy (and with it the real-time usage headers). A custom provider whose
  // command inlines its own ANTHROPIC_BASE_URL= still wins inside the shell —
  // those are not Anthropic subscription accounts.
  // The renderer variables go after the user's own: a CLAUDE_CODE_NO_FLICKER=0 saved in
  // Settings must not put an app session back in the classic renderer.
  const env = {
    ...(fullscreen ? claudeCliScrollSpeedDefault() : {}),
    ...getUserEnvironmentVariables(input.db ?? null),
    ...(fullscreen ? CLAUDE_CLI_FULLSCREEN_ENV : {}),
    ...getClaudeApiProxyEnv()
  }

  if (customCommand) {
    return {
      ...buildCustomProviderShellSpawn(customCommand, args),
      cwd: input.worktreePath,
      env,
      resumeSessionId
    }
  }

  return {
    command: input.claudeBinary || 'claude',
    args,
    cwd: input.worktreePath,
    env,
    resumeSessionId
  }
}

const POSIX_WRAPPER_SHELLS = new Set(['zsh', 'bash', 'sh', 'dash', 'ksh'])

/**
 * Run a custom provider's command through an interactive shell so aliases and
 * functions from the user's shell config resolve. Hive's args (hooks, resume,
 * permission flags, prompt) ride as positional parameters — "$@" (or fish's
 * $argv) — so the prompt and --settings JSON are never string-interpolated
 * into the shell script.
 *
 * Shell flavors differ: fish rejects "$@" and has no argv0 slot after -c;
 * csh/tcsh can't parse combined -ilc at all; bash LOGIN shells read
 * .bash_profile instead of .bashrc (where interactive aliases live), so bash
 * gets interactive non-login (-ic) while zsh keeps -ilc (.zshrc is read by
 * every interactive zsh). Unknown/non-POSIX login shells fall back to a
 * platform POSIX shell (aliases defined only in e.g. .tcshrc won't resolve
 * there, but the spawn works instead of dying on a parse error).
 */
export function buildCustomProviderShellSpawn(
  customCommand: string,
  args: string[]
): { command: string; args: string[] } {
  const posixFallback = process.platform === 'darwin' ? '/bin/zsh' : '/bin/bash'
  const shell = process.env.SHELL || posixFallback
  const shellName = shell.split('/').pop() ?? shell

  if (shellName === 'fish') {
    // fish: trailing -c args land in $argv directly (no argv0 slot).
    return { command: shell, args: ['-ilc', `${customCommand} $argv`, ...args] }
  }

  const wrapperShell = POSIX_WRAPPER_SHELLS.has(shellName) ? shell : posixFallback
  const wrapperName = wrapperShell.split('/').pop() ?? wrapperShell
  const flags = wrapperName === 'bash' ? '-ic' : '-ilc'
  const argv0 = customCommand.split(/\s+/)[0] || 'claude'
  return { command: wrapperShell, args: [flags, `${customCommand} "$@"`, argv0, ...args] }
}
