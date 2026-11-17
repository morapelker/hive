// A session view that talks to an agent reads the folder of its worktree once, when it starts,
// and the agent's session is registered under that folder. This suite mounts the real view and
// moves its project: the view has to start over and reconnect the same agent session under the
// new folder, keep the draft, and stay as it is when some other worktree changes. The API
// modules are stand-ins; the stores are the real ones.
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
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
    getConfig: vi.fn(() => Promise.resolve(null)),
    getStatus: vi.fn(() =>
      Promise.resolve({
        active: false,
        sessionId: null,
        worktreeId: null,
        connectionId: null,
        mode: null,
        health: 'ok',
        lastError: null
      })
    ),
    onStatusChanged: vi.fn(() => () => {}),
    onPlanImplementRequested: vi.fn(() => () => {})
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

vi.mock('sonner', () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
    warning: vi.fn()
  }
}))

vi.mock('./ForkMessageButton', () => ({
  ForkMessageButton: () => null
}))

vi.mock('./VirtualizedMessageList', () => ({
  VirtualizedMessageList: forwardRef(function MockVirtualizedMessageList(
    { messages }: { messages: Array<{ id: string; role: 'user' | 'assistant'; content: string }> },
    _ref
  ) {
    return (
      <div data-testid="message-list">
        {messages.map((message) => (
          <div key={message.id} data-testid={`message-${message.role}`}>
            {message.content}
          </div>
        ))}
      </div>
    )
  })
}))

import { resetSessionFollowUpDispatchState } from '@/lib/session-follow-up-dispatch'
import { useSessionStore, type Session } from '@/stores/useSessionStore'
import { useWorktreeStatusStore } from '@/stores/useWorktreeStatusStore'
import { useWorktreeStore } from '@/stores/useWorktreeStore'
import { SessionView } from './SessionView'

type WorktreeRow = NonNullable<
  ReturnType<ReturnType<typeof useWorktreeStore.getState>['worktreesByProject']['get']>
>[number]

const SESSION_ID = 'test-session-1'
const AGENT_SESSION_ID = 'opc-session-1'
const OLD_FOLDER = '/old/app'
const NEW_FOLDER = '/new/app'

const sessionRecord: Session = {
  id: SESSION_ID,
  worktree_id: 'wt-1',
  project_id: 'proj-1',
  connection_id: null,
  name: 'Test Session',
  status: 'active',
  opencode_session_id: AGENT_SESSION_ID,
  claude_session_id: null,
  agent_sdk: 'codex',
  mode: 'build',
  session_type: 'default',
  model_provider_id: null,
  model_id: null,
  model_variant: null,
  created_at: '2026-01-01T00:00:00.000Z',
  updated_at: '2026-01-01T00:00:00.000Z',
  completed_at: null
}

const worktreeRow = (id: string, path: string, projectId = 'proj-1'): WorktreeRow => ({
  id,
  project_id: projectId,
  name: id,
  branch_name: 'main',
  path,
  status: 'active',
  is_default: true,
  branch_renamed: 0,
  last_message_at: null,
  session_titles: '[]',
  last_model_provider_id: null,
  last_model_id: null,
  last_model_variant: null,
  attachments: '[]',
  created_at: '2026-01-01T00:00:00.000Z',
  last_accessed_at: '2026-01-01T00:00:00.000Z',
  github_pr_number: null,
  github_pr_url: null
})

// What the database and the worktree store both say about the session's worktree.
const placeWorktree = (path: string, others: WorktreeRow[] = []): void => {
  apiMocks.dbApi.worktree.get.mockResolvedValue(worktreeRow('wt-1', path))
  const byProject = new Map<string, WorktreeRow[]>([['proj-1', [worktreeRow('wt-1', path)]]])
  for (const other of others) {
    byProject.set(other.project_id, [...(byProject.get(other.project_id) ?? []), other])
  }
  act(() => {
    useWorktreeStore.setState({ worktreesByProject: byProject })
  })
}

const foldersReconnected = (): string[] =>
  apiMocks.opencodeApi.reconnect.mock.calls.map((call) => String(call[0]))

