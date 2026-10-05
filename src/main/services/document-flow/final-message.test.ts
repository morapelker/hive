// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import {
  resolveSessionFinalMessage,
  type FinalMessageDeps,
  type FinalMessageSession
} from './final-message'

const cliSession: FinalMessageSession = {
  agent_sdk: 'claude-code-cli',
  claude_session_id: 'claude-1',
  opencode_session_id: null,
  worktree_id: 'wt-1'
}

function makeDeps(overrides: Partial<FinalMessageDeps> = {}): FinalMessageDeps {
  return {
    getRecordedFinalMessage: vi.fn(() => null),
    getSession: vi.fn(() => cliSession),
    getWorktreePath: vi.fn(() => '/worktrees/ticket'),
    readClaudeTranscript: vi.fn(async () => []),
    getSessionMessages: vi.fn(() => []),
    ...overrides
  }
}

describe('resolveSessionFinalMessage', () => {
  it('prefers the message the Stop hook recorded and reads nothing else', async () => {
    const deps = makeDeps({
      getRecordedFinalMessage: vi.fn(() => ({ text: 'All done.\n\nSTATUS: DONE' }))
    })

    await expect(resolveSessionFinalMessage({ sessionId: 's1' }, deps)).resolves.toBe(
      'All done.\n\nSTATUS: DONE'
    )
    expect(deps.getSession).not.toHaveBeenCalled()
    expect(deps.readClaudeTranscript).not.toHaveBeenCalled()
  })

  it('falls back to the transcript when the recorded message is empty', async () => {
    const deps = makeDeps({
      // A StopFailure row: the turn ended, but without text.
      getRecordedFinalMessage: vi.fn(() => ({ text: '  ' })),
      readClaudeTranscript: vi.fn(async () => [
        { role: 'user', content: 'do it' },
        { role: 'assistant', content: 'Working on it.' },
        { role: 'user', content: '' },
        { role: 'assistant', content: 'Finished the task.' },
        // A trailing tool-only turn has no text of its own.
        { role: 'assistant', content: '', parts: [{ type: 'tool_use' }] },
        'not a message',
        null
      ])
    })

    await expect(resolveSessionFinalMessage({ sessionId: 's1' }, deps)).resolves.toBe(
      'Finished the task.'
    )
    expect(deps.getWorktreePath).toHaveBeenCalledWith('wt-1')
    expect(deps.readClaudeTranscript).toHaveBeenCalledWith('/worktrees/ticket', 'claude-1')
  })

  it("reads an SDK session's transcript by the id kept in opencode_session_id", async () => {
    const deps = makeDeps({
      getSession: vi.fn(() => ({
        agent_sdk: 'claude-code',
        claude_session_id: null,
        opencode_session_id: 'sdk-session',
        worktree_id: null
      })),
      readClaudeTranscript: vi.fn(async () => [{ role: 'assistant', content: 'From the SDK.' }])
    })

    // No worktree on the session row: the caller's path is used.
    await expect(
      resolveSessionFinalMessage({ sessionId: 's1', worktreePath: '/worktrees/from-item' }, deps)
    ).resolves.toBe('From the SDK.')
    expect(deps.readClaudeTranscript).toHaveBeenCalledWith('/worktrees/from-item', 'sdk-session')
  })

  it('reads codex sessions from their stored messages', async () => {
    const deps = makeDeps({
      getSession: vi.fn(() => ({ ...cliSession, agent_sdk: 'codex-cli', claude_session_id: null })),
      getSessionMessages: vi.fn(() => [
        { role: 'assistant', content: 'First answer.' },
        { role: 'user', content: 'continue' },
        { role: 'assistant', content: 'Final answer.' }
      ])
    })

    await expect(resolveSessionFinalMessage({ sessionId: 's1' }, deps)).resolves.toBe(
      'Final answer.'
    )
    expect(deps.readClaudeTranscript).not.toHaveBeenCalled()
  })

  it.each<[string, Partial<FinalMessageDeps>]>([
    ['the session is unknown', { getSession: () => null }],
    [
      'the Claude session id was never captured',
      { getSession: () => ({ ...cliSession, claude_session_id: null }) }
    ],
    [
      'the worktree is gone',
      { getSession: () => ({ ...cliSession, worktree_id: 'gone' }), getWorktreePath: () => null }
    ],
    ['the transcript has no assistant text', { readClaudeTranscript: async () => [] }],
    [
      'the transcript cannot be read',
      {
        readClaudeTranscript: async () => {
          throw new Error('EACCES')
        }
      }
    ],
    [
      'the provider keeps no local messages',
      { getSession: () => ({ ...cliSession, agent_sdk: 'opencode' }) }
    ],
    [
      'the stored messages cannot be read',
      {
        getSession: () => ({ ...cliSession, agent_sdk: 'codex' }),
        getSessionMessages: () => {
          throw new Error('database is locked')
        }
      }
    ]
  ])('returns null when %s', async (_name, overrides) => {
    await expect(
      resolveSessionFinalMessage({ sessionId: 's1' }, makeDeps(overrides))
    ).resolves.toBeNull()
  })
})
