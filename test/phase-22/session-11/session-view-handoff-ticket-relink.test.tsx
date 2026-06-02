import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { forwardRef } from 'react'

vi.mock('@/lib/toast', () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
    warning: vi.fn(),
    info: vi.fn(),
    loading: vi.fn(),
    dismiss: vi.fn()
  },
  default: {
    success: vi.fn(),
    error: vi.fn(),
    warning: vi.fn(),
    info: vi.fn(),
    loading: vi.fn(),
    dismiss: vi.fn()
  }
}))

vi.mock('../../../src/renderer/src/components/sessions/ForkMessageButton', () => ({
  ForkMessageButton: () => null
}))

vi.mock('../../../src/renderer/src/components/sessions/VirtualizedMessageList', () => ({
  VirtualizedMessageList: forwardRef(function MockVirtualizedMessageList(
    {
      messages
    }: {
      messages: Array<{ id: string; role: 'user' | 'assistant'; content: string }>
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
            {message.content}
          </div>
        ))}
      </div>
    )
  })
}))

vi.mock('../../../src/renderer/src/components/sessions/PlanReadyImplementFab', () => ({
  PlanReadyImplementFab: ({
    visible,
    onHandoff,
    onSuperpowers
  }: {
    visible: boolean
    onHandoff: (override?: { agentSdk: 'claude-code' }) => void
    onSuperpowers?: () => void
  }) =>
    visible ? (
      <>
        <button
          type="button"
          data-testid="plan-ready-handoff-fab"
          onClick={() => onHandoff({ agentSdk: 'claude-code' })}
        >
          Handoff
        </button>
        {onSuperpowers ? (
          <button type="button" data-testid="plan-ready-supercharge-fab" onClick={onSuperpowers}>
            Supercharge
          </button>
        ) : null}
      </>
    ) : null
}))

