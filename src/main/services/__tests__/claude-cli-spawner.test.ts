import { describe, expect, it } from 'vitest'
import type { Session } from '../../db/types'
import {
  buildClaudeCliPtySpawn,
  isUltracodeEffort,
  normalizeClaudeCliModel
} from '../claude-cli-spawner'

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
    expect(normalizeClaudeCliModel('claude-fable-5')).toBe('fable')
    expect(normalizeClaudeCliModel('claude-sonnet-4')).toBe('sonnet')
    expect(normalizeClaudeCliModel('claude-opus-4-5-20251101')).toBe('opus')
    expect(normalizeClaudeCliModel('claude-haiku-4-5-20251001')).toBe('haiku')
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
      'Implement this plan'
    ])
  })

  it('passes the Fable model category through to Claude CLI', () => {
    const spawn = buildClaudeCliPtySpawn({
      session: makeSession({
        model_id: 'claude-fable-5',
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
      'max'
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
      'max'
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

    expect(spawn.args).toEqual(['--dangerously-skip-permissions'])
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
      hookSettingsJson,
      'Implement this plan'
    ])
  })

  it('omits the settings flag when hook settings are absent', () => {
    const spawn = buildClaudeCliPtySpawn({
      session: makeSession(),
      worktreePath: '/repo/worktree',
      pendingPrompt: 'Say hi',
      claudeBinary: 'claude'
    })

    expect(spawn.args).not.toContain('--settings')
    expect(spawn.args.at(-1)).toBe('Say hi')
  })

  it('recognizes the ultracode effort case-insensitively', () => {
    expect(isUltracodeEffort('ultracode')).toBe(true)
    expect(isUltracodeEffort('UltraCode')).toBe(true)
    expect(isUltracodeEffort('xhigh')).toBe(false)
    expect(isUltracodeEffort(null)).toBe(false)
    expect(isUltracodeEffort(undefined)).toBe(false)
  })

  it('enables ultracode via the settings flag, preserves hooks, and omits --effort', () => {
    const hookSettingsJson = '{"hooks":{"Stop":[{"id":1}]}}'
    const spawn = buildClaudeCliPtySpawn({
      session: makeSession({ model_id: 'opus', model_variant: 'ultracode' }),
      worktreePath: '/repo/worktree',
      pendingPrompt: 'Go',
      claudeBinary: 'claude',
      hookSettingsJson
    })

    // ultracode rides in --settings; it is never passed as a --effort value.
    expect(spawn.args).not.toContain('--effort')
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

    expect(spawn.args).not.toContain('--effort')
    const settingsIndex = spawn.args.indexOf('--settings')
    expect(settingsIndex).toBeGreaterThanOrEqual(0)
    expect(JSON.parse(spawn.args[settingsIndex + 1])).toEqual({ ultracode: true })
  })
})
