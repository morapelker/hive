import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, waitFor, act, cleanup } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { forwardRef } from 'react'

const apiMocks = vi.hoisted(() => ({
  bashApi: {
    getRun: vi.fn(),
    onStream: vi.fn()
  },
  connectionApi: {
    get: vi.fn()
  },
  dbApi: {
    setting: {
      get: vi.fn(),
      set: vi.fn()
    },
    session: {
      get: vi.fn(),
      getDraft: vi.fn(),
      updateDraft: vi.fn()
    },
    sessionActivity: {
      list: vi.fn()
    },
    sessionMessage: {
      list: vi.fn()
    },
    worktree: {
      get: vi.fn(),
      update: vi.fn()
    }
  },
  loggingApi: {
    createResponseLog: vi.fn(),
    appendResponseLog: vi.fn()
  },
  opencodeApi: {
    reconnect: vi.fn(),
    connect: vi.fn(),
    prompt: vi.fn(),
    steer: vi.fn(),
    command: vi.fn(),
    fork: vi.fn(),
    sessionInfo: vi.fn(),
    undo: vi.fn(),
    redo: vi.fn(),
    disconnect: vi.fn(),
    abort: vi.fn(),
    getMessages: vi.fn(),
    listModels: vi.fn(),
    setModel: vi.fn(),
    modelInfo: vi.fn(),
    questionReply: vi.fn(),
    questionReject: vi.fn(),
    permissionReply: vi.fn(),
    permissionList: vi.fn(),
    commands: vi.fn(),
    capabilities: vi.fn(),
    onStream: vi.fn()
  },
  petApi: {
    hide: vi.fn(() => Promise.resolve(undefined)),
    show: vi.fn(() => Promise.resolve(undefined)),
    updateSettings: vi.fn(() => Promise.resolve({ success: true }))
  },
  settingsApi: {
    onSettingsUpdated: vi.fn(() => () => {})
  },
  systemApi: {
    isLogMode: vi.fn(),
    getLogDir: vi.fn(),
    getAppVersion: vi.fn(),
    getAppPaths: vi.fn(),
    detectAgentSdks: vi.fn(),
    setSessionQueuedState: vi.fn()
  },
  telegramApi: {
    getConfig: vi.fn(() => Promise.resolve(null))
  },
  terminalApi: {
    destroy: vi.fn()
  },
  updaterApi: {
    onChecking: vi.fn(),
    onUpdateAvailable: vi.fn(),
    onUpdateNotAvailable: vi.fn(),
    onProgress: vi.fn(),
    onUpdateDownloaded: vi.fn(),
    onError: vi.fn()
  }
}))

vi.mock('@/api/bash-api', () => ({
  bashApi: apiMocks.bashApi
}))

vi.mock('@/api/connection-api', () => ({
  connectionApi: apiMocks.connectionApi
}))

vi.mock('@/api/db-api', () => ({
  dbApi: apiMocks.dbApi
}))

vi.mock('@/api/logging-api', () => ({
  loggingApi: apiMocks.loggingApi
}))

vi.mock('@/api/opencode-api', () => ({
  opencodeApi: apiMocks.opencodeApi
}))

vi.mock('@/api/pet-api', () => ({
  petApi: apiMocks.petApi
}))

vi.mock('@/api/settings-api', () => ({
  settingsApi: apiMocks.settingsApi
}))

vi.mock('@/api/system-api', () => ({
  systemApi: apiMocks.systemApi
}))

vi.mock('@/api/telegram-api', () => ({
  telegramApi: apiMocks.telegramApi
}))

vi.mock('@/api/terminal-api', () => ({
  terminalApi: apiMocks.terminalApi
}))

vi.mock('@/api/updater-api', () => ({
  updaterApi: apiMocks.updaterApi
}))

import { useSessionStore } from '../../../src/renderer/src/stores/useSessionStore'
import { useWorktreeStatusStore } from '../../../src/renderer/src/stores/useWorktreeStatusStore'
import { resetSessionFollowUpDispatchState } from '../../../src/renderer/src/lib/session-follow-up-dispatch'

vi.mock('sonner', () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
    warning: vi.fn()
  }
}))

vi.mock('../../../src/renderer/src/components/sessions/ForkMessageButton', () => ({
  ForkMessageButton: () => null
}))

