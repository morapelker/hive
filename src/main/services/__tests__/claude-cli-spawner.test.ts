import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Session } from '../../db/types'
import { APP_SETTINGS_DB_KEY } from '@shared/types/settings'
import {
  CLAUDE_CLI_DEFAULT_SCROLL_SPEED,
  CLAUDE_CLI_FULLSCREEN_ENV,
  buildClaudeCliPtySpawn,
  buildCustomProviderShellSpawn,
  isUltracodeEffort,
  normalizeClaudeCliModel
} from '../claude-cli-spawner'

/** The `--settings` JSON of a spawn that carries no hook settings: the fullscreen block alone. */
const FULLSCREEN_SETTINGS = JSON.stringify({ env: CLAUDE_CLI_FULLSCREEN_ENV })

/** The `--settings` JSON of a spawn whose caller passed `hookSettingsJson`. */
function withFullscreen(hookSettingsJson: string): string {
  return JSON.stringify({ ...JSON.parse(hookSettingsJson), env: CLAUDE_CLI_FULLSCREEN_ENV })
}

function settingsOf(args: string[]): Record<string, unknown> | null {
  const index = args.indexOf('--settings')
  return index === -1 ? null : JSON.parse(args[index + 1])
}

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    id: 'hive-session-1',
    worktree_id: 'worktree-1',
    project_id: 'project-1',
    connection_id: null,
    name: 'Session 1',
    status: 'active',
    opencode_session_id: null,
    claude_session_id: null,
    agent_sdk: 'claude-code-cli',
    custom_provider_id: null,
    mode: 'build',
    session_type: 'default',
    model_provider_id: 'anthropic',
    model_id: 'sonnet',
    model_variant: 'high',
    remote_launch: null,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    completed_at: null,
    pinned_to_board: false,
    ...overrides
  }
}

