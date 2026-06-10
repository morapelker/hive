/* eslint-disable @typescript-eslint/no-explicit-any */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  autoRenameWorktreeBranch: vi.fn(),
  emitWorktreeBranchRenamed: vi.fn(),
  publishDesktopBackendEvent: vi.fn()
}))

vi.mock('../logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() })
}))

vi.mock('../git-service', () => ({
  autoRenameWorktreeBranch: mocks.autoRenameWorktreeBranch
}))

vi.mock('../../desktop/backend-event-publisher', () => ({
  publishDesktopBackendEvent: mocks.publishDesktopBackendEvent
}))

vi.mock('../worktree-events', () => ({
  emitWorktreeBranchRenamed: mocks.emitWorktreeBranchRenamed
}))

import {
  applyClaudeCliTitle,
  processClaudeCliPtyData,
  resetAllClaudeCliTitleState,
  resetClaudeCliTitleState
} from '../claude-cli-title-handler'

const BEL = '\x07'
const ESC = '\x1b'
const ST = `${ESC}\\`

function osc(code: 0 | 1 | 2, title: string, terminator: string = BEL): string {
  return `${ESC}]${code};${title}${terminator}`
}

describe('processClaudeCliPtyData — OSC parsing', () => {
  beforeEach(() => {
    resetAllClaudeCliTitleState()
  })

  it('extracts an OSC 0 title terminated by BEL', () => {
    expect(processClaudeCliPtyData('s1', osc(0, 'Fix the README'))).toBe('Fix the README')
  })

  it('extracts an OSC 2 title terminated by BEL', () => {
    expect(processClaudeCliPtyData('s1', osc(2, 'Refactor auth flow'))).toBe('Refactor auth flow')
  })

  it('extracts an OSC 0 title terminated by ST', () => {
    expect(processClaudeCliPtyData('s1', osc(0, 'Add tests', ST))).toBe('Add tests')
  })

  it('ignores OSC 1 (icon name only)', () => {
    expect(processClaudeCliPtyData('s1', osc(1, 'Should be ignored'))).toBeNull()
  })

  it('returns null when no OSC is present', () => {
    expect(processClaudeCliPtyData('s1', 'plain shell output with \x1b[31mansi color\x1b[0m')).toBeNull()
  })

  it('handles OSC split across two chunks', () => {
    expect(processClaudeCliPtyData('s1', `${ESC}]2;ho`)).toBeNull()
    expect(processClaudeCliPtyData('s1', `me-page${BEL}`)).toBe('home-page')
  })

  it('does not lose the title when an unterminated tail precedes it', () => {
    expect(processClaudeCliPtyData('s1', `prefix ${ESC}]2;par`)).toBeNull()
    expect(processClaudeCliPtyData('s1', `tial${BEL}`)).toBe('partial')
  })
})