const apiMocks = vi.hoisted(() => ({
  bashApi: {
    getRun: vi.fn(),
    onStream: vi.fn()
  },
  connectionApi: {
    get: vi.fn(),
    getAll: vi.fn()
  },
  dbApi: {
    setting: {
      get: vi.fn().mockResolvedValue(null),
      set: vi.fn().mockResolvedValue(true)
    },
    session: {
      get: vi.fn(),
      getDraft: vi.fn(),
      updateDraft: vi.fn(),
      update: vi.fn(),
      create: vi.fn(),
      getActiveByWorktree: vi.fn(),
      getActiveByConnection: vi.fn()
    },
    sessionActivity: {
      list: vi.fn()
    },
    sessionMessage: {
      list: vi.fn()
    },
    worktree: {
      get: vi.fn(),
      update: vi.fn(),
      touch: vi.fn()
    },
    project: {
      getAll: vi.fn()
    }
  },
  kanbanApi: {
    ticket: {
      getBySession: vi.fn(),
      update: vi.fn(),
      getByProject: vi.fn()
    },
    dependency: {
      getForProject: vi.fn(),
      removeAll: vi.fn(),
      add: vi.fn(),
      remove: vi.fn()
    },
    simpleMode: {
      toggle: vi.fn()
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
    hide: vi.fn(),
    show: vi.fn(),
    updateSettings: vi.fn()
  },
  scriptApi: {
    onStarted: vi.fn(),
    onOutput: vi.fn(),
    onFinished: vi.fn()
  },
  settingsApi: {
    onSettingsUpdated: vi.fn()
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
    getConfig: vi.fn().mockResolvedValue(null),
    getStatus: vi.fn().mockResolvedValue({
      active: false,
      sessionId: null,
      worktreeId: null,
      connectionId: null,
      mode: null,
      health: 'ok',
      lastError: null
    }),
    onStatusChanged: vi.fn(() => () => {}),
    onMessageReceived: vi.fn(() => () => {}),
    onPlanImplementRequested: vi.fn(() => () => {})
  },
  terminalApi: {
    destroy: vi.fn(),
    onOutput: vi.fn(),
    onExit: vi.fn(),
    onCreated: vi.fn(),
    onClosed: vi.fn()
  },
  updaterApi: {
    onChecking: vi.fn(),
    onUpdateAvailable: vi.fn(),
    onUpdateNotAvailable: vi.fn(),
    onProgress: vi.fn(),
    onUpdateDownloaded: vi.fn(),
    onError: vi.fn(),
    onUpdateStatus: vi.fn()
  },
  worktreeApi: {
    duplicate: vi.fn(),
    onBranchRenamed: vi.fn()
  }
}))

vi.mock('@/api/bash-api', () => ({ bashApi: apiMocks.bashApi }))
vi.mock('@/api/connection-api', () => ({ connectionApi: apiMocks.connectionApi }))
vi.mock('@/api/db-api', () => ({ dbApi: apiMocks.dbApi }))
vi.mock('@/api/kanban-api', () => ({ kanbanApi: apiMocks.kanbanApi }))
vi.mock('@/api/logging-api', () => ({ loggingApi: apiMocks.loggingApi }))
vi.mock('@/api/opencode-api', () => ({ opencodeApi: apiMocks.opencodeApi }))
vi.mock('@/api/pet-api', () => ({ petApi: apiMocks.petApi }))
vi.mock('@/api/script-api', () => ({ scriptApi: apiMocks.scriptApi }))
vi.mock('@/api/settings-api', () => ({ settingsApi: apiMocks.settingsApi }))
vi.mock('@/api/system-api', () => ({ systemApi: apiMocks.systemApi }))
vi.mock('@/api/telegram-api', () => ({ telegramApi: apiMocks.telegramApi }))
vi.mock('@/api/terminal-api', () => ({ terminalApi: apiMocks.terminalApi }))
vi.mock('@/api/updater-api', () => ({ updaterApi: apiMocks.updaterApi }))
vi.mock('@/api/worktree-api', () => ({ worktreeApi: apiMocks.worktreeApi }))

import { SessionView } from '../../../src/renderer/src/components/sessions/SessionView'
import { useKanbanStore } from '../../../src/renderer/src/stores/useKanbanStore'
import { useProjectStore } from '../../../src/renderer/src/stores/useProjectStore'
import { useSessionStore } from '../../../src/renderer/src/stores/useSessionStore'
import { useSettingsStore } from '../../../src/renderer/src/stores/useSettingsStore'
import { useWorktreeStore } from '../../../src/renderer/src/stores/useWorktreeStore'
import { useWorktreeStatusStore } from '../../../src/renderer/src/stores/useWorktreeStatusStore'

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
    id: 'session-plan-old',
    worktree_id: 'wt-1',
    project_id: 'proj-1',
    connection_id: null,
    name: 'Plan Session',
    status: 'active' as const,
    opencode_session_id: 'opc-session-old',
    agent_sdk: 'claude-code' as const,
    mode: 'plan' as const,
    model_provider_id: null,
    model_id: null,
    model_variant: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    completed_at: null,
    ...overrides
  }
}

