import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SessionFinalMessage } from '@shared/types/document-flow'
import { resetRendererRpcClientForTests, setRendererRpcClient } from '@/api/rpc-client'
import { useSessionStore } from '@/stores/useSessionStore'
import type { Session } from '../../../../main/db/types'
import { createLiveRunnerPorts } from './runner-ports'

vi.mock('@/api/settings-api', () => ({
  settingsApi: {
    detectEditors: vi.fn(),
    detectTerminals: vi.fn(),
    onSettingsUpdated: vi.fn(() => vi.fn()),
    openWithTerminal: vi.fn()
  }
}))

vi.mock('@/lib/toast', () => ({
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() }
}))

vi.mock('@/lib/hive-enterprise-telemetry', () => ({
  startHivePromptTelemetry: vi.fn()
}))

const initialSessionState = useSessionStore.getState()
const NOW = '2026-05-04T10:00:00.000Z'

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    id: 'session-1',
    worktree_id: null,
    project_id: 'project-1',
    connection_id: null,
    name: 'Task A',
    status: 'active',
    opencode_session_id: null,
    claude_session_id: null,
    agent_sdk: 'claude-code-cli',
    mode: 'build',
    session_type: 'default',
    model_provider_id: 'anthropic',
    model_id: 'opus',
    model_variant: null,
    remote_launch: null,
    created_at: NOW,
    updated_at: NOW,
    completed_at: null,
    pinned_to_board: false,
    ...overrides
  }
}

const recordedTurn: SessionFinalMessage = {
  session_id: 'session-1',
  state: 'working',
  text: '',
  completion: null,
  api_error: null,
  hook_event: 'SdkBusy',
  detail: null,
  background_work: null,
  updated_at: NOW
}

describe('createLiveRunnerPorts().isSessionStarted', () => {
  let request: ReturnType<typeof vi.fn>
  let liveTerminalIds: string[]
  let turn: SessionFinalMessage | null

  const seed = (session: Session): void => {
    useSessionStore.setState({
      sessionsByWorktree: new Map([[session.worktree_id ?? '', [session]]]),
      sessionsByConnection: new Map()
    })
  }

  const calls = (method: string): unknown[][] =>
    request.mock.calls.filter(([called]) => called === method)

  beforeAll(
    () =>
      // Absorb the settings store's one-shot import timer so it cannot reset state mid-test.
      new Promise((resolve) => setTimeout(resolve, 220))
  )

  beforeEach(() => {
    liveTerminalIds = []
    turn = null
    request = vi.fn(async (method: string) => {
      if (method === 'terminalOps.getLiveTerminalIds') return { terminalIds: liveTerminalIds }
      if (method === 'documentFlow.sessionTurn') return turn
      return null
    })
    resetRendererRpcClientForTests()
    setRendererRpcClient({ request, subscribe: vi.fn() })
  })

  afterEach(() => {
    resetRendererRpcClientForTests()
    useSessionStore.setState(initialSessionState, true)
  })

  describe('an SDK session', () => {
    it('is started once the server recorded a turn for it', async () => {
      seed(makeSession({ agent_sdk: 'claude-code', opencode_session_id: 'opc-1' }))
      turn = recordedTurn

      await expect(createLiveRunnerPorts().isSessionStarted('session-1')).resolves.toBe(true)
      expect(calls('documentFlow.sessionTurn')).toEqual([
        ['documentFlow.sessionTurn', { sessionId: 'session-1' }]
      ])
    })

    it('is not started while it is connected but was never prompted', async () => {
      seed(makeSession({ agent_sdk: 'codex', opencode_session_id: 'opc-1' }))

      await expect(createLiveRunnerPorts().isSessionStarted('session-1')).resolves.toBe(false)
      expect(calls('documentFlow.sessionTurn')).toHaveLength(1)
    })

    it('is not started without a backend session, and the server is not asked', async () => {
      seed(makeSession({ agent_sdk: 'claude-code', opencode_session_id: null }))
      turn = recordedTurn

      await expect(createLiveRunnerPorts().isSessionStarted('session-1')).resolves.toBe(false)
      expect(calls('documentFlow.sessionTurn')).toEqual([])
    })
  })

  describe('a CLI session', () => {
    it('is started while its PTY is live, whatever the server recorded', async () => {
      seed(makeSession({ agent_sdk: 'claude-code-cli' }))
      liveTerminalIds = ['session-0', 'session-1']

      await expect(createLiveRunnerPorts().isSessionStarted('session-1')).resolves.toBe(true)
      expect(calls('documentFlow.sessionTurn')).toEqual([])
    })

    it('is not started without a live PTY', async () => {
      seed(makeSession({ agent_sdk: 'codex-cli' }))
      liveTerminalIds = ['session-0']

      await expect(createLiveRunnerPorts().isSessionStarted('session-1')).resolves.toBe(false)
    })

    it('surfaces a failed PTY lookup instead of reading it as never started', async () => {
      seed(makeSession({ agent_sdk: 'claude-code-cli' }))
      request.mockRejectedValueOnce(new Error('WebSocket is not open'))

      await expect(createLiveRunnerPorts().isSessionStarted('session-1')).rejects.toThrow(
        'WebSocket is not open'
      )
    })
  })

  it('is not started for a session that no longer exists', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    await expect(createLiveRunnerPorts().isSessionStarted('session-gone')).resolves.toBe(false)
    warn.mockRestore()
  })
})