vi.mock('../../../src/renderer/src/components/sessions/VirtualizedMessageList', () => ({
  VirtualizedMessageList: forwardRef(function MockVirtualizedMessageList(
    {
      messages,
      queuedMessages,
      canSteer,
      onSteerMessage
    }: {
      messages: Array<{ id: string; role: 'user' | 'assistant'; content: string; steered?: boolean }>
      queuedMessages: Array<{ id: string; content: string }>
      canSteer: boolean
      onSteerMessage: (messageId: string, content: string) => void | Promise<void>
    },
    _ref
  ) {
    return (
      <div data-testid="message-list">
        {messages.map((message) => (
          <div
            key={message.id}
            data-testid={message.role === 'user' ? 'message-user' : 'message-assistant'}
          >
            {message.steered && <span data-testid="steered-mode-badge">STEERED</span>}
            <span>{message.content}</span>
          </div>
        ))}
        {queuedMessages.map((message) => (
          <button
            key={message.id}
            data-testid="queued-message-bubble"
            disabled={!canSteer}
            onClick={() => onSteerMessage(message.id, message.content)}
            title="Steer — inject into active turn"
          >
            {message.content}
          </button>
        ))}
      </div>
    )
  })
}))

import { SessionView } from '../../../src/renderer/src/components/sessions/SessionView'

function createSessionRecord(
  overrides: Partial<{
    id: string
    worktree_id: string | null
    project_id: string
    connection_id: string | null
    name: string | null
    status: 'active' | 'completed' | 'error'
    opencode_session_id: string | null
    agent_sdk: 'opencode' | 'claude-code' | 'codex' | 'terminal'
    mode: 'build' | 'plan'
    model_provider_id: string | null
    model_id: string | null
    model_variant: string | null
    created_at: string
    updated_at: string
    completed_at: string | null
  }> = {}
) {
  return {
    id: 'test-session-1',
    worktree_id: 'wt-1',
    project_id: 'proj-1',
    connection_id: null,
    name: 'Test Session',
    status: 'active' as const,
    opencode_session_id: 'opc-session-1',
    agent_sdk: 'codex' as const,
    mode: 'build' as const,
    model_provider_id: null,
    model_id: null,
    model_variant: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    completed_at: null,
    ...overrides
  }
}

