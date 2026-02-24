import { describe, test, expect, beforeEach, vi } from 'vitest'
import { act } from '@testing-library/react'
import { useSessionStore } from '../../src/renderer/src/stores/useSessionStore'

function makeTerminalSession(id: string, worktreeId: string) {
  return {
    id,
    worktree_id: worktreeId,
    project_id: 'proj-1',
    connection_id: null,
    name: id,
    status: 'active' as const,
    opencode_session_id: null,
    agent_sdk: 'terminal' as const,
    mode: 'build' as const,
    model_provider_id: null,
    model_id: null,
    model_variant: null,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    completed_at: null
  }
}

describe('closedTerminalSessionIds signal', () => {
  beforeEach(() => {
    Object.defineProperty(window, 'db', {
      value: {
        session: {
          update: vi.fn().mockResolvedValue(undefined)
        }
      },
      writable: true,
      configurable: true
    })
    Object.defineProperty(window, 'terminalOps', {
      value: {
        destroy: vi.fn().mockResolvedValue(undefined)
      },
      writable: true,
      configurable: true
    })

    act(() => {
      useSessionStore.setState({
        activeSessionId: 'term-1',
        activeWorktreeId: 'wt-1',
        activeConnectionId: null,
        inlineConnectionSessionId: null,
        isLoading: false,
        closedTerminalSessionIds: new Set(),
        sessionsByWorktree: new Map([
          ['wt-1', [makeTerminalSession('term-1', 'wt-1'), makeTerminalSession('term-2', 'wt-1')]]
        ]),
        sessionsByConnection: new Map(),
        tabOrderByWorktree: new Map([['wt-1', ['term-1', 'term-2']]]),
        tabOrderByConnection: new Map(),
        activeSessionByWorktree: { 'wt-1': 'term-1' },
        activeSessionByConnection: {}
      })
    })
  })

  test('closeSession adds terminal session ID to closedTerminalSessionIds', async () => {
    expect(useSessionStore.getState().closedTerminalSessionIds.size).toBe(0)

    await act(async () => {
      await useSessionStore.getState().closeSession('term-1')
    })

    expect(useSessionStore.getState().closedTerminalSessionIds.has('term-1')).toBe(true)
  })

  test('closeSession does NOT add non-terminal session ID to closedTerminalSessionIds', async () => {
    act(() => {
      useSessionStore.setState({
        sessionsByWorktree: new Map([
          [
            'wt-1',
            [
              { ...makeTerminalSession('oc-1', 'wt-1'), agent_sdk: 'opencode' as const },
              makeTerminalSession('term-2', 'wt-1')
            ]
          ]
        ]),
        activeSessionId: 'oc-1',
        tabOrderByWorktree: new Map([['wt-1', ['oc-1', 'term-2']]])
      })
    })

    await act(async () => {
      await useSessionStore.getState().closeSession('oc-1')
    })

    expect(useSessionStore.getState().closedTerminalSessionIds.size).toBe(0)
  })

  test('acknowledgeClosedTerminals removes IDs from the set', async () => {
    await act(async () => {
      await useSessionStore.getState().closeSession('term-1')
    })

    expect(useSessionStore.getState().closedTerminalSessionIds.has('term-1')).toBe(true)

    act(() => {
      useSessionStore.getState().acknowledgeClosedTerminals(new Set(['term-1']))
    })

    expect(useSessionStore.getState().closedTerminalSessionIds.size).toBe(0)
  })
})
