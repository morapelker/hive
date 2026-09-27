import { describe, expect, it, vi } from 'vitest'
import type { Session } from '../../db/types'

vi.mock('../env-vars', () => ({
  getUserEnvironmentVariables: vi.fn(() => ({ CODEX_HOME: '/Users/me/.codex-alt' }))
}))

import {
  buildCodexCliPtySpawn,
  buildCodexModelMigrationOverride,
  buildCodexTrustOverride,
  normalizeCodexCliEffort,
  normalizeCodexCliModel,
  requiresPtyPromptDelivery
} from '../codex-cli-spawner'

const noUpgrade = (): string | null => null

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
    custom_provider_id: null,
    mode: 'build',
    session_type: 'default',
    model_provider_id: 'codex',
    model_id: 'gpt-5.5',
    model_variant: 'high',
    remote_launch: null,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    completed_at: null,
    pinned_to_board: false,
    ...overrides
  }
}

describe('normalizers', () => {
  it('accepts codex efforts and rejects claude-only / unknown values', () => {
    expect(normalizeCodexCliEffort('HIGH')).toBe('high')
    expect(normalizeCodexCliEffort('xhigh')).toBe('xhigh')
    expect(normalizeCodexCliEffort('ultra')).toBe('ultra')
    expect(normalizeCodexCliEffort('ultracode')).toBeNull()
    expect(normalizeCodexCliEffort(null)).toBeNull()
  })

  it('resolves model aliases to codex slugs and passes unknown slugs through', () => {
    expect(normalizeCodexCliModel('5.5')).toBe('gpt-5.5')
    expect(normalizeCodexCliModel('gpt-5.3')).toBe('gpt-5.3-codex')
    expect(normalizeCodexCliModel('gpt-5.4-mini')).toBe('gpt-5.4-mini')
    expect(normalizeCodexCliModel(null)).toBeNull()
  })

  it('decides which prompts must go through the composer instead of argv', () => {
    expect(requiresPtyPromptDelivery('Fix the bug', 'build')).toBe(false)
    expect(requiresPtyPromptDelivery('Fix the bug', 'plan')).toBe(true)
    expect(requiresPtyPromptDelivery('Fix the bug', 'super-plan')).toBe(true)
    expect(requiresPtyPromptDelivery('/goal ship it', 'build')).toBe(true)
    expect(requiresPtyPromptDelivery('   ', 'plan')).toBe(false)
    expect(requiresPtyPromptDelivery(null, 'plan')).toBe(false)
  })
})

describe('buildCodexTrustOverride', () => {
  it('pre-trusts every distinct path in one inline projects table', () => {
    expect(
      buildCodexTrustOverride(
        ['/Users/me/dev/app', '/Users/me/.hive-worktrees/app/wt-1', '/Users/me/dev/app', null],
        (p) => p
      )
    ).toBe(
      'projects={"/Users/me/dev/app"={trust_level="trusted"},"/Users/me/.hive-worktrees/app/wt-1"={trust_level="trusted"}}'
    )
    expect(buildCodexTrustOverride([null, undefined, ''])).toBeNull()
  })

  it('also trusts the symlink-resolved form codex keys trust by', () => {
    expect(buildCodexTrustOverride(['/tmp/x'], (p) => `/private${p}`)).toBe(
      'projects={"/tmp/x"={trust_level="trusted"},"/private/tmp/x"={trust_level="trusted"}}'
    )
  })
})