describe('SessionView when the project of its worktree moves', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resetSessionFollowUpDispatchState()
    apiMocks.bashApi.getRun.mockResolvedValue(null)
    apiMocks.bashApi.onStream.mockReturnValue(() => {})
    apiMocks.connectionApi.get.mockResolvedValue(null)
    apiMocks.dbApi.setting.get.mockResolvedValue(null)
    apiMocks.dbApi.setting.set.mockResolvedValue(true)
    apiMocks.dbApi.session.getDraft.mockResolvedValue(null)
    apiMocks.dbApi.session.updateDraft.mockResolvedValue(undefined)
    apiMocks.dbApi.sessionActivity.list.mockResolvedValue([])
    apiMocks.dbApi.sessionMessage.list.mockResolvedValue([])
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
      sessionsByWorktree: new Map([['wt-1', [sessionRecord]]]),
      tabOrderByWorktree: new Map([['wt-1', [SESSION_ID]]]),
      modeBySession: new Map([[SESSION_ID, 'build']]),
      pendingMessages: new Map(),
      pendingPlans: new Map(),
      pendingFollowUpMessages: new Map(),
      codexGoalsBySession: new Map(),
      isLoading: false,
      error: null,
      activeSessionId: SESSION_ID,
      activeWorktreeId: 'wt-1',
      activeSessionByWorktree: { 'wt-1': SESSION_ID },
      sessionsByConnection: new Map(),
      tabOrderByConnection: new Map(),
      activeSessionByConnection: {},
      activeConnectionId: null,
      inlineConnectionSessionId: null,
      closedTerminalSessionIds: new Set()
    })
    useWorktreeStatusStore.setState({ sessionStatuses: {}, lastMessageTimeByWorktree: {} })
    apiMocks.dbApi.session.get.mockResolvedValue(sessionRecord)
    placeWorktree(OLD_FOLDER)
  })

  afterEach(() => {
    cleanup()
    act(() => {
      useWorktreeStore.setState({ worktreesByProject: new Map() })
    })
  })

  test('starts over and reconnects the agent session under the new folder', async () => {
    render(<SessionView sessionId={SESSION_ID} />)
    await waitFor(() => {
      expect(screen.getByText('First answer')).toBeInTheDocument()
    })
    expect(foldersReconnected()).toEqual([OLD_FOLDER])
    expect(apiMocks.opencodeApi.reconnect).toHaveBeenCalledWith(
      OLD_FOLDER,
      AGENT_SESSION_ID,
      SESSION_ID
    )
    const inputBefore = screen.getByTestId('message-input')

    placeWorktree(NEW_FOLDER)

    await waitFor(() => {
      expect(apiMocks.opencodeApi.reconnect).toHaveBeenLastCalledWith(
        NEW_FOLDER,
        AGENT_SESSION_ID,
        SESSION_ID
      )
    })
    expect(foldersReconnected()).toEqual([OLD_FOLDER, NEW_FOLDER])
    // A new view, not the old one with a new prop, and it shows the conversation again.
    await waitFor(() => {
      expect(screen.getByText('First answer')).toBeInTheDocument()
    })
    expect(screen.getByTestId('message-input')).not.toBe(inputBefore)
    // What the new view asks the agent for, it asks under the new folder.
    await waitFor(() => {
      expect(apiMocks.opencodeApi.getMessages).toHaveBeenLastCalledWith(
        NEW_FOLDER,
        AGENT_SESSION_ID
      )
    })
  })

  test('keeps what was typed: the draft is saved on the way out', async () => {
    render(<SessionView sessionId={SESSION_ID} />)
    await waitFor(() => {
      expect(screen.getByText('First answer')).toBeInTheDocument()
    })
    fireEvent.change(screen.getByTestId('message-input'), {
      target: { value: 'half a thought' }
    })

    placeWorktree(NEW_FOLDER)

    await waitFor(() => {
      expect(apiMocks.dbApi.session.updateDraft).toHaveBeenCalledWith(SESSION_ID, 'half a thought')
    })
    await waitFor(() => {
      expect(foldersReconnected()).toEqual([OLD_FOLDER, NEW_FOLDER])
    })
  })

  test('stays as it is when another worktree changes or its own rows are reloaded', async () => {
    render(<SessionView sessionId={SESSION_ID} />)
    await waitFor(() => {
      expect(screen.getByText('First answer')).toBeInTheDocument()
    })
    const inputBefore = screen.getByTestId('message-input')
    const sessionReads = apiMocks.dbApi.session.get.mock.calls.length

    placeWorktree(OLD_FOLDER, [worktreeRow('wt-2', '/old/other', 'proj-2')])
    placeWorktree(OLD_FOLDER, [worktreeRow('wt-2', '/new/other', 'proj-2')])
    placeWorktree(OLD_FOLDER)
    await act(async () => {
      await Promise.resolve()
    })

    expect(screen.getByTestId('message-input')).toBe(inputBefore)
    expect(foldersReconnected()).toEqual([OLD_FOLDER])
    expect(apiMocks.dbApi.session.get.mock.calls.length).toBe(sessionReads)
  })

  test('does not start over when the rows of its worktree load after it mounted', async () => {
    act(() => {
      useWorktreeStore.setState({ worktreesByProject: new Map() })
    })
    render(<SessionView sessionId={SESSION_ID} />)
    await waitFor(() => {
      expect(screen.getByText('First answer')).toBeInTheDocument()
    })
    const inputBefore = screen.getByTestId('message-input')

    placeWorktree(OLD_FOLDER)
    await act(async () => {
      await Promise.resolve()
    })

    expect(screen.getByTestId('message-input')).toBe(inputBefore)
    expect(foldersReconnected()).toEqual([OLD_FOLDER])
  })
})
