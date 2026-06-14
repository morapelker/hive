import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { resetRendererRpcClientForTests, setRendererRpcClient } from '@/api/rpc-client'
import { opencodeApi } from '@/api/opencode-api'
import { startBackgroundSessionPrompt } from './backgroundSessionStart'

const mocks = vi.hoisted(() => {
  const sessionState = {
    sessionsByWorktree: new Map(),
    sessionsByConnection: new Map(),
    setOpenCodeSessionId: vi.fn(),
    setPendingMessage: vi.fn(),
    dequeuePendingMessage: vi.fn()
  }

  return {
    sessionState,
    setSessionStatus: vi.fn(),
    resolveModelForSdk: vi.fn(),
    bumpWorktreeLastMessage: vi.fn(),
    snapshotTokenBaseline: vi.fn(),
    startHivePromptTelemetry: vi.fn()
  }
})

vi.mock('@/stores/useSessionStore', () => ({
  useSessionStore: {
    getState: () => mocks.sessionState
  }
}))

vi.mock('@/stores/useWorktreeStatusStore', () => ({
  useWorktreeStatusStore: {
    getState: () => ({
      setSessionStatus: mocks.setSessionStatus
    })
  }
}))

vi.mock('@/stores/useSettingsStore', () => ({
  resolveModelForSdk: mocks.resolveModelForSdk
}))

vi.mock('@/lib/last-message-utils', () => ({
  bumpWorktreeLastMessage: mocks.bumpWorktreeLastMessage
}))

vi.mock('@/lib/token-baselines', () => ({
  snapshotTokenBaseline: mocks.snapshotTokenBaseline
}))

vi.mock('@/lib/hive-enterprise-telemetry', () => ({
  startHivePromptTelemetry: mocks.startHivePromptTelemetry
}))

vi.mock('@/api/opencode-api', () => ({
  opencodeApi: {
    connect: vi.fn(),
    prompt: vi.fn()
  }
}))

describe('startBackgroundSessionPrompt', () => {
  let request: ReturnType<typeof vi.fn>

  beforeEach(() => {
    vi.clearAllMocks()
    resetRendererRpcClientForTests()
    request = vi.fn().mockResolvedValue(null)
    setRendererRpcClient({ request, subscribe: vi.fn() })

    mocks.sessionState.sessionsByWorktree = new Map([
      [
        'worktree-1',
        [
          {
            id: 'session-1',
            agent_sdk: 'opencode',
            model_provider_id: 'anthropic',
            model_id: 'claude-opus',
            model_variant: null
          }
        ]
      ]
    ])
    mocks.sessionState.sessionsByConnection = new Map()

    vi.mocked(opencodeApi.connect).mockResolvedValue({
      success: true,
      value: {
        success: true,
        sessionId: 'opencode-session-1'
      }
    })
    vi.mocked(opencodeApi.prompt).mockResolvedValue({
      success: true,
      value: {
        success: true
      }
    })
  })

  afterEach(() => {
    resetRendererRpcClientForTests()
  })

  it('persists connected OpenCode session IDs through dbApi', async () => {
    await startBackgroundSessionPrompt({
      worktreePath: '/repo/hive',
      sessionId: 'session-1',
      prompt: 'continue implementation',
      bumpTarget: { worktreeId: 'worktree-1' }
    })

    expect(request).toHaveBeenCalledWith('db.session.update', {
      id: 'session-1',
      data: { opencode_session_id: 'opencode-session-1' }
    })
    expect(mocks.sessionState.setOpenCodeSessionId).toHaveBeenCalledWith(
      'session-1',
      'opencode-session-1'
    )
    expect(mocks.startHivePromptTelemetry).toHaveBeenCalledTimes(1)
    expect(mocks.startHivePromptTelemetry).toHaveBeenCalledWith({
      sessionId: 'session-1',
      prompt: 'continue implementation',
      worktreeId: 'worktree-1',
      modelId: 'claude-opus',
      providerId: 'anthropic',
      modelVariant: undefined,
      mode: 'build'
    })
    expect(opencodeApi.prompt).toHaveBeenCalledWith(
      '/repo/hive',
      'opencode-session-1',
      [{ type: 'text', text: 'continue implementation' }],
      {
        providerID: 'anthropic',
        modelID: 'claude-opus',
        variant: undefined
      }
    )
    expect(mocks.sessionState.dequeuePendingMessage).toHaveBeenCalledWith('session-1')
  })
})