describe('SessionView handoff ticket relinking', () => {
  const mockKanban = apiMocks.kanbanApi
  const mockWorktreeOps = apiMocks.worktreeApi
  const mockDbSession = apiMocks.dbApi.session

  beforeEach(() => {
    vi.clearAllMocks()
    cleanup()
    localStorage.clear()

    useKanbanStore.setState({
      tickets: new Map(),
      isLoading: false,
      isBoardViewActive: false,
      simpleModeByProject: {},
      selectedTicketId: null
    })

    useSessionStore.setState({
      sessionsByWorktree: new Map([['wt-1', [createSessionRecord()]]]),
      tabOrderByWorktree: new Map([['wt-1', ['session-plan-old']]]),
      modeBySession: new Map([['session-plan-old', 'plan']]),
      pendingMessages: new Map(),
      pendingPlans: new Map([
        [
          'session-plan-old',
          {
            requestId: 'req-plan-1',
            planContent: '1. Add the relink helper\n2. Use it during handoff',
            toolUseID: 'tool-plan-1'
          }
        ]
      ]),
      pendingFollowUpMessages: new Map(),
      isLoading: false,
      error: null,
      activeSessionId: 'session-plan-old',
      activeWorktreeId: 'wt-1',
      activeSessionByWorktree: { 'wt-1': 'session-plan-old' },
      sessionsByConnection: new Map(),
      tabOrderByConnection: new Map(),
      activeSessionByConnection: {},
      activeConnectionId: null,
      inlineConnectionSessionId: null,
      closedTerminalSessionIds: new Set()
    })
    useWorktreeStatusStore.setState({ sessionStatuses: {}, lastMessageTimeByWorktree: {} })
    useSettingsStore.setState({
      defaultAgentSdk: 'claude-code',
      availableAgentSdks: {
        opencode: false,
        claude: true,
        codex: false
      },
      defaultModels: {
        build: null,
        plan: null,
        ask: null,
        review: null
      },
      selectedModel: null,
      selectedModelByProvider: {},
      lastHandoffOverride: null
    })
    useProjectStore.setState({
      projects: [
        {
          id: 'proj-1',
          name: 'Project 1',
          path: '/tmp/project-1',
          description: null,
          tags: null,
          language: null,
          custom_icon: null,
          setup_script: null,
          run_script: null,
          archive_script: null,
          auto_assign_port: false,
          sort_order: 0,
          created_at: new Date().toISOString(),
          last_accessed_at: new Date().toISOString()
        }
      ]
    })
    useWorktreeStore.setState({
      worktreesByProject: new Map([
        [
          'proj-1',
          [
            {
              id: 'wt-1',
              project_id: 'proj-1',
              name: 'main',
              branch_name: 'main',
              path: '/tmp/worktree-handoff',
              status: 'active',
              is_default: true,
              branch_renamed: 0,
              last_message_at: null,
              session_titles: '[]',
              last_model_provider_id: null,
              last_model_id: null,
              last_model_variant: null,
              attachments: '[]',
              pinned: 0,
              context: null,
              github_pr_number: null,
              github_pr_url: null,
              base_branch: null,
              created_at: new Date().toISOString(),
              last_accessed_at: new Date().toISOString()
            }
          ]
        ]
      ]),
      worktreeOrderByProject: new Map(),
      selectedWorktreeId: 'wt-1',
      creatingForProjectId: null,
      archivingWorktreeIds: new Set()
    })

    apiMocks.bashApi.getRun.mockResolvedValue(null)
    apiMocks.bashApi.onStream.mockReturnValue(() => {})
    apiMocks.connectionApi.get.mockResolvedValue(null)
    apiMocks.connectionApi.getAll.mockResolvedValue({ success: true, connections: [] })
    apiMocks.dbApi.setting.get.mockResolvedValue(null)
    apiMocks.dbApi.setting.set.mockResolvedValue(true)
    apiMocks.dbApi.sessionActivity.list.mockResolvedValue([])
    apiMocks.dbApi.sessionMessage.list.mockResolvedValue([])
    apiMocks.dbApi.worktree.get.mockResolvedValue({
      id: 'wt-1',
      project_id: 'proj-1',
      name: 'WT',
      branch_name: 'main',
      path: '/tmp/worktree-handoff',
      status: 'active',
      is_default: true,
      created_at: new Date().toISOString(),
      last_accessed_at: new Date().toISOString()
    })
    apiMocks.dbApi.worktree.update.mockResolvedValue(null)
    apiMocks.dbApi.worktree.touch.mockResolvedValue(undefined)
    apiMocks.dbApi.project.getAll.mockResolvedValue([])
    mockKanban.ticket.getBySession.mockResolvedValue([
      {
        id: 'ticket-1',
        project_id: 'proj-1',
        current_session_id: 'session-plan-old',
        plan_ready: true,
        mode: 'plan'
      }
    ])
    mockKanban.ticket.update.mockResolvedValue(undefined)
    mockKanban.ticket.getByProject.mockResolvedValue([])
    apiMocks.kanbanApi.dependency.getForProject.mockResolvedValue([])

    mockDbSession.get.mockResolvedValue(createSessionRecord())
    mockDbSession.getDraft.mockResolvedValue(null)
    mockDbSession.updateDraft.mockResolvedValue(undefined)
    mockDbSession.getActiveByWorktree.mockResolvedValue([])
    mockDbSession.getActiveByConnection.mockResolvedValue([])
    mockDbSession.update.mockImplementation(
      async (sessionId: string, data: Record<string, unknown>) =>
        ({
          ...createSessionRecord({ id: sessionId }),
          ...data
        })
    )
    mockDbSession.create.mockResolvedValue(
      createSessionRecord({
        id: 'session-build-new',
        mode: 'build',
        opencode_session_id: null,
        name: 'Session 2'
      })
    )
    apiMocks.loggingApi.createResponseLog.mockResolvedValue('/tmp/log.jsonl')
    apiMocks.loggingApi.appendResponseLog.mockResolvedValue(undefined)
    apiMocks.opencodeApi.reconnect.mockResolvedValue({ success: true })
    apiMocks.opencodeApi.connect.mockResolvedValue({ success: false })
    apiMocks.opencodeApi.prompt.mockResolvedValue({ success: true })
    apiMocks.opencodeApi.command.mockResolvedValue({ success: true })
    apiMocks.opencodeApi.fork.mockResolvedValue({ success: true })
    apiMocks.opencodeApi.sessionInfo.mockResolvedValue({
      success: true,
      revertMessageID: null,
      revertDiff: null
    })
    apiMocks.opencodeApi.undo.mockResolvedValue({ success: true })
    apiMocks.opencodeApi.redo.mockResolvedValue({ success: true })
    apiMocks.opencodeApi.disconnect.mockResolvedValue({ success: true })
    apiMocks.opencodeApi.abort.mockResolvedValue({ success: true })
    apiMocks.opencodeApi.getMessages.mockResolvedValue({
      success: true,
      messages: [
        {
          info: {
            id: 'turn-1:user',
            role: 'user',
            time: { created: Date.now() - 2000 }
          },
          parts: [{ type: 'text', text: 'Please draft a plan' }]
        },
        {
          info: {
            id: 'turn-1:assistant',
            role: 'assistant',
            time: { created: Date.now() - 1000 }
          },
          parts: [{ type: 'text', text: '1. Add the relink helper\n2. Use it during handoff' }]
        }
      ]
    })
    apiMocks.opencodeApi.listModels.mockResolvedValue({ success: true, providers: [] })
    apiMocks.opencodeApi.setModel.mockResolvedValue({ success: true })
    apiMocks.opencodeApi.modelInfo.mockResolvedValue({ success: true })
    apiMocks.opencodeApi.questionReply.mockResolvedValue({ success: true })
    apiMocks.opencodeApi.questionReject.mockResolvedValue({ success: true })
    apiMocks.opencodeApi.permissionReply.mockResolvedValue({ success: true })
    apiMocks.opencodeApi.permissionList.mockResolvedValue({ success: true, permissions: [] })
    apiMocks.opencodeApi.commands.mockResolvedValue({ success: true, commands: [] })
    apiMocks.opencodeApi.capabilities.mockResolvedValue({
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
    })
    apiMocks.opencodeApi.onStream.mockReturnValue(() => {})
    apiMocks.petApi.hide.mockResolvedValue(undefined)
    apiMocks.petApi.show.mockResolvedValue(undefined)
    apiMocks.petApi.updateSettings.mockResolvedValue({ success: true })
    apiMocks.scriptApi.onStarted.mockReturnValue(() => {})
    apiMocks.scriptApi.onOutput.mockReturnValue(() => {})
    apiMocks.scriptApi.onFinished.mockReturnValue(() => {})
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
      opencode: false,
      claude: true,
      codex: false
    })
    apiMocks.systemApi.setSessionQueuedState.mockResolvedValue(undefined)
    apiMocks.telegramApi.getConfig.mockResolvedValue(null)
    apiMocks.telegramApi.getStatus.mockResolvedValue({
      active: false,
      sessionId: null,
      worktreeId: null,
      connectionId: null,
      mode: null,
      health: 'ok',
      lastError: null
    })
    apiMocks.telegramApi.onStatusChanged.mockReturnValue(() => {})
    apiMocks.telegramApi.onMessageReceived.mockReturnValue(() => {})
    apiMocks.telegramApi.onPlanImplementRequested.mockReturnValue(() => {})
    apiMocks.terminalApi.destroy.mockResolvedValue({ success: true })
    apiMocks.terminalApi.onOutput.mockReturnValue(() => {})
    apiMocks.terminalApi.onExit.mockReturnValue(() => {})
    apiMocks.terminalApi.onCreated.mockReturnValue(() => {})
    apiMocks.terminalApi.onClosed.mockReturnValue(() => {})
    apiMocks.updaterApi.onChecking.mockReturnValue(() => {})
    apiMocks.updaterApi.onUpdateAvailable.mockReturnValue(() => {})
    apiMocks.updaterApi.onUpdateNotAvailable.mockReturnValue(() => {})
    apiMocks.updaterApi.onProgress.mockReturnValue(() => {})
    apiMocks.updaterApi.onUpdateDownloaded.mockReturnValue(() => {})
    apiMocks.updaterApi.onError.mockReturnValue(() => {})
    apiMocks.updaterApi.onUpdateStatus.mockReturnValue(() => {})
    mockWorktreeOps.duplicate.mockResolvedValue(
      {
        success: true,
        worktree: {
          id: 'wt-2',
          project_id: 'proj-1',
          name: 'add-user-authentication',
          branch_name: 'add-user-authentication',
          path: '/tmp/worktree-supercharged',
          status: 'active',
          is_default: false,
          branch_renamed: 0,
          last_message_at: null,
          session_titles: '[]',
          last_model_provider_id: null,
          last_model_id: null,
          last_model_variant: null,
          attachments: '[]',
          pinned: 0,
          context: null,
          github_pr_number: null,
          github_pr_url: null,
          base_branch: null,
          created_at: new Date().toISOString(),
          last_accessed_at: new Date().toISOString()
        }
      }
    )
  })

  afterEach(() => {
    cleanup()
  })

  test('handoff persists ticket relink even when kanban store has not loaded the ticket', async () => {
    render(<SessionView sessionId="session-plan-old" />)

    await waitFor(() => {
      expect(screen.getByTestId('plan-ready-handoff-fab')).toBeInTheDocument()
    })

    await act(async () => {
      fireEvent.click(screen.getByTestId('plan-ready-handoff-fab'))
    })

    await waitFor(() => {
      expect(mockKanban.ticket.getBySession).toHaveBeenCalledWith('session-plan-old')
    })

    await waitFor(() => {
      expect(mockKanban.ticket.update).toHaveBeenCalledWith('ticket-1', {
        current_session_id: 'session-build-new',
        plan_ready: false,
        mode: 'build',
        goal_mode: false,
        goal_success_criteria: null
      })
    })

    expect(useSessionStore.getState().activeSessionId).toBe('session-build-new')
    expect(useSessionStore.getState().pendingMessages.get('session-build-new')).toBe(
      'Implement the following plan\n1. Add the relink helper\n2. Use it during handoff'
    )
  })

  test('handoff uses pendingPlan.planContent instead of last assistant message content', async () => {
    useSessionStore.setState({
      pendingPlans: new Map([
        [
          'session-plan-old',
          {
            requestId: 'req-plan-1',
            planContent: '# Real plan\n1. Step one\n2. Step two',
            toolUseID: 'tool-plan-1'
          }
        ]
      ])
    })

    render(<SessionView sessionId="session-plan-old" />)

    await waitFor(() => {
      expect(screen.getByTestId('plan-ready-handoff-fab')).toBeInTheDocument()
    })

    await act(async () => {
      fireEvent.click(screen.getByTestId('plan-ready-handoff-fab'))
    })

    await waitFor(() => {
      expect(useSessionStore.getState().pendingMessages.get('session-build-new')).toBe(
        'Implement the following plan\n# Real plan\n1. Step one\n2. Step two'
      )
    })
  })

  test('supercharge derives a slug from the plan heading and passes it as nameHint', async () => {
    useSessionStore.setState({
      pendingPlans: new Map([
        [
          'session-plan-old',
          {
            requestId: 'req-plan-1',
            planContent: '# Add user authentication\n\n1. Build login UI\n2. Wire auth API',
            toolUseID: 'tool-plan-1'
          }
        ]
      ])
    })

    render(<SessionView sessionId="session-plan-old" />)

    await waitFor(() => {
      expect(screen.getByTestId('plan-ready-supercharge-fab')).toBeInTheDocument()
    })

    await act(async () => {
      fireEvent.click(screen.getByTestId('plan-ready-supercharge-fab'))
    })

    await waitFor(() => {
      expect(mockWorktreeOps.duplicate).toHaveBeenCalledWith({
        projectId: 'proj-1',
        projectPath: '/tmp/project-1',
        projectName: 'Project 1',
        sourceBranch: 'main',
        sourceWorktreePath: '/tmp/worktree-handoff',
        nameHint: 'add-user-authentication'
      })
    })
  })
})