describe('buildCodexCliPtySpawn', () => {
  it('builds a fresh build-mode launch with bypass, model, effort, trust, hooks and the argv prompt', () => {
    const spawn = buildCodexCliPtySpawn({
      session: makeSession(),
      worktreePath: '/repo/wt',
      projectPath: '/repo',
      pendingPrompt: '  Implement the ticket  ',
      codexBinary: '/opt/homebrew/bin/codex',
      hookOverrideArgs: ['-c', 'hooks.Stop=[…]', '-c', 'hooks.state={…}'],
      readModelUpgradeTarget: noUpgrade
    })

    expect(spawn.command).toBe('/opt/homebrew/bin/codex')
    expect(spawn.cwd).toBe('/repo/wt')
    expect(spawn.promptViaPty).toBeNull()
    expect(spawn.args).toEqual([
      '--dangerously-bypass-approvals-and-sandbox',
      '-c',
      'check_for_update_on_startup=false',
      '-m',
      'gpt-5.5',
      '-c',
      'model_reasoning_effort="high"',
      '-c',
      expect.stringMatching(/^projects=\{"\/repo"=\{trust_level="trusted"\}.*"\/repo\/wt"=\{trust_level="trusted"\}/),
      '-c',
      'hooks.Stop=[…]',
      '-c',
      'hooks.state={…}',
      'Implement the ticket'
    ])
    expect(spawn.env).toEqual({ CODEX_HOME: '/Users/me/.codex-alt' })
  })

  it('resumes a known thread with `resume <id>` first and still accepts a prompt', () => {
    const spawn = buildCodexCliPtySpawn({
      session: makeSession({ claude_session_id: '01a07dbd-6a11-7982-a2b6-ceaa43736708' }),
      worktreePath: '/repo/wt',
      pendingPrompt: 'continue',
      readModelUpgradeTarget: noUpgrade
    })
    expect(spawn.args.slice(0, 3)).toEqual([
      'resume',
      '01a07dbd-6a11-7982-a2b6-ceaa43736708',
      '--dangerously-bypass-approvals-and-sandbox'
    ])
    expect(spawn.args.at(-1)).toBe('continue')
  })

  it('ignores a pending:: placeholder id and an explicit override wins over the row', () => {
    expect(
      buildCodexCliPtySpawn({
        session: makeSession({ claude_session_id: 'pending::abc' }),
        worktreePath: '/repo/wt'
      }).args
    ).not.toContain('resume')
    expect(
      buildCodexCliPtySpawn({
        session: makeSession({ claude_session_id: 'row-id' }),
        worktreePath: '/repo/wt',
        codexSessionId: 'override-id'
      }).args.slice(0, 2)
    ).toEqual(['resume', 'override-id'])
  })

  it('withholds plan-mode and slash prompts from argv for composer delivery', () => {
    const plan = buildCodexCliPtySpawn({
      session: makeSession({ mode: 'plan' }),
      worktreePath: '/repo/wt',
      pendingPrompt: 'Plan the refactor'
    })
    expect(plan.promptViaPty).toBe('Plan the refactor')
    expect(plan.args).not.toContain('Plan the refactor')

    const goal = buildCodexCliPtySpawn({
      session: makeSession(),
      worktreePath: '/repo/wt',
      pendingPrompt: '/goal ship the feature'
    })
    expect(goal.promptViaPty).toBe('/goal ship the feature')
    expect(goal.args.some((a) => a.startsWith('/goal'))).toBe(false)
  })

  it('pre-acknowledges a deprecated model\'s migration prompt so the launch is not blocked', () => {
    expect(buildCodexModelMigrationOverride('gpt-5.4-mini', 'gpt-6-luna')).toBe(
      'notice.model_migrations={"gpt-5.4-mini"="gpt-6-luna"}'
    )
    expect(buildCodexModelMigrationOverride('gpt-5.5', null)).toBeNull()
    const spawn = buildCodexCliPtySpawn({
      session: makeSession({ model_id: 'gpt-5.4-mini' }),
      worktreePath: '/repo/wt',
      readModelUpgradeTarget: (model) => (model === 'gpt-5.4-mini' ? 'gpt-6-luna' : null)
    })
    const at = spawn.args.indexOf('gpt-5.4-mini')
    expect(spawn.args[at - 1]).toBe('-m')
    expect(spawn.args[at + 1]).toBe('-c')
    expect(spawn.args[at + 2]).toBe('notice.model_migrations={"gpt-5.4-mini"="gpt-6-luna"}')
  })

  it('drops unknown efforts and models, and defaults the binary to `codex`', () => {
    const spawn = buildCodexCliPtySpawn({
      session: makeSession({ model_id: null, model_variant: 'ultracode' }),
      worktreePath: '/repo/wt'
    })
    expect(spawn.command).toBe('codex')
    expect(spawn.args).not.toContain('-m')
    expect(spawn.args.some((a) => a.startsWith('model_reasoning_effort'))).toBe(false)
  })
})