describe('buildClaudeCliPtySpawn', () => {
  it('normalizes current Claude marketing model ids to CLI aliases', () => {
    expect(normalizeClaudeCliModel('fable')).toBe('fable')
    expect(normalizeClaudeCliModel('claude-fable-5-2')).toBe('fable')
    expect(normalizeClaudeCliModel('claude-fable-5-1')).toBe('fable')
    expect(normalizeClaudeCliModel('claude-sonnet-4')).toBe('sonnet')
    expect(normalizeClaudeCliModel('claude-opus-4-5-20251101')).toBe('opus')
    expect(normalizeClaudeCliModel('claude-haiku-5-5-20261006')).toBe('haiku')
  })

  it('builds build-mode argv with model, effort, resume id, and positional prompt', () => {
    const spawn = buildClaudeCliPtySpawn({
      session: makeSession({ claude_session_id: 'claude-uuid-1' }),
      worktreePath: '/repo/worktree',
      pendingPrompt: 'Implement this plan',
      claudeBinary: '/usr/local/bin/claude'
    })

    expect(spawn.command).toBe('/usr/local/bin/claude')
    expect(spawn.cwd).toBe('/repo/worktree')
    expect(spawn.args).toEqual([
      '--dangerously-skip-permissions',
      '--model',
      'sonnet',
      '--effort',
      'high',
      '--resume',
      'claude-uuid-1',
      '--settings',
      FULLSCREEN_SETTINGS,
      'Implement this plan'
    ])
    expect(spawn.resumeSessionId).toBe('claude-uuid-1')
  })

  it('ends the options before a prompt that opens with a dash, and only then', () => {
    const dashed = buildClaudeCliPtySpawn({
      session: makeSession(),
      worktreePath: '/repo/worktree',
      pendingPrompt: '- Set STRIPE_KEY\n- Rotate the webhook',
      claudeBinary: 'claude'
    })
    expect(dashed.args.slice(-2)).toEqual(['--', '- Set STRIPE_KEY\n- Rotate the webhook'])

    const plain = buildClaudeCliPtySpawn({
      session: makeSession(),
      worktreePath: '/repo/worktree',
      pendingPrompt: 'Set STRIPE_KEY - then rotate',
      claudeBinary: 'claude'
    })
    expect(plain.args).not.toContain('--')
    expect(plain.args.at(-1)).toBe('Set STRIPE_KEY - then rotate')
  })

  it('reports a brand-new session as not resumed', () => {
    const spawn = buildClaudeCliPtySpawn({
      session: makeSession(),
      worktreePath: '/repo/worktree',
      pendingPrompt: 'Implement this plan',
      claudeBinary: '/usr/local/bin/claude'
    })

    expect(spawn.args).not.toContain('--resume')
    expect(spawn.resumeSessionId).toBeNull()
  })

  it('never resumes a pending:: placeholder id', () => {
    const spawn = buildClaudeCliPtySpawn({
      session: makeSession({ claude_session_id: 'pending::0000' }),
      worktreePath: '/repo/worktree',
      pendingPrompt: 'Implement this plan',
      claudeBinary: '/usr/local/bin/claude'
    })

    expect(spawn.args).not.toContain('--resume')
    expect(spawn.resumeSessionId).toBeNull()
  })

  it('passes the Fable model category through to Claude CLI', () => {
    const spawn = buildClaudeCliPtySpawn({
      session: makeSession({
        model_id: 'claude-fable-5-2',
        model_variant: 'max'
      }),
      worktreePath: '/repo/worktree',
      pendingPrompt: null,
      claudeBinary: 'claude'
    })

    expect(spawn.args).toEqual([
      '--dangerously-skip-permissions',
      '--model',
      'fable',
      '--effort',
      'max',
      '--settings',
      FULLSCREEN_SETTINGS
    ])
  })

  it('adds the Claude CLI plan bypass flags for plan sessions and normalizes model ids', () => {
    const spawn = buildClaudeCliPtySpawn({
      session: makeSession({
        mode: 'plan',
        model_id: 'claude-opus-4-5-20251101',
        model_variant: 'max'
      }),
      worktreePath: '/repo/worktree',
      pendingPrompt: null,
      claudeBinary: 'claude'
    })

    expect(spawn.args).toEqual([
      '--allow-dangerously-skip-permissions',
      '--permission-mode',
      'plan',
      '--model',
      'opus',
      '--effort',
      'max',
      '--settings',
      FULLSCREEN_SETTINGS
    ])
  })

  it('adds the Claude CLI plan bypass flags for super-plan sessions', () => {
    const spawn = buildClaudeCliPtySpawn({
      session: makeSession({
        mode: 'super-plan',
        model_id: 'opus',
        model_variant: 'max'
      }),
      worktreePath: '/repo/worktree',
      pendingPrompt: null,
      claudeBinary: 'claude'
    })

    expect(spawn.args.slice(0, 3)).toEqual([
      '--allow-dangerously-skip-permissions',
      '--permission-mode',
      'plan'
    ])
  })

  it('omits invalid optional model and effort flags', () => {
    const spawn = buildClaudeCliPtySpawn({
      session: makeSession({
        model_id: 'not-a-claude-cli-model',
        model_variant: 'turbo'
      }),
      worktreePath: '/repo/worktree',
      pendingPrompt: '',
      claudeBinary: 'claude',
      claudeSessionId: null
    })

    expect(spawn.args).toEqual(['--dangerously-skip-permissions', '--settings', FULLSCREEN_SETTINGS])
  })

  it('places hook settings immediately before the trailing prompt argument', () => {
    const hookSettingsJson = '{"hooks":{}}'
    const spawn = buildClaudeCliPtySpawn({
      session: makeSession({ claude_session_id: 'claude-uuid-1' }),
      worktreePath: '/repo/worktree',
      pendingPrompt: 'Implement this plan',
      claudeBinary: 'claude',
      hookSettingsJson
    })

    expect(spawn.args).toEqual([
      '--dangerously-skip-permissions',
      '--model',
      'sonnet',
      '--effort',
      'high',
      '--resume',
      'claude-uuid-1',
      '--settings',
      withFullscreen(hookSettingsJson),
      'Implement this plan'
    ])
  })

  it('passes the fullscreen settings alone when hook settings are absent', () => {
    const spawn = buildClaudeCliPtySpawn({
      session: makeSession(),
      worktreePath: '/repo/worktree',
      pendingPrompt: 'Say hi',
      claudeBinary: 'claude'
    })

    expect(spawn.args.slice(-3)).toEqual(['--settings', FULLSCREEN_SETTINGS, 'Say hi'])
  })

  it('recognizes the ultracode effort case-insensitively', () => {
    expect(isUltracodeEffort('ultracode')).toBe(true)
    expect(isUltracodeEffort('UltraCode')).toBe(true)
    expect(isUltracodeEffort('xhigh')).toBe(false)
    expect(isUltracodeEffort(null)).toBe(false)
    expect(isUltracodeEffort(undefined)).toBe(false)
  })

  it('enables ultracode via the settings flag, preserves hooks, and sends --effort xhigh', () => {
    const hookSettingsJson = '{"hooks":{"Stop":[{"id":1}]}}'
    const spawn = buildClaudeCliPtySpawn({
      session: makeSession({ model_id: 'opus', model_variant: 'ultracode' }),
      worktreePath: '/repo/worktree',
      pendingPrompt: 'Go',
      claudeBinary: 'claude',
      hookSettingsJson
    })

    // ultracode rides in --settings; its effort is pinned to xhigh explicitly.
    expect(spawn.args).not.toContain('ultracode')
    expect(spawn.args[spawn.args.indexOf('--effort') + 1]).toBe('xhigh')
    // model is still forwarded as usual.
    expect(spawn.args).toContain('--model')
    expect(spawn.args).toContain('opus')

    const settingsIndex = spawn.args.indexOf('--settings')
    expect(settingsIndex).toBeGreaterThanOrEqual(0)
    const settings = JSON.parse(spawn.args[settingsIndex + 1])
    expect(settings.ultracode).toBe(true)
    expect(settings.hooks).toEqual({ Stop: [{ id: 1 }] })
  })

  it('passes ultracode settings even when no hook settings are provided', () => {
    const spawn = buildClaudeCliPtySpawn({
      session: makeSession({ model_id: 'opus', model_variant: 'ultracode' }),
      worktreePath: '/repo/worktree',
      pendingPrompt: null,
      claudeBinary: 'claude'
    })

    expect(spawn.args[spawn.args.indexOf('--effort') + 1]).toBe('xhigh')
    const settingsIndex = spawn.args.indexOf('--settings')
    expect(settingsIndex).toBeGreaterThanOrEqual(0)
    expect(JSON.parse(spawn.args[settingsIndex + 1])).toEqual({
      ultracode: true,
      env: CLAUDE_CLI_FULLSCREEN_ENV
    })
  })

  describe('custom provider commands', () => {
    const originalShell = process.env.SHELL

    afterEach(() => {
      if (originalShell === undefined) delete process.env.SHELL
      else process.env.SHELL = originalShell
    })

    it('wraps the command in the user shell with Hive args as positional parameters', () => {
      process.env.SHELL = '/bin/zsh'
      const hookSettingsJson = '{"hooks":{}}'
      const spawn = buildClaudeCliPtySpawn({
        session: makeSession({ claude_session_id: 'claude-uuid-1' }),
        worktreePath: '/repo/worktree',
        pendingPrompt: 'Implement this plan',
        claudeBinary: '/usr/local/bin/claude',
        hookSettingsJson,
        customProviderCommand: 'claudex'
      })

      expect(spawn.command).toBe('/bin/zsh')
      expect(spawn.args).toEqual([
        '-ilc',
        'claudex "$@"',
        'claudex',
        '--dangerously-skip-permissions',
        '--resume',
        'claude-uuid-1',
        '--settings',
        withFullscreen(hookSettingsJson),
        'Implement this plan'
      ])
      expect(spawn.cwd).toBe('/repo/worktree')
      expect(spawn.resumeSessionId).toBe('claude-uuid-1')
    })

    it('uses fish argv semantics for fish login shells', () => {
      process.env.SHELL = '/opt/homebrew/bin/fish'
      const spawn = buildCustomProviderShellSpawn('claudex', ['--dangerously-skip-permissions'])
      expect(spawn.command).toBe('/opt/homebrew/bin/fish')
      // fish has no argv0 slot after -c; trailing args land in $argv directly.
      expect(spawn.args).toEqual(['-ilc', 'claudex $argv', '--dangerously-skip-permissions'])
    })

    it('falls back to a POSIX shell for csh-family login shells', () => {
      process.env.SHELL = '/bin/tcsh'
      const spawn = buildCustomProviderShellSpawn('claudex', ['--flag'])
      const fallback = process.platform === 'darwin' ? '/bin/zsh' : '/bin/bash'
      expect(spawn.command).toBe(fallback)
      expect(spawn.args).toEqual([
        fallback.endsWith('bash') ? '-ic' : '-ilc',
        'claudex "$@"',
        'claudex',
        '--flag'
      ])
    })

    it('uses interactive non-login bash so ~/.bashrc aliases resolve', () => {
      process.env.SHELL = '/bin/bash'
      const spawn = buildCustomProviderShellSpawn('claudex', ['--flag'])
      expect(spawn.command).toBe('/bin/bash')
      // bash login shells read .bash_profile, not .bashrc where aliases live.
      expect(spawn.args).toEqual(['-ic', 'claudex "$@"', 'claudex', '--flag'])
    })

    it('suppresses the ultracode settings merge for custom providers', () => {
      const hookSettingsJson = '{"hooks":{"Stop":[{"id":1}]}}'
      const spawn = buildClaudeCliPtySpawn({
        session: makeSession({ model_id: 'opus', model_variant: 'ultracode' }),
        worktreePath: '/repo/worktree',
        pendingPrompt: null,
        claudeBinary: 'claude',
        hookSettingsJson,
        customProviderCommand: 'claudex'
      })

      // The hook settings pass through with the fullscreen block and nothing else: no
      // `ultracode` key.
      const settingsIndex = spawn.args.indexOf('--settings')
      expect(settingsIndex).toBeGreaterThanOrEqual(0)
      expect(spawn.args[settingsIndex + 1]).toBe(withFullscreen(hookSettingsJson))
      expect(spawn.args).not.toContain('--effort')
    })

    it('suppresses --model and --effort so the command keeps its own model flags', () => {
      const spawn = buildClaudeCliPtySpawn({
        session: makeSession({ model_id: 'sonnet', model_variant: 'high' }),
        worktreePath: '/repo/worktree',
        pendingPrompt: null,
        claudeBinary: 'claude',
        customProviderCommand: 'claudex'
      })

      expect(spawn.args).not.toContain('--model')
      expect(spawn.args).not.toContain('--effort')
    })

    it('passes a provider-declared model slug and effort verbatim', () => {
      process.env.SHELL = '/bin/zsh'
      const spawn = buildClaudeCliPtySpawn({
        session: makeSession({
          custom_provider_id: 'prov-1',
          model_provider_id: 'custom',
          model_id: 'glm-4.6',
          model_variant: 'high'
        }),
        worktreePath: '/repo/worktree',
        pendingPrompt: 'Do the thing',
        claudeBinary: 'claude',
        customProviderCommand: 'claudex',
        customProviderModels: [
          { id: 'm1', name: 'GLM 4.6', slug: 'glm-4.6', efforts: ['low', 'high'] }
        ]
      })

      // Positional params ride after the command's own flags, so the picked
      // model wins over an alias-baked --model (last-flag-wins).
      expect(spawn.args.slice(0, 3)).toEqual(['-ilc', 'claudex "$@"', 'claudex'])
      const modelIndex = spawn.args.indexOf('--model')
      expect(spawn.args[modelIndex + 1]).toBe('glm-4.6')
      const effortIndex = spawn.args.indexOf('--effort')
      expect(spawn.args[effortIndex + 1]).toBe('high')
      expect(spawn.args[spawn.args.length - 1]).toBe('Do the thing')
    })

    it('omits --effort when the session variant is not declared for the model', () => {
      const spawn = buildClaudeCliPtySpawn({
        session: makeSession({
          custom_provider_id: 'prov-1',
          model_provider_id: 'custom',
          model_id: 'glm-4.6',
          model_variant: 'max'
        }),
        worktreePath: '/repo/worktree',
        pendingPrompt: null,
        claudeBinary: 'claude',
        customProviderCommand: 'claudex',
        customProviderModels: [{ id: 'm1', name: 'GLM 4.6', slug: 'glm-4.6', efforts: ['low'] }]
      })

      expect(spawn.args).toContain('--model')
      expect(spawn.args).not.toContain('--effort')
    })

    it('requires the custom marker — a legacy stock stamp never matches a declared slug', () => {
      // Legacy custom-provider sessions carry stock stamps (anthropic/sonnet).
      // A provider later declaring a slug named like a stock alias must not
      // start overriding the alias-baked model on their respawn.
      const spawn = buildClaudeCliPtySpawn({
        session: makeSession({
          custom_provider_id: 'prov-1',
          model_provider_id: 'anthropic',
          model_id: 'sonnet',
          model_variant: 'high'
        }),
        worktreePath: '/repo/worktree',
        pendingPrompt: null,
        claudeBinary: 'claude',
        customProviderCommand: 'claudex',
        customProviderModels: [{ id: 'm1', name: 'Sonnet proxy', slug: 'sonnet', efforts: ['high'] }]
      })

      expect(spawn.args).not.toContain('--model')
      expect(spawn.args).not.toContain('--effort')
    })

    it('keeps suppressing --model when the session model matches no declared slug', () => {
      // Stale stock-claude values (pre-feature sessions) must never reach the
      // provider's command.
      const spawn = buildClaudeCliPtySpawn({
        session: makeSession({
          custom_provider_id: 'prov-1',
          model_id: 'sonnet',
          model_variant: 'high'
        }),
        worktreePath: '/repo/worktree',
        pendingPrompt: null,
        claudeBinary: 'claude',
        customProviderCommand: 'claudex',
        customProviderModels: [
          { id: 'm1', name: 'GLM 4.6', slug: 'glm-4.6', efforts: ['low', 'high'] }
        ]
      })

      expect(spawn.args).not.toContain('--model')
      expect(spawn.args).not.toContain('--effort')
    })

    it('suppresses --model/--effort when a custom-model session degrades to plain claude', () => {
      // Provider deleted → bridge passes no customProviderCommand, but the row
      // still carries the proxy slug. Substring normalization would turn
      // 'kimi-sonnet' into --model sonnet on stock claude — must stay out.
      const spawn = buildClaudeCliPtySpawn({
        session: makeSession({
          custom_provider_id: 'prov-deleted',
          model_provider_id: 'custom',
          model_id: 'kimi-sonnet',
          model_variant: 'high'
        }),
        worktreePath: '/repo/worktree',
        pendingPrompt: null,
        claudeBinary: '/usr/local/bin/claude'
      })

      expect(spawn.command).toBe('/usr/local/bin/claude')
      expect(spawn.args).not.toContain('--model')
      expect(spawn.args).not.toContain('--effort')
    })

    it('suppresses ultracode and its xhigh effort when a custom-model session degrades', () => {
      const spawn = buildClaudeCliPtySpawn({
        session: makeSession({
          custom_provider_id: 'prov-deleted',
          model_provider_id: 'custom',
          model_id: 'kimi-sonnet',
          model_variant: 'ultracode'
        }),
        worktreePath: '/repo/worktree',
        pendingPrompt: null,
        claudeBinary: '/usr/local/bin/claude'
      })

      expect(spawn.args).not.toContain('--effort')
      // No ultracode setting either: the settings carry the fullscreen block alone.
      expect(settingsOf(spawn.args)).toEqual({ env: CLAUDE_CLI_FULLSCREEN_ENV })
    })

    it('ignores declared models whose slug is blank', () => {
      const spawn = buildClaudeCliPtySpawn({
        session: makeSession({ model_id: '', model_variant: 'high' }),
        worktreePath: '/repo/worktree',
        pendingPrompt: null,
        claudeBinary: 'claude',
        customProviderCommand: 'claudex',
        customProviderModels: [{ id: 'm1', name: 'Unfinished row', slug: '  ', efforts: ['high'] }]
      })

      expect(spawn.args).not.toContain('--model')
      expect(spawn.args).not.toContain('--effort')
    })

    it('still suppresses the ultracode settings merge for declared provider models', () => {
      const hookSettingsJson = '{"hooks":{"Stop":[{"id":1}]}}'
      const spawn = buildClaudeCliPtySpawn({
        session: makeSession({
          custom_provider_id: 'prov-1',
          model_provider_id: 'custom',
          model_id: 'glm-4.6',
          model_variant: 'ultracode'
        }),
        worktreePath: '/repo/worktree',
        pendingPrompt: null,
        claudeBinary: 'claude',
        hookSettingsJson,
        customProviderCommand: 'claudex',
        customProviderModels: [
          { id: 'm1', name: 'GLM 4.6', slug: 'glm-4.6', efforts: ['low', 'high'] }
        ]
      })

      const settingsIndex = spawn.args.indexOf('--settings')
      expect(spawn.args[settingsIndex + 1]).toBe(withFullscreen(hookSettingsJson))
      expect(spawn.args).not.toContain('--effort')
      // The declared model itself still rides along.
      expect(spawn.args).toContain('--model')
    })

    it('keeps plan-mode permission flags for custom provider spawns', () => {
      process.env.SHELL = '/bin/zsh'
      const spawn = buildClaudeCliPtySpawn({
        session: makeSession({ mode: 'plan' }),
        worktreePath: '/repo/worktree',
        pendingPrompt: null,
        claudeBinary: 'claude',
        customProviderCommand: 'ANTHROPIC_BASE_URL=http://127.0.0.1:8317 claude --model gpt-5'
      })

      expect(spawn.args[0]).toBe('-ilc')
      expect(spawn.args[1]).toBe('ANTHROPIC_BASE_URL=http://127.0.0.1:8317 claude --model gpt-5 "$@"')
      expect(spawn.args[2]).toBe('ANTHROPIC_BASE_URL=http://127.0.0.1:8317')
      expect(spawn.args.slice(3, 6)).toEqual([
        '--allow-dangerously-skip-permissions',
        '--permission-mode',
        'plan'
      ])
    })

    it('falls back to the plain claude spawn when the custom command is blank', () => {
      const spawn = buildClaudeCliPtySpawn({
        session: makeSession(),
        worktreePath: '/repo/worktree',
        pendingPrompt: null,
        claudeBinary: '/usr/local/bin/claude',
        customProviderCommand: '   '
      })

      expect(spawn.command).toBe('/usr/local/bin/claude')
    })
  })

  describe('fullscreen renderer', () => {
    const originalScrollSpeed = process.env.CLAUDE_CODE_SCROLL_SPEED
    const originalShell = process.env.SHELL

    beforeEach(() => {
      delete process.env.CLAUDE_CODE_SCROLL_SPEED
    })

    afterEach(() => {
      if (originalScrollSpeed === undefined) delete process.env.CLAUDE_CODE_SCROLL_SPEED
      else process.env.CLAUDE_CODE_SCROLL_SPEED = originalScrollSpeed
      if (originalShell === undefined) delete process.env.SHELL
      else process.env.SHELL = originalShell
    })

    /** A database whose Settings hold these environment variables. */
    function dbWithEnvVars(vars: Record<string, string>): { getSetting(key: string): string | null } {
      const environmentVariables = Object.entries(vars).map(([key, value]) => ({ key, value }))
      return {
        getSetting: (key) =>
          key === APP_SETTINGS_DB_KEY ? JSON.stringify({ environmentVariables }) : null
      }
    }

    it('asks for fullscreen with the variable that wins over a saved `tui` setting', () => {
      // CLAUDE_CODE_NO_FLICKER=1 beats `tui: "default"` in any settings file, and
      // CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN beats both when on, so it is turned off.
      expect(CLAUDE_CLI_FULLSCREEN_ENV).toEqual({
        CLAUDE_CODE_NO_FLICKER: '1',
        CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN: '0'
      })
    })

    // Every interactive Claude session the app shows comes out of this builder: what differs
    // between the ways of starting one is the session row and the prompt.
    it.each([
      ['a new session with a prompt (ticket launch, handoff)', {}, 'Implement the ticket'],
      ['a new session without a prompt (session tab)', {}, null],
      ['a plan-mode session', { mode: 'plan' as const }, 'Plan the ticket'],
      ['a super-plan session', { mode: 'super-plan' as const }, 'Plan the ticket'],
      ['a resumed session (restart, reopened ticket)', { claude_session_id: 'claude-uuid-1' }, null],
      [
        'a resumed session with a follow-up',
        { claude_session_id: 'claude-uuid-1' },
        'One more thing'
      ],
      ['an ultracode session', { model_id: 'opus', model_variant: 'ultracode' }, 'Go']
    ])('starts %s in fullscreen', (_name, session, pendingPrompt) => {
      const spawn = buildClaudeCliPtySpawn({
        session: makeSession(session),
        worktreePath: '/repo/worktree',
        pendingPrompt,
        claudeBinary: 'claude',
        hookSettingsJson: '{"hooks":{"Stop":[{"id":1}]}}'
      })

      expect(spawn.env).toMatchObject(CLAUDE_CLI_FULLSCREEN_ENV)
      const settings = settingsOf(spawn.args)
      expect(settings?.env).toEqual(CLAUDE_CLI_FULLSCREEN_ENV)
      // The hook config the app's ticket states depend on is still there.
      expect(settings?.hooks).toEqual({ Stop: [{ id: 1 }] })
      // The saved renderer is overridden for this process only: no `tui` key is passed, and
      // nothing is written to a settings file.
      expect(settings).not.toHaveProperty('tui')
      if (pendingPrompt) expect(spawn.args.at(-1)).toBe(pendingPrompt)
    })

    it('starts a custom provider command in fullscreen', () => {
      process.env.SHELL = '/bin/zsh'
      const spawn = buildClaudeCliPtySpawn({
        session: makeSession({ custom_provider_id: 'prov-1' }),
        worktreePath: '/repo/worktree',
        pendingPrompt: 'Go',
        claudeBinary: null,
        hookSettingsJson: '{"hooks":{}}',
        customProviderCommand: 'claudex'
      })

      expect(spawn.command).toBe('/bin/zsh')
      expect(spawn.env).toMatchObject(CLAUDE_CLI_FULLSCREEN_ENV)
      expect(settingsOf(spawn.args)?.env).toEqual(CLAUDE_CLI_FULLSCREEN_ENV)
    })

    it("holds against the user's own environment variables from Settings", () => {
      const spawn = buildClaudeCliPtySpawn({
        session: makeSession(),
        worktreePath: '/repo/worktree',
        pendingPrompt: 'Go',
        claudeBinary: 'claude',
        db: dbWithEnvVars({
          CLAUDE_CODE_NO_FLICKER: '0',
          CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN: '1',
          MY_TOKEN: 'abc'
        }) as never
      })

      expect(spawn.env.CLAUDE_CODE_NO_FLICKER).toBe('1')
      expect(spawn.env.CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN).toBe('0')
      // The rest of the user's variables are passed as before.
      expect(spawn.env.MY_TOKEN).toBe('abc')
    })

    it('keeps the other variables of an env block the hook settings already carry', () => {
      const spawn = buildClaudeCliPtySpawn({
        session: makeSession(),
        worktreePath: '/repo/worktree',
        pendingPrompt: null,
        claudeBinary: 'claude',
        hookSettingsJson: '{"hooks":{},"env":{"KEEP_ME":"1","CLAUDE_CODE_NO_FLICKER":"0"}}'
      })

      expect(settingsOf(spawn.args)?.env).toEqual({ KEEP_ME: '1', ...CLAUDE_CLI_FULLSCREEN_ENV })
    })

    it('still asks for fullscreen when the hook settings cannot be parsed', () => {
      const spawn = buildClaudeCliPtySpawn({
        session: makeSession(),
        worktreePath: '/repo/worktree',
        pendingPrompt: null,
        claudeBinary: 'claude',
        hookSettingsJson: '{not json'
      })

      expect(settingsOf(spawn.args)).toEqual({ env: CLAUDE_CLI_FULLSCREEN_ENV })
    })

    it('leaves the renderer alone when asked to inherit it (the tmux launch on a remote server)', () => {
      const hookSettingsJson = '{"hooks":{"Stop":[{"id":1}]}}'
      const spawn = buildClaudeCliPtySpawn({
        session: makeSession({ claude_session_id: 'claude-uuid-1' }),
        worktreePath: '/repo/worktree',
        claudeBinary: 'claude',
        hookSettingsJson,
        renderer: 'inherit'
      })

      expect(spawn.env).not.toHaveProperty('CLAUDE_CODE_NO_FLICKER')
      expect(spawn.env).not.toHaveProperty('CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN')
      expect(spawn.env).not.toHaveProperty('CLAUDE_CODE_SCROLL_SPEED')
      // The hook settings go through untouched, byte for byte.
      expect(spawn.args).toEqual([
        '--dangerously-skip-permissions',
        '--model',
        'sonnet',
        '--effort',
        'high',
        '--resume',
        'claude-uuid-1',
        '--settings',
        hookSettingsJson
      ])

      const bare = buildClaudeCliPtySpawn({
        session: makeSession(),
        worktreePath: '/repo/worktree',
        claudeBinary: 'claude',
        renderer: 'inherit'
      })
      expect(bare.args).not.toContain('--settings')
    })

    describe('wheel scroll speed', () => {
      it('defaults to the speed Claude Code uses for xterm.js', () => {
        const spawn = buildClaudeCliPtySpawn({
          session: makeSession(),
          worktreePath: '/repo/worktree',
          pendingPrompt: null,
          claudeBinary: 'claude'
        })

        expect(CLAUDE_CLI_DEFAULT_SCROLL_SPEED).toBe('3')
        expect(spawn.env.CLAUDE_CODE_SCROLL_SPEED).toBe('3')
      })

      it('stays out of the settings JSON, so a speed saved in a settings file wins', () => {
        const spawn = buildClaudeCliPtySpawn({
          session: makeSession(),
          worktreePath: '/repo/worktree',
          pendingPrompt: null,
          claudeBinary: 'claude'
        })

        expect(settingsOf(spawn.args)?.env).not.toHaveProperty('CLAUDE_CODE_SCROLL_SPEED')
      })

      it("is not set over a speed in the app's own environment", () => {
        process.env.CLAUDE_CODE_SCROLL_SPEED = '5'
        const spawn = buildClaudeCliPtySpawn({
          session: makeSession(),
          worktreePath: '/repo/worktree',
          pendingPrompt: null,
          claudeBinary: 'claude'
        })

        // Absent from the spawn's overrides: the PTY inherits the 5 from the process.
        expect(spawn.env).not.toHaveProperty('CLAUDE_CODE_SCROLL_SPEED')
      })

      it("gives way to a speed in the user's environment variables from Settings", () => {
        const spawn = buildClaudeCliPtySpawn({
          session: makeSession(),
          worktreePath: '/repo/worktree',
          pendingPrompt: null,
          claudeBinary: 'claude',
          db: dbWithEnvVars({ CLAUDE_CODE_SCROLL_SPEED: '1' }) as never
        })

        expect(spawn.env.CLAUDE_CODE_SCROLL_SPEED).toBe('1')
      })
    })
  })
})
