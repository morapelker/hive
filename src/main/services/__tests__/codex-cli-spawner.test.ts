import { describe, expect, it } from 'vitest'
import type { Session } from '../../db/types'
import { buildCodexCliPtySpawn, normalizeCodexCliEffort } from '../codex-cli-spawner'

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
    agent_sdk: 'codex-cli',
    mode: 'build',
    session_type: 'default',
    model_provider_id: 'codex',
    model_id: 'gpt-5.5',
    model_variant: null,
    remote_launch: null,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    completed_at: null,
    pinned_to_board: false,
    ...overrides
  }
}

describe('normalizeCodexCliEffort', () => {
  it('accepts codex reasoning efforts and rejects anything else', () => {
    expect(normalizeCodexCliEffort('high')).toBe('high')
    expect(normalizeCodexCliEffort('ULTRA')).toBe('ultra')
    expect(normalizeCodexCliEffort('ultracode')).toBeNull()
    expect(normalizeCodexCliEffort(null)).toBeNull()
    expect(normalizeCodexCliEffort(undefined)).toBeNull()
  })
})

describe('buildCodexCliPtySpawn', () => {
  it('spawns yolo with update-check suppression and worktree trust in every mode', () => {
    const spawn = buildCodexCliPtySpawn({
      session: makeSession({ model_id: null }),
      worktreePath: '/repo/feature'
    })
    expect(spawn.command).toBe('codex')
    expect(spawn.cwd).toBe('/repo/feature')
    expect(spawn.args).toEqual([
      '--dangerously-bypass-approvals-and-sandbox',
      '-c',
      'check_for_update_on_startup=false',
      '-c',
      'projects={"/repo/feature"={trust_level="trusted"}}'
    ])
  })

  it('plan mode uses the same args (plan is activated in the TUI, not via flags)', () => {
    const spawn = buildCodexCliPtySpawn({
      session: makeSession({ mode: 'plan', model_id: null }),
      worktreePath: '/repo/feature'
    })
    expect(spawn.args[0]).toBe('--dangerously-bypass-approvals-and-sandbox')
    expect(spawn.args).not.toContain('--permission-mode')
  })

  it('passes model and reasoning effort as codex flags', () => {
    const spawn = buildCodexCliPtySpawn({
      session: makeSession({ model_id: 'gpt-5.6-sol', model_variant: 'xhigh' }),
      worktreePath: '/repo/feature'
    })
    expect(spawn.args).toContain('-m')
    expect(spawn.args[spawn.args.indexOf('-m') + 1]).toBe('gpt-5.6-sol')
    expect(spawn.args).toContain('model_reasoning_effort="xhigh"')
  })

  it('resumes via the resume subcommand with the persisted thread id', () => {
    const spawn = buildCodexCliPtySpawn({
      session: makeSession({ claude_session_id: '019f-thread' }),
      worktreePath: '/repo/feature'
    })
    expect(spawn.args.slice(0, 2)).toEqual(['resume', '019f-thread'])
  })

  it('appends hook args and the prompt as the final positional arg', () => {
    const spawn = buildCodexCliPtySpawn({
      session: makeSession({ model_id: null }),
      worktreePath: '/repo/feature',
      hookArgs: ['--enable', 'hooks'],
      pendingPrompt: 'Fix the bug'
    })
    expect(spawn.args.slice(-3)).toEqual(['--enable', 'hooks', 'Fix the bug'])
  })

  it('escapes quotes and backslashes in the trust override path', () => {
    const spawn = buildCodexCliPtySpawn({
      session: makeSession({ model_id: null }),
      worktreePath: '/repo/we"ird\\path'
    })
    expect(spawn.args).toContain(
      'projects={"/repo/we\\"ird\\\\path"={trust_level="trusted"}}'
    )
  })
})