describe('processClaudeCliPtyData — noise filter', () => {
  beforeEach(() => {
    resetAllClaudeCliTitleState()
  })

  it('rejects the literal "claude" (case-insensitive)', () => {
    expect(processClaudeCliPtyData('s1', osc(2, 'claude'))).toBeNull()
    expect(processClaudeCliPtyData('s2', osc(2, 'Claude'))).toBeNull()
  })

  it('rejects "Claude Code" boilerplate even when prefixed by a spinner glyph', () => {
    expect(processClaudeCliPtyData('s1', osc(0, '⠐ Claude Code'))).toBeNull()
    expect(processClaudeCliPtyData('s2', osc(0, '⠋ Claude Code'))).toBeNull()
  })

  it('rejects empty / whitespace titles', () => {
    expect(processClaudeCliPtyData('s1', osc(2, ''))).toBeNull()
    expect(processClaudeCliPtyData('s2', osc(2, '   '))).toBeNull()
    expect(processClaudeCliPtyData('s3', osc(2, '⠐  '))).toBeNull()
  })

  it('strips leading spinner glyph + whitespace and accepts the remainder', () => {
    expect(processClaudeCliPtyData('s1', osc(0, '⠐ Explore project structure'))).toBe(
      'Explore project structure'
    )
    expect(processClaudeCliPtyData('s2', osc(2, '✻ Build the parser'))).toBe('Build the parser')
    expect(processClaudeCliPtyData('s3', osc(2, '⠋ Refactor auth'))).toBe('Refactor auth')
  })

  it('treats the entire Braille Patterns block (U+2800–U+28FF) as a spinner', () => {
    // sample a glyph not in any obvious spinner cycle
    expect(processClaudeCliPtyData('s1', osc(2, '⣿ Some title'))).toBe('Some title')
  })

  it('rejects absolute path titles', () => {
    expect(processClaudeCliPtyData('s1', osc(2, '/Users/mor/repo'))).toBeNull()
    expect(processClaudeCliPtyData('s2', osc(2, '~/repo/worktree'))).toBeNull()
  })

  it('rejects the worktree basename when provided (also after spinner strip)', () => {
    expect(
      processClaudeCliPtyData('s1', osc(2, 'my-worktree'), { worktreeBasename: 'my-worktree' })
    ).toBeNull()
    expect(
      processClaudeCliPtyData('s2', osc(2, '⠐ my-worktree'), { worktreeBasename: 'my-worktree' })
    ).toBeNull()
  })

  it('walks past noise to the first acceptable title in the same chunk', () => {
    const combined =
      osc(0, '⠐ Claude Code') + osc(0, '⠋ Claude Code') + osc(0, '⠐ Explore project structure')
    expect(processClaudeCliPtyData('s1', combined)).toBe('Explore project structure')
  })
})

describe('processClaudeCliPtyData — one-shot guard', () => {
  beforeEach(() => {
    resetAllClaudeCliTitleState()
  })

  it('returns null on subsequent OSC titles after the first is accepted', () => {
    expect(processClaudeCliPtyData('s1', osc(2, 'first title'))).toBe('first title')
    expect(processClaudeCliPtyData('s1', osc(2, 'second title'))).toBeNull()
  })

  it('keeps each session independent', () => {
    expect(processClaudeCliPtyData('s1', osc(2, 'session one title'))).toBe('session one title')
    expect(processClaudeCliPtyData('s2', osc(2, 'session two title'))).toBe('session two title')
  })

  it('resetClaudeCliTitleState clears the one-shot for that session only', () => {
    expect(processClaudeCliPtyData('s1', osc(2, 'first'))).toBe('first')
    expect(processClaudeCliPtyData('s2', osc(2, 'other'))).toBe('other')
    resetClaudeCliTitleState('s1')
    expect(processClaudeCliPtyData('s1', osc(2, 'second'))).toBe('second')
    // s2 still in applied state
    expect(processClaudeCliPtyData('s2', osc(2, 'another'))).toBeNull()
  })
})

