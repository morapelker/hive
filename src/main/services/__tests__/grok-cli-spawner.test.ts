import { describe, expect, it } from 'vitest'
import type { Session } from '../../db/types'
import {
  buildGrokCliPtySpawn,
  normalizeGrokCliEffort,
  normalizeGrokCliModel
} from '../grok-cli-spawner'

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
    agent_sdk: 'grok-cli',
    mode: 'build',
    session_type: 'default',
    model_provider_id: 'xai',
    model_id: 'grok-4.5',
    model_variant: null,
    remote_launch: null,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    completed_at: null,
    pinned_to_board: false,
    ...overrides
  }
}

describe('normalizeGrokCliModel', () => {
  it('passes grok-family ids through lowercased and rejects foreign ids', () => {
    expect(normalizeGrokCliModel('grok-4.5')).toBe('grok-4.5')
    expect(normalizeGrokCliModel('Grok-4.5')).toBe('grok-4.5')
    expect(normalizeGrokCliModel('sonnet')).toBeNull()
    expect(normalizeGrokCliModel('claude-opus-4-5-20251101')).toBeNull()
    expect(normalizeGrokCliModel(null)).toBeNull()
    expect(normalizeGrokCliModel(undefined)).toBeNull()
    // Charset gate: a DB-sourced id must not smuggle shell metacharacters
    // into the win32 cmd.exe shim wrap.
    expect(normalizeGrokCliModel('grok&calc')).toBeNull()
    expect(normalizeGrokCliModel('grok|x')).toBeNull()
    expect(normalizeGrokCliModel('grok %PATH%')).toBeNull()
  })
})

describe('normalizeGrokCliEffort', () => {
  it('accepts exactly grok effort levels and drops foreign variants', () => {
    expect(normalizeGrokCliEffort('high')).toBe('high')
    expect(normalizeGrokCliEffort('Medium')).toBe('medium')
    expect(normalizeGrokCliEffort('low')).toBe('low')
    // Cross-provider handoffs can leave claude/codex variants on the row.
    expect(normalizeGrokCliEffort('xhigh')).toBeNull()
    expect(normalizeGrokCliEffort('max')).toBeNull()
    expect(normalizeGrokCliEffort('ultracode')).toBeNull()
    expect(normalizeGrokCliEffort(null)).toBeNull()
  })
})

describe('buildGrokCliPtySpawn', () => {
  it('build mode spawns with --always-approve only', () => {
    const spawn = buildGrokCliPtySpawn({
      session: makeSession(),
      worktreePath: '/repo/feature'
    })
    expect(spawn.command).toBe('grok')
    expect(spawn.args).toEqual(['--always-approve', '--model', 'grok-4.5'])
    expect(spawn.cwd).toBe('/repo/feature')
  })

  it('passes a valid model_variant as --reasoning-effort and drops foreign ones', () => {
    const withEffort = buildGrokCliPtySpawn({
      session: makeSession({ model_variant: 'medium' }),
      worktreePath: '/repo/feature'
    })
    expect(withEffort.args).toEqual([
      '--always-approve',
      '--model',
      'grok-4.5',
      '--reasoning-effort',
      'medium'
    ])

    const foreign = buildGrokCliPtySpawn({
      session: makeSession({ model_variant: 'xhigh' }),
      worktreePath: '/repo/feature'
    })
    expect(foreign.args).not.toContain('--reasoning-effort')
  })

  it('plan mode spawns with --always-approve only (plan is activated in the TUI, not via flags)', () => {
    // --permission-mode plan is a Claude-compat no-op on grok that clobbers
    // --always-approve (verified on 0.2.101); the pty bridge arms plan mode
    // with Shift+Tab keystrokes instead.
    const spawn = buildGrokCliPtySpawn({
      session: makeSession({ mode: 'plan', model_id: null }),
      worktreePath: '/repo/feature'
    })
    expect(spawn.args).toEqual(['--always-approve'])
  })

  it('super-plan spawns like plan', () => {
    const spawn = buildGrokCliPtySpawn({
      session: makeSession({ mode: 'super-plan', model_id: null }),
      worktreePath: '/repo/feature'
    })
    expect(spawn.args).toEqual(['--always-approve'])
  })

  it('omits --model for non-grok model ids (e.g. after a cross-provider handoff)', () => {
    const spawn = buildGrokCliPtySpawn({
      session: makeSession({ model_id: 'sonnet' }),
      worktreePath: '/repo/feature'
    })
    expect(spawn.args).not.toContain('--model')
  })

  it('resumes with the stored session id, preferring the explicit override', () => {
    const stored = buildGrokCliPtySpawn({
      session: makeSession({ claude_session_id: 'stored-id', model_id: null }),
      worktreePath: '/repo/feature'
    })
    expect(stored.args).toEqual(['--always-approve', '--resume', 'stored-id'])

    const override = buildGrokCliPtySpawn({
      session: makeSession({ claude_session_id: 'stored-id', model_id: null }),
      grokSessionId: 'override-id',
      worktreePath: '/repo/feature'
    })
    expect(override.args).toEqual(['--always-approve', '--resume', 'override-id'])
  })

  it('appends the pending prompt as the final positional arg', () => {
    const spawn = buildGrokCliPtySpawn({
      session: makeSession({ model_id: null }),
      worktreePath: '/repo/feature',
      pendingPrompt: '  do the thing  '
    })
    expect(spawn.args[spawn.args.length - 1]).toBe('do the thing')
  })

  it('exports the hook callback URL as HIVE_GROK_HOOK_URL', () => {
    const spawn = buildGrokCliPtySpawn({
      session: makeSession(),
      worktreePath: '/repo/feature',
      hookUrlBase: 'http://127.0.0.1:4242/grok-hook/hive-session-1'
    })
    expect(spawn.env.HIVE_GROK_HOOK_URL).toBe('http://127.0.0.1:4242/grok-hook/hive-session-1')
  })

  it('binary path override is used as the command', () => {
    const spawn = buildGrokCliPtySpawn({
      session: makeSession(),
      worktreePath: '/repo/feature',
      grokBinary: '/usr/local/bin/grok'
    })
    expect(spawn.command).toBe('/usr/local/bin/grok')
  })
})