describe('Codex steer boundary ordering', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resetSessionFollowUpDispatchState()
    apiMocks.bashApi.getRun.mockResolvedValue(null)
    apiMocks.bashApi.onStream.mockReturnValue(() => {})
    apiMocks.connectionApi.get.mockResolvedValue(null)
    apiMocks.dbApi.setting.get.mockResolvedValue(null)
    apiMocks.dbApi.setting.set.mockResolvedValue(true)
    apiMocks.dbApi.session.get.mockResolvedValue({
      id: 'test-session-1',
      worktree_id: 'wt-1',
      project_id: 'proj-1',
      name: 'Test Session',
      status: 'active',
      opencode_session_id: 'opc-session-1',
      mode: 'build',
      agent_sdk: 'codex',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      completed_at: null
    })
    apiMocks.dbApi.session.getDraft.mockResolvedValue(null)
    apiMocks.dbApi.session.updateDraft.mockResolvedValue(undefined)
    apiMocks.dbApi.sessionActivity.list.mockResolvedValue([])
    apiMocks.dbApi.sessionMessage.list.mockResolvedValue([])
    apiMocks.dbApi.worktree.get.mockResolvedValue({
      id: 'wt-1',
      project_id: 'proj-1',
      name: 'WT',
      branch_name: 'main',
      path: '/tmp/worktree-codex-steer',
      status: 'active',
      is_default: true,
      created_at: new Date().toISOString(),
      last_accessed_at: new Date().toISOString()
    })
    apiMocks.dbApi.worktree.update.mockResolvedValue(null)
    apiMocks.loggingApi.createResponseLog.mockResolvedValue('/tmp/log.jsonl')
    apiMocks.loggingApi.appendResponseLog.mockResolvedValue(undefined)
    apiMocks.opencodeApi.reconnect.mockResolvedValue({ success: true, value: { success: true } })
    apiMocks.opencodeApi.connect.mockResolvedValue({ success: true, value: { success: false } })
    apiMocks.opencodeApi.prompt.mockResolvedValue({ success: true, value: { success: true } })
    apiMocks.opencodeApi.steer.mockResolvedValue({
      success: true,
      value: {
        success: true,
        insertedMessageId: 'turn-1:user:2',
        nextAssistantMessageId: 'turn-1:assistant:2',
        turnId: 'turn-1'
      }
    })
    apiMocks.opencodeApi.command.mockResolvedValue({ success: true, value: { success: true } })
    apiMocks.opencodeApi.fork.mockResolvedValue({ success: true, value: { success: true } })
    apiMocks.opencodeApi.sessionInfo.mockResolvedValue({
      success: true,
      value: { success: true, revertMessageID: null, revertDiff: null }
    })
    apiMocks.opencodeApi.undo.mockResolvedValue({ success: true, value: { success: true } })
    apiMocks.opencodeApi.redo.mockResolvedValue({ success: true, value: { success: true } })
    apiMocks.opencodeApi.disconnect.mockResolvedValue({ success: true, value: { success: true } })
    apiMocks.opencodeApi.abort.mockResolvedValue({ success: true, value: { success: true } })
    apiMocks.opencodeApi.getMessages.mockResolvedValue({
      success: true,
      value: {
        success: true,
        messages: [
          {
            info: {
              id: 'turn-1:user',
              role: 'user',
              time: { created: Date.now() - 2000 }
            },
            parts: [{ type: 'text', text: 'First question' }]
          },
          {
            info: {
              id: 'turn-1:assistant',
              role: 'assistant',
              time: { created: Date.now() - 1000 }
            },
            parts: [{ type: 'text', text: 'First answer' }]
          }
        ]
      }
    })
    apiMocks.opencodeApi.listModels.mockResolvedValue({
      success: true,
      value: { success: true, providers: [] }
    })
    apiMocks.opencodeApi.setModel.mockResolvedValue({ success: true, value: { success: true } })
    apiMocks.opencodeApi.modelInfo.mockResolvedValue({ success: true, value: { success: true } })
    apiMocks.opencodeApi.questionReply.mockResolvedValue({
      success: true,
      value: { success: true }
    })
    apiMocks.opencodeApi.questionReject.mockResolvedValue({
      success: true,
      value: { success: true }
    })
    apiMocks.opencodeApi.permissionReply.mockResolvedValue({
      success: true,
      value: { success: true }
    })
    apiMocks.opencodeApi.permissionList.mockResolvedValue({
      success: true,
      value: { success: true, permissions: [] }
    })
    apiMocks.opencodeApi.commands.mockResolvedValue({
      success: true,
      value: { success: true, commands: [] }
    })
    apiMocks.opencodeApi.capabilities.mockResolvedValue({
      success: true,
      value: {
        success: true,
        capabilities: {
          supportsUndo: true,
          supportsRedo: true,
          supportsCommands: true,
          supportsPermissionRequests: true,
          supportsQuestionPrompts: true,
          supportsModelSelection: true,
          supportsReconnect: true,
          supportsPartialStreaming: true,
          supportsSteer: true
        }
      }
    })
    apiMocks.opencodeApi.onStream.mockImplementation(
      (callback: (event: Record<string, unknown>) => void) => {
        ;(window as Window & { __testStreamCallback?: typeof callback }).__testStreamCallback =
          callback
        return () => {}
      }
    )
    apiMocks.petApi.hide.mockResolvedValue(undefined)
    apiMocks.petApi.show.mockResolvedValue(undefined)
    apiMocks.petApi.updateSettings.mockResolvedValue({ success: true })
    apiMocks.settingsApi.onSettingsUpdated.mockReturnValue(() => {})
    apiMocks.systemApi.isLogMode.mockResolvedValue(false)
    apiMocks.systemApi.getLogDir.mockResolvedValue('/tmp/logs')
    apiMocks.systemApi.getAppVersion.mockResolvedValue('1.0.0')
    apiMocks.systemApi.getAppPaths.mockResolvedValue({
      userData: '/tmp',
      home: '/tmp',
      logs: '/tmp/logs'
    })
    apiMocks.systemApi.detectAgentSdks.mockResolvedValue({
      opencode: true,
      claude: true,
      codex: true
    })
    apiMocks.systemApi.setSessionQueuedState.mockResolvedValue(undefined)
    apiMocks.telegramApi.getConfig.mockResolvedValue(null)
    apiMocks.terminalApi.destroy.mockResolvedValue({ success: true, value: undefined })
    apiMocks.updaterApi.onChecking.mockReturnValue(() => {})
    apiMocks.updaterApi.onUpdateAvailable.mockReturnValue(() => {})
    apiMocks.updaterApi.onUpdateNotAvailable.mockReturnValue(() => {})
    apiMocks.updaterApi.onProgress.mockReturnValue(() => {})
    apiMocks.updaterApi.onUpdateDownloaded.mockReturnValue(() => {})
    apiMocks.updaterApi.onError.mockReturnValue(() => {})

    if (!HTMLElement.prototype.animate) {
      Object.defineProperty(HTMLElement.prototype, 'animate', {
        value: vi.fn(() => ({ cancel: vi.fn(), currentTime: 0 })),
        writable: true,
        configurable: true
      })
    }

    Element.prototype.scrollIntoView = vi.fn()

    useSessionStore.setState({
      sessionsByWorktree: new Map([['wt-1', [createSessionRecord()]]]),
      tabOrderByWorktree: new Map([['wt-1', ['test-session-1']]]),
      modeBySession: new Map([['test-session-1', 'build']]),
      pendingMessages: new Map(),
      pendingPlans: new Map(),
      pendingFollowUpMessages: new Map([['test-session-1', ['Follow-up steer']]]),
      codexGoalsBySession: new Map(),
      isLoading: false,
      error: null,
      activeSessionId: 'test-session-1',
      activeWorktreeId: 'wt-1',
      activeSessionByWorktree: { 'wt-1': 'test-session-1' },
      sessionsByConnection: new Map(),
      tabOrderByConnection: new Map(),
      activeSessionByConnection: {},
      activeConnectionId: null,
      inlineConnectionSessionId: null,
      closedTerminalSessionIds: new Set()
    })
    useWorktreeStatusStore.setState({ sessionStatuses: {}, lastMessageTimeByWorktree: {} })

  })

  afterEach(() => {
    cleanup()
  })

  test('pins the steered user message at the current boundary and streams new assistant text below it', async () => {
    const user = userEvent.setup()
    render(<SessionView sessionId="test-session-1" />)

    await waitFor(() => {
      expect(screen.getByText('First answer')).toBeInTheDocument()
    })

    const streamCallback = (window as Window & {
      __testStreamCallback?: (event: Record<string, unknown>) => void
    }).__testStreamCallback

    await act(async () => {
      streamCallback?.({
        sessionId: 'test-session-1',
        type: 'session.status',
        statusPayload: { type: 'busy' },
        data: { status: { type: 'busy' } }
      })
    })

    await waitFor(() => {
      expect(screen.getByTestId('queued-message-bubble')).toBeInTheDocument()
    })

    await user.click(screen.getByTitle('Steer — inject into active turn'))

    await waitFor(() => {
      expect(apiMocks.opencodeApi.steer).toHaveBeenCalledWith(
        '/tmp/worktree-codex-steer',
        'opc-session-1',
        'Follow-up steer'
      )
      expect(screen.getByTestId('steered-mode-badge')).toBeInTheDocument()
    })

    await act(async () => {
      streamCallback?.({
        sessionId: 'test-session-1',
        type: 'message.part.updated',
        data: {
          delta: 'Continued answer',
          part: { type: 'text', text: 'Continued answer' }
        }
      })
    })

    await waitFor(() => {
      expect(screen.getByText('Continued answer')).toBeInTheDocument()
    })

    const orderedMessages = screen
      .getAllByTestId(/message-(user|assistant)/)
      .map((element) => element.textContent ?? '')

    expect(orderedMessages).toEqual([
      expect.stringContaining('First question'),
      expect.stringContaining('First answer'),
      expect.stringContaining('STEEREDFollow-up steer'),
      expect.stringContaining('Continued answer')
    ])
  })

  test('renders and clears the sticky Codex goal status from stream events', async () => {
    render(<SessionView sessionId="test-session-1" />)

    await waitFor(() => {
      expect(screen.getByText('First answer')).toBeInTheDocument()
    })

    const streamCallback = (window as Window & {
      __testStreamCallback?: (event: Record<string, unknown>) => void
    }).__testStreamCallback

    await act(async () => {
      streamCallback?.({
        sessionId: 'test-session-1',
        type: 'codex.goal.updated',
        data: {
          threadId: 'opc-session-1',
          goal: {
            threadId: 'opc-session-1',
            objective: 'Add mul 161 to main',
            status: 'active',
            tokenBudget: null,
            tokensUsed: 47_957,
            timeUsedSeconds: 80,
            createdAt: 1,
            updatedAt: 1
          },
          _codexEventId: 'goal-event-1'
        }
      })
    })

    await waitFor(() => {
      expect(screen.getByTestId('goal-status-widget')).toBeInTheDocument()
      expect(screen.getByText('Pursuing goal (1m)')).toBeInTheDocument()
      expect(screen.getByText('Add mul 161 to main')).toBeInTheDocument()
    })

    await act(async () => {
      streamCallback?.({
        sessionId: 'test-session-1',
        type: 'codex.goal.cleared',
        data: {
          threadId: 'opc-session-1',
          _codexEventId: 'goal-event-2'
        }
      })
    })

    await waitFor(() => {
      expect(screen.queryByTestId('goal-status-widget')).not.toBeInTheDocument()
    })
  })
})
