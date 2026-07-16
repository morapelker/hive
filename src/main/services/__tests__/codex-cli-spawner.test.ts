import { afterEach, describe, expect, it } from 'vitest'
import type { Session } from '../../db/types'
import {
  buildCodexCliPtySpawn,
  isWindowsShimBinary,
  normalizeCodexCliEffort
} from '../codex-cli-spawner'

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
  it('accepts every canonical ReasoningEffort value (case-insensitively)', () => {
    for (const effort of ['none', 'minimal', 'low', 'medium', 'high', 'xhigh']) {
      expect(normalizeCodexCliEffort(effort)).toBe(effort)
      expect(normalizeCodexCliEffort(effort.toUpperCase())).toBe(effort)
    }
  })

  it('rejects values outside the Codex effort enum', () => {
    // `ultra`/`max` are not part of the codex schema — passing them would make
    // codex fall back to its default effort, so they must normalize to null.
    expect(normalizeCodexCliEffort('ultra')).toBeNull()
    expect(normalizeCodexCliEffort('max')).toBeNull()
    expect(normalizeCodexCliEffort('ultracode')).toBeNull()
    expect(normalizeCodexCliEffort(null)).toBeNull()
    expect(normalizeCodexCliEffort(undefined)).toBeNull()
  })
})

describe('isWindowsShimBinary', () => {
  const realPlatform = process.platform
  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: realPlatform })
  })

  it('flags .cmd/.bat/.com shims only on win32 (drives shell wrapping for text generation)', () => {
    Object.defineProperty(process, 'platform', { value: 'win32' })
    expect(isWindowsShimBinary('C:/npm/codex.cmd')).toBe(true)
    expect(isWindowsShimBinary('C:/npm/codex.BAT')).toBe(true)
    expect(isWindowsShimBinary('C:/npm/codex.com')).toBe(true)
    expect(isWindowsShimBinary('C:/bun/codex.exe')).toBe(false)
    expect(isWindowsShimBinary('C:/bun/codex')).toBe(false)
  })

  it('is always false off win32 (POSIX runs the binary directly)', () => {
    Object.defineProperty(process, 'platform', { value: 'darwin' })
    expect(isWindowsShimBinary('/usr/local/bin/codex.cmd')).toBe(false)
    expect(isWindowsShimBinary('/usr/local/bin/codex')).toBe(false)
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

  describe('Windows shim binaries', () => {
    const realPlatform = process.platform
    const realComspec = process.env.COMSPEC

    afterEach(() => {
      Object.defineProperty(process, 'platform', { value: realPlatform })
      if (realComspec === undefined) delete process.env.COMSPEC
      else process.env.COMSPEC = realComspec
    })

    it('wraps a .cmd shim through the command processor on Windows', () => {
      Object.defineProperty(process, 'platform', { value: 'win32' })
      process.env.COMSPEC = 'C:\\Windows\\System32\\cmd.exe'

      const spawn = buildCodexCliPtySpawn({
        session: makeSession({ model_id: null }),
        worktreePath: 'C:/repo',
        codexBinary: 'C:/Users/x/AppData/npm/codex.cmd',
        pendingPrompt: 'do it'
      })

      expect(spawn.command).toBe('C:\\Windows\\System32\\cmd.exe')
      expect(spawn.args.slice(0, 2)).toEqual(['/c', 'C:/Users/x/AppData/npm/codex.cmd'])
      expect(spawn.args).toContain('--dangerously-bypass-approvals-and-sandbox')
      expect(spawn.args[spawn.args.length - 1]).toBe('do it')
    })

    it('spawns a real .exe directly (no wrapper) on Windows', () => {
      Object.defineProperty(process, 'platform', { value: 'win32' })
      const spawn = buildCodexCliPtySpawn({
        session: makeSession({ model_id: null }),
        worktreePath: 'C:/repo',
        codexBinary: 'C:/Users/x/.bun/bin/codex.exe'
      })
      expect(spawn.command).toBe('C:/Users/x/.bun/bin/codex.exe')
      expect(spawn.args[0]).toBe('--dangerously-bypass-approvals-and-sandbox')
    })
  })
})
