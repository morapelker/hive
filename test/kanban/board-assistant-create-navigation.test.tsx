import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { BoardAssistantView } from '../../src/renderer/src/components/kanban/BoardAssistantView'
import {
  useBoardChatStore,
  type TicketDraft
} from '../../src/renderer/src/stores/useBoardChatStore'
import { useProjectStore } from '../../src/renderer/src/stores/useProjectStore'
import { useWorktreeStore } from '../../src/renderer/src/stores/useWorktreeStore'
import { useKanbanStore } from '../../src/renderer/src/stores/useKanbanStore'
import { useSettingsStore } from '../../src/renderer/src/stores/useSettingsStore'
import { useSessionStore, BOARD_TAB_ID } from '../../src/renderer/src/stores/useSessionStore'
import {
  resetRendererRpcClientForTests,
  setRendererRpcClient
} from '../../src/renderer/src/api/rpc-client'

vi.mock('../../src/renderer/src/api/settings-api', () => ({
  settingsApi: {
    detectEditors: vi.fn().mockResolvedValue([]),
    detectTerminals: vi.fn().mockResolvedValue([]),
    loadCustomCommandsFile: vi.fn().mockResolvedValue({ success: true, commands: [] }),
    openWithTerminal: vi.fn().mockResolvedValue({ success: true }),
    onSettingsUpdated: vi.fn(() => () => {})
  }
}))

vi.mock('../../src/renderer/src/api/hive-enterprise/client', () => ({
  hiveEnterpriseClient: {
    query: vi.fn()
  }
}))

vi.mock('../../src/renderer/src/api/pet-api', () => ({
  petApi: {
    hide: vi.fn().mockResolvedValue(undefined),
    show: vi.fn().mockResolvedValue(undefined),
    updateSettings: vi.fn(),
    onStatus: vi.fn(() => () => {}),
    onSettingsUpdated: vi.fn(() => () => {}),
    onJumpToWorktree: vi.fn(() => () => {})
  }
}))

vi.mock('../../src/renderer/src/api/db-api', () => ({
  dbApi: {
    setting: {
      get: vi.fn().mockResolvedValue(null),
      set: vi.fn().mockResolvedValue(undefined)
    }
  }
}))

vi.mock('../../src/renderer/src/hooks/useSessionStream', () => ({
  useSessionStream: () => ({
    messages: [],
    streamingParts: [],
    streamingContent: '',
    isStreaming: false,
    isLoading: false
  })
}))

vi.mock('../../src/renderer/src/lib/toast', () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn()
  }
}))

const projectId = 'proj-1'
const assistantMessageId = 'assistant-msg-1'
let request: ReturnType<typeof vi.fn>

const boardDraft: TicketDraft = {
  id: `${assistantMessageId}:draft-1:${projectId}`,
  draftKey: 'draft-1',
  title: 'Create persistence ticket',
  description: 'Persist the board assistant state',
  dependsOn: [],
  resolvedDependsOnTitles: [],
  warnings: [],
  validationIssues: [],
  projectId,
  projectName: 'Project One',
  selected: true,
  createdAt: null
}

function seedStores(boardMode: 'sticky-tab' | 'toggle') {
  useBoardChatStore.setState(useBoardChatStore.getInitialState())

  useProjectStore.setState({
    selectedProjectId: projectId,
    projects: [
      {
        id: projectId,
        name: 'Project One',
        path: '/tmp/proj-1',
        description: null,
        tags: null,
        language: null,
        custom_icon: null,
        setup_script: null,
        run_script: null,
        archive_script: null,
        sort_order: 0,
        created_at: '2026-04-15T00:00:00.000Z',
        last_accessed_at: '2026-04-15T00:00:00.000Z'
      }
    ]
  })

  useWorktreeStore.setState({
    selectedWorktreeId: 'wt-1',
    worktreesByProject: new Map([
      [
        projectId,
        [
          {
            id: 'wt-1',
            project_id: projectId,
            name: 'main',
            branch_name: 'main',
            path: '/tmp/proj-1',
            status: 'active',
            is_default: true,
            branch_renamed: 0,
            last_message_at: null,
            session_titles: '[]',
            last_model_provider_id: null,
            last_model_id: null,
            last_model_variant: null,
            created_at: '2026-04-15T00:00:00.000Z',
            last_accessed_at: '2026-04-15T00:00:00.000Z',
            github_pr_number: null,
            github_pr_url: null
          }
        ]
      ]
    ])
  })

  useKanbanStore.setState({
    tickets: new Map([[projectId, []]]),
    isBoardViewActive: false,
    isPinnedBoardActive: false,
    loadTickets: vi.fn().mockResolvedValue(undefined),
    loadDependencies: vi.fn().mockResolvedValue(undefined)
  })

  useSettingsStore.setState({
    boardMode,
    defaultAgentSdk: 'opencode'
  })

  useSessionStore.setState({
    activeSessionId: null,
    activeBoardAssistantProjectId: projectId,
    activePinnedSessionId: null,
    inlineConnectionSessionId: null
  })

  request = vi.fn((method: string) => {
    if (method === 'kanban.ticket.createBatch') {
      return Promise.resolve({
        tickets: [{ id: 'ticket-1' }],
        dependencies: []
      })
    }
    if (method === 'opencodeOps.listModels') {
      return Promise.resolve({ success: true, providers: [] })
    }
    return Promise.resolve(undefined)
  })
  setRendererRpcClient({ request, subscribe: vi.fn() })

  const store = useBoardChatStore.getState()
  const scope = {
    kind: 'project' as const,
    projectId,
    projectName: 'Project One',
    projectPath: '/tmp/proj-1'
  }
  store.activateScope(scope, { scope })
  const messages = [
    {
      id: assistantMessageId,
      role: 'assistant' as const,
      content: [
        'Ready.',
        '```board-ticket-drafts',
        JSON.stringify({
          drafts: [
            {
              draftKey: 'draft-1',
              title: boardDraft.title,
              description: boardDraft.description,
              projectId,
              dependsOn: [],
              warnings: []
            }
          ]
        }),
        '```'
      ].join('\n'),
      timestamp: '2026-04-15T00:00:00.000Z',
      kind: 'transcript' as const
    }
  ]
  const seededSnapshot = {
    scope,
    messages,
    drafts: [boardDraft],
    createdDraftIds: [],
    draftSourceMessageId: assistantMessageId,
    status: 'awaiting_confirmation' as const,
    selectedTargetProjectId: projectId,
    error: null,
    sessionId: null,
    opencodeSessionId: null,
    runtimePath: null,
    selectedAgentSdkOverride: null,
    selectedModelOverride: null,
    composerValue: ''
  }
  useBoardChatStore.setState({
    scope,
    messages,
    drafts: [boardDraft],
    draftSourceMessageId: assistantMessageId,
    status: 'awaiting_confirmation',
    snapshots: {
      [`project:${projectId}`]: seededSnapshot
    }
  })
}

