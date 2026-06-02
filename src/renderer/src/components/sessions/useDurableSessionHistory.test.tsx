import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useDurableSessionHistory } from './useDurableSessionHistory'
import { useConnectionStore } from '@/stores/useConnectionStore'
import { useSessionStore } from '@/stores/useSessionStore'
import { useWorktreeStore } from '@/stores/useWorktreeStore'

const initialConnectionState = useConnectionStore.getState()
const initialSessionState = useSessionStore.getState()
const initialWorktreeState = useWorktreeStore.getState()

const session = {
  id: 'session-1',
  worktree_id: 'worktree-1',
  project_id: 'project-1',
  connection_id: null,
  name: 'Session 1',
  status: 'active' as const,
  opencode_session_id: 'runtime-1',
  claude_session_id: null,
  agent_sdk: 'opencode' as const,
  mode: 'build' as const,
  session_type: 'default' as const,
  model_provider_id: 'anthropic',
  model_id: 'opus',
  model_variant: null,
  created_at: '2026-01-01T00:00:00.000Z',
  updated_at: '2026-01-01T00:00:00.000Z',
  completed_at: null
}

function seedSession(overrides: Partial<typeof session> = {}): void {
  useSessionStore.setState({
    sessionsByWorktree: new Map([['worktree-1', [{ ...session, ...overrides }]]]),
    sessionsByConnection: new Map()
  })
}

describe('useDurableSessionHistory', () => {
  beforeEach(() => {
    useConnectionStore.setState(initialConnectionState, true)
    useSessionStore.setState(initialSessionState, true)
    useWorktreeStore.setState(initialWorktreeState, true)

    seedSession()
    useWorktreeStore.setState({
      worktreesByProject: new Map([
        [
          'project-1',
          [
            {
              id: 'worktree-1',
              project_id: 'project-1',
              name: 'Main',
              branch_name: 'main',
              path: '/repo',
              is_default: true,
              status: 'active',
              created_at: '2026-01-01T00:00:00.000Z',
              updated_at: '2026-01-01T00:00:00.000Z',
              base_branch: null,
              branch_renamed: 0,
              last_message_at: null,
              last_model_provider_id: null,
              last_model_id: null,
              last_model_variant: null,
              pinned: 0,
              github_pr_number: null,
              github_pr_url: null
            }
          ]
        ]
      ])
    })
    Object.defineProperty(window, 'db', {
      writable: true,
      configurable: true,
      value: {
        sessionMessage: {
          list: vi.fn(async () => [])
        },
        sessionActivity: {
          list: vi.fn(async () => [])
        }
      }
    })
  })

  afterEach(() => {
    cleanup()
  })

  it('treats live backend transcript messages as durable history', async () => {
    const getMessages = vi.fn(async () => ({
      success: true,
      messages: [{ id: 'message-1' }]
    }))
    Object.defineProperty(window, 'opencodeOps', {
      writable: true,
      configurable: true,
      value: { getMessages }
    })

    const { result } = renderHook(() => useDurableSessionHistory('session-1'))

    await waitFor(() => {
      expect(getMessages).toHaveBeenCalledWith('/repo', 'runtime-1')
    })
    expect(result.current).toBe(true)
  })

  it('returns false when DB and live transcript history are empty', async () => {
    Object.defineProperty(window, 'opencodeOps', {
      writable: true,
      configurable: true,
      value: {
        getMessages: vi.fn(async () => ({
          success: true,
          messages: []
        }))
      }
    })

    const { result } = renderHook(() => useDurableSessionHistory('session-1'))

    await waitFor(() => {
      expect(result.current).toBe(false)
    })
  })

  it('treats launched Claude CLI sessions as durable when transcript cannot be verified', async () => {
    seedSession({
      agent_sdk: 'claude-code-cli',
      opencode_session_id: null,
      claude_session_id: 'claude-session-1'
    })
    Object.defineProperty(window, 'opencodeOps', {
      writable: true,
      configurable: true,
      value: {
        getMessages: vi.fn(async () => ({
          success: true,
          messages: []
        }))
      }
    })

    const { result } = renderHook(() => useDurableSessionHistory('session-1'))

    await waitFor(() => {
      expect(result.current).toBe(true)
    })
    expect(window.opencodeOps.getMessages).not.toHaveBeenCalled()
  })

  it('returns false for not-yet-launched Claude CLI sessions with empty DB history', async () => {
    seedSession({
      agent_sdk: 'claude-code-cli',
      opencode_session_id: null,
      claude_session_id: null
    })

    const { result } = renderHook(() => useDurableSessionHistory('session-1'))

    await waitFor(() => {
      expect(result.current).toBe(false)
    })
  })

  it('does not reset or recheck when unrelated session fields change', async () => {
    const getMessages = vi.fn(async () => ({
      success: true,
      messages: []
    }))
    Object.defineProperty(window, 'opencodeOps', {
      writable: true,
      configurable: true,
      value: { getMessages }
    })

    const { result } = renderHook(() => useDurableSessionHistory('session-1'))

    await waitFor(() => {
      expect(result.current).toBe(false)
    })
    expect(getMessages).toHaveBeenCalledTimes(1)

    act(() => {
      seedSession({
        name: 'Renamed Session',
        updated_at: '2026-01-01T00:00:02.000Z'
      })
    })

    expect(result.current).toBe(false)
    expect(getMessages).toHaveBeenCalledTimes(1)
  })
})
