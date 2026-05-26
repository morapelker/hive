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

import { SessionView } from '../../../src/renderer/src/components/sessions/SessionView'
import { useKanbanStore } from '../../../src/renderer/src/stores/useKanbanStore'
import { useProjectStore } from '../../../src/renderer/src/stores/useProjectStore'
import { useSessionStore } from '../../../src/renderer/src/stores/useSessionStore'
import { useSettingsStore } from '../../../src/renderer/src/stores/useSettingsStore'
import { useWorktreeStore } from '../../../src/renderer/src/stores/useWorktreeStore'
import { useWorktreeStatusStore } from '../../../src/renderer/src/stores/useWorktreeStatusStore'

function envelope<T>(value: T): { success: true; value: T } {
  return { success: true, value }
}

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
  const mockKanban = {
    ticket: {
      getBySession: vi.fn(),
      update: vi.fn()
    }
  }

  const mockWorktreeOps = {
    duplicate: vi.fn()
  }

  const mockDbSession = {
    get: vi.fn(),
    getDraft: vi.fn(),
    updateDraft: vi.fn(),
    update: vi.fn(),
    create: vi.fn()
  }

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

    mockKanban.ticket.getBySession.mockResolvedValue(
      envelope([
        {
          id: 'ticket-1',
          project_id: 'proj-1',
          current_session_id: 'session-plan-old',
          plan_ready: true,
          mode: 'plan'
        }
      ])
    )
    mockKanban.ticket.update.mockResolvedValue(envelope(undefined))

    mockDbSession.get.mockResolvedValue(envelope(createSessionRecord()))
    mockDbSession.getDraft.mockResolvedValue(envelope(null))
    mockDbSession.updateDraft.mockResolvedValue(envelope(undefined))
    mockDbSession.update.mockImplementation(
      async (sessionId: string, data: Record<string, unknown>) =>
        envelope({
          ...createSessionRecord({ id: sessionId }),
          ...data
        })
    )
    mockDbSession.create.mockResolvedValue(
      envelope(
        createSessionRecord({
          id: 'session-build-new',
          mode: 'build',
          opencode_session_id: null,
          name: 'Session 2'
        })
      )
    )
    mockWorktreeOps.duplicate.mockResolvedValue(
      envelope({
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
      })
    )

    Object.defineProperty(window, 'kanban', {
      value: mockKanban,
      writable: true,
      configurable: true
    })

    Object.defineProperty(window, 'db', {
      value: {
        session: mockDbSession,
        worktree: {
          get: vi.fn().mockResolvedValue(
            envelope({
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
          ),
          update: vi.fn().mockResolvedValue(envelope(null))
        }
      },
      writable: true,
      configurable: true
    })

    Object.defineProperty(window, 'opencodeOps', {
      value: {
        reconnect: vi.fn().mockResolvedValue(envelope({ success: true })),
        connect: vi.fn().mockResolvedValue(envelope({ success: false })),
        prompt: vi.fn().mockResolvedValue(envelope({ success: true })),
        command: vi.fn().mockResolvedValue(envelope({ success: true })),
        fork: vi.fn().mockResolvedValue(envelope({ success: true })),
        sessionInfo: vi
          .fn()
          .mockResolvedValue(envelope({ success: true, revertMessageID: null, revertDiff: null })),
        undo: vi.fn().mockResolvedValue(envelope({ success: true })),
        redo: vi.fn().mockResolvedValue(envelope({ success: true })),
        disconnect: vi.fn().mockResolvedValue(envelope({ success: true })),
        abort: vi.fn().mockResolvedValue(envelope({ success: true })),
        getMessages: vi.fn().mockResolvedValue(
          envelope({
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
                parts: [
                  { type: 'text', text: '1. Add the relink helper\n2. Use it during handoff' }
                ]
              }
            ]
          })
        ),
        listModels: vi.fn().mockResolvedValue(envelope({ success: true, providers: [] })),
        setModel: vi.fn().mockResolvedValue(envelope({ success: true })),
        modelInfo: vi.fn().mockResolvedValue(envelope({ success: true })),
        questionReply: vi.fn().mockResolvedValue(envelope({ success: true })),
        questionReject: vi.fn().mockResolvedValue(envelope({ success: true })),
        permissionReply: vi.fn().mockResolvedValue(envelope({ success: true })),
        permissionList: vi.fn().mockResolvedValue(envelope({ success: true, permissions: [] })),
        commands: vi.fn().mockResolvedValue(envelope({ success: true, commands: [] })),
        capabilities: vi.fn().mockResolvedValue(
          envelope({
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
        ),
        onStream: vi.fn().mockImplementation(() => () => {})
      },
      writable: true,
      configurable: true
    })

    Object.defineProperty(window, 'systemOps', {
      value: {
        isLogMode: vi.fn().mockResolvedValue(false),
        getLogDir: vi.fn().mockResolvedValue('/tmp/logs'),
        getAppVersion: vi.fn().mockResolvedValue('1.0.0'),
        getAppPaths: vi
          .fn()
          .mockResolvedValue({ userData: '/tmp', home: '/tmp', logs: '/tmp/logs' }),
        setSessionQueuedState: vi.fn().mockResolvedValue(undefined)
      },
      writable: true,
      configurable: true
    })

    Object.defineProperty(window, 'loggingOps', {
      value: {
        createResponseLog: vi.fn().mockResolvedValue('/tmp/log.jsonl'),
        appendResponseLog: vi.fn().mockResolvedValue(undefined)
      },
      writable: true,
      configurable: true
    })

    Object.defineProperty(window, 'bash', {
      value: {
        getRun: vi.fn().mockResolvedValue(envelope(null)),
        onStream: vi.fn().mockImplementation(() => () => {})
      },
      writable: true,
      configurable: true
    })

    Object.defineProperty(window, 'worktreeOps', {
      value: mockWorktreeOps,
      writable: true,
      configurable: true
    })
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