describe('board assistant create navigation', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resetRendererRpcClientForTests()
  })

  afterEach(() => {
    resetRendererRpcClientForTests()
  })

  test('switches to the sticky board tab after creating tickets', async () => {
    seedStores('sticky-tab')

    render(<BoardAssistantView projectId={projectId} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Create all' }))

    await waitFor(() => {
      expect(useSessionStore.getState().activeSessionId).toBe(BOARD_TAB_ID)
    })
    expect(request).toHaveBeenCalledWith('kanban.ticket.createBatch', {
      projectId,
      data: {
        drafts: [
          {
            draft_key: 'draft-1',
            project_id: projectId,
            title: boardDraft.title,
            description: boardDraft.description,
            column: 'todo',
            depends_on: []
          }
        ]
      }
    })
    expect(useSessionStore.getState().activeBoardAssistantProjectId).toBeNull()
  })

  test('switches back to the toggle board view after creating tickets', async () => {
    seedStores('toggle')

    render(<BoardAssistantView projectId={projectId} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Create all' }))

    await waitFor(() => {
      expect(useKanbanStore.getState().isBoardViewActive).toBe(true)
    })
    expect(useSessionStore.getState().activeBoardAssistantProjectId).toBeNull()
  })

  test('marks successful project draft batches before surfacing partial failures', async () => {
    seedStores('sticky-tab')
    const failedProjectId = 'proj-2'
    const failedDraft: TicketDraft = {
      ...boardDraft,
      id: `${assistantMessageId}:draft-2:${failedProjectId}`,
      draftKey: 'draft-2',
      title: 'Create markdown ticket',
      description: 'Write the markdown-backed draft',
      projectId: failedProjectId,
      projectName: 'Project Two',
      createdAt: null
    }
    const drafts = [boardDraft, failedDraft]
    useBoardChatStore.setState((state) => ({
      drafts,
      snapshots: {
        ...state.snapshots,
        [`project:${projectId}`]: {
          ...state.snapshots[`project:${projectId}`],
          drafts
        }
      }
    }))

    request = vi.fn((method: string, payload?: { projectId?: string }) => {
      if (method === 'kanban.ticket.createBatch') {
        if (payload?.projectId === failedProjectId) {
          return Promise.reject(new Error('Kanban folder is missing'))
        }
        return Promise.resolve({
          tickets: [{ id: 'ticket-1' }],
          dependencies: []
        })
      }
      if (method === 'opencodeOps.listModels') {
        return Promise.resolve({ success: true, providers: [] })
      }
      return Promise.resolve(undefined)
    })
    setRendererRpcClient({ request, subscribe: vi.fn() })

    await useBoardChatStore.getState().createSelected()

    const state = useBoardChatStore.getState()
    expect(state.drafts.find((draft) => draft.id === boardDraft.id)?.createdAt).toEqual(
      expect.any(String)
    )
    expect(state.drafts.find((draft) => draft.id === failedDraft.id)?.createdAt).toBeNull()
    expect(state.drafts.find((draft) => draft.id === failedDraft.id)?.selected).toBe(true)
    expect(useKanbanStore.getState().loadTickets).toHaveBeenCalledWith(projectId)
    expect(useKanbanStore.getState().loadTickets).not.toHaveBeenCalledWith(failedProjectId)

    expect(request).toHaveBeenCalledTimes(2)
    await useBoardChatStore.getState().createSelected()
    expect(request).toHaveBeenCalledTimes(3)
    expect(request).toHaveBeenLastCalledWith(
      'kanban.ticket.createBatch',
      expect.objectContaining({ projectId: failedProjectId })
    )
  })
})