describe('applyClaudeCliTitle', () => {
  let db: any

  beforeEach(() => {
    resetAllClaudeCliTitleState()
    mocks.autoRenameWorktreeBranch.mockReset()
    mocks.emitWorktreeBranchRenamed.mockReset()
    mocks.publishDesktopBackendEvent.mockReset()
    db = {
      getSession: vi.fn(),
      updateSession: vi.fn(),
      updateWorktree: vi.fn(),
      getWorktreeBySessionId: vi.fn(() => null),
      getWorktree: vi.fn(() => null),
      getConnection: vi.fn(() => null)
    }
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  function makeSession(overrides: any = {}): any {
    return {
      id: 'hive-1',
      agent_sdk: 'claude-code-cli',
      worktree_id: 'wt-1',
      connection_id: null,
      name: null,
      ...overrides
    }
  }

  function makeWorktree(overrides: any = {}): any {
    return {
      id: 'wt-1',
      path: '/repo/wt',
      branch_name: 'running-zebra',
      branch_renamed: 0,
      ...overrides
    }
  }

  it('bails when the session is missing', async () => {
    db.getSession.mockReturnValue(null)
    await applyClaudeCliTitle({ sessionId: 'hive-1', title: 'Title', db })
    expect(db.updateSession).not.toHaveBeenCalled()
    expect(mocks.publishDesktopBackendEvent).not.toHaveBeenCalled()
  })

  it('bails when the session is not a claude-code-cli session', async () => {
    db.getSession.mockReturnValue(makeSession({ agent_sdk: 'codex' }))
    await applyClaudeCliTitle({ sessionId: 'hive-1', title: 'Title', db })
    expect(db.updateSession).not.toHaveBeenCalled()
  })

  it('updates the session name and emits opencode:stream session.updated', async () => {
    db.getSession.mockReturnValue(makeSession())
    db.getWorktreeBySessionId.mockReturnValue(null)
    await applyClaudeCliTitle({ sessionId: 'hive-1', title: 'New title', db })
    expect(db.updateSession).toHaveBeenCalledWith('hive-1', { name: 'New title' })
    expect(mocks.publishDesktopBackendEvent).toHaveBeenCalledWith('opencode:stream', {
      type: 'session.updated',
      sessionId: 'hive-1',
      data: { title: 'New title', info: { title: 'New title' } }
    })
  })

  it('calls autoRenameWorktreeBranch for the direct worktree when branch_renamed=0', async () => {
    db.getSession.mockReturnValue(makeSession())
    db.getWorktreeBySessionId.mockReturnValue(makeWorktree())
    mocks.autoRenameWorktreeBranch.mockResolvedValue({ renamed: true, newBranch: 'new-title' })

    await applyClaudeCliTitle({ sessionId: 'hive-1', title: 'New title', db })

    expect(mocks.autoRenameWorktreeBranch).toHaveBeenCalledWith({
      worktreeId: 'wt-1',
      worktreePath: '/repo/wt',
      currentBranchName: 'running-zebra',
      sessionTitle: 'New title',
      db
    })
    expect(mocks.emitWorktreeBranchRenamed).toHaveBeenCalledWith({
      worktreeId: 'wt-1',
      newBranch: 'new-title',
      worktreePath: '/repo/wt'
    })
  })

  it('skips branch rename when branch_renamed=1', async () => {
    db.getSession.mockReturnValue(makeSession())
    db.getWorktreeBySessionId.mockReturnValue(makeWorktree({ branch_renamed: 1 }))
    await applyClaudeCliTitle({ sessionId: 'hive-1', title: 'New title', db })
    expect(mocks.autoRenameWorktreeBranch).not.toHaveBeenCalled()
  })

  it('renames branches for all eligible connection members', async () => {
    db.getSession.mockReturnValue(makeSession({ connection_id: 'conn-1' }))
    const directWt = makeWorktree()
    db.getWorktreeBySessionId.mockReturnValue(directWt)
    db.getConnection.mockReturnValue({
      members: [
        { worktree_id: 'wt-1' },
        { worktree_id: 'wt-2' },
        { worktree_id: 'wt-3' }
      ]
    })
    db.getWorktree.mockImplementation((id: string) => {
      if (id === 'wt-2') return makeWorktree({ id: 'wt-2', path: '/repo/wt2', branch_name: 'happy-cat' })
      if (id === 'wt-3') return makeWorktree({ id: 'wt-3', path: '/repo/wt3', branch_name: 'lazy-dog', branch_renamed: 1 })
      return null
    })
    mocks.autoRenameWorktreeBranch.mockResolvedValue({ renamed: true, newBranch: 'new-title' })

    await applyClaudeCliTitle({ sessionId: 'hive-1', title: 'New title', db })

    const calls = mocks.autoRenameWorktreeBranch.mock.calls
    const worktreeIds = calls.map((c) => c[0].worktreeId)
    expect(worktreeIds).toEqual(['wt-1', 'wt-2'])
  })

  it('swallows errors and flips branch_renamed on autoRename throwing', async () => {
    db.getSession.mockReturnValue(makeSession())
    db.getWorktreeBySessionId.mockReturnValue(makeWorktree())
    mocks.autoRenameWorktreeBranch.mockRejectedValue(new Error('git boom'))

    await expect(
      applyClaudeCliTitle({ sessionId: 'hive-1', title: 'New title', db })
    ).resolves.toBeUndefined()
    expect(db.updateWorktree).toHaveBeenCalledWith('wt-1', { branch_renamed: 1 })
  })
})
