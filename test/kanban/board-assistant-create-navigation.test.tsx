import { beforeEach, describe, expect, test, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { BoardAssistantView } from '../../src/renderer/src/components/kanban/BoardAssistantView'
import { useBoardChatStore, type TicketDraft } from '../../src/renderer/src/stores/useBoardChatStore'
import { useProjectStore } from '../../src/renderer/src/stores/useProjectStore'
import { useWorktreeStore } from '../../src/renderer/src/stores/useWorktreeStore'
import { useKanbanStore } from '../../src/renderer/src/stores/useKanbanStore'
import { useSettingsStore } from '../../src/renderer/src/stores/useSettingsStore'
import { useSessionStore, BOARD_TAB_ID } from '../../src/renderer/src/stores/useSessionStore'

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

  Object.defineProperty(window, 'kanban', {
    writable: true,
    configurable: true,
    value: {
      ticket: {
        createBatch: vi.fn().mockResolvedValue({
          tickets: [{ id: 'ticket-1' }],
          dependencies: []
        })
      }
    }
  })

  const store = useBoardChatStore.getState()
  const scope = {
    kind: 'project' as const,
    projectId,
    projectName: 'Project One',
    projectPath: '/tmp/proj-1'
  }
  store.activateScope(scope, { scope })
  useBoardChatStore.setState({
    scope,
    messages: [
      {
        id: assistantMessageId,
        role: 'assistant',
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
        kind: 'transcript'
      }
    ],
    drafts: [boardDraft],
    draftSourceMessageId: assistantMessageId,
    status: 'awaiting_confirmation'
  })
}

describe('board assistant create navigation', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  test('switches to the sticky board tab after creating tickets', async () => {
    seedStores('sticky-tab')

    render(<BoardAssistantView projectId={projectId} />)
    fireEvent.click(screen.getByRole('button', { name: 'Create all' }))

    await waitFor(() => {
      expect(useSessionStore.getState().activeSessionId).toBe(BOARD_TAB_ID)
    })
    expect(useSessionStore.getState().activeBoardAssistantProjectId).toBeNull()
  })

  test('switches back to the toggle board view after creating tickets', async () => {
    seedStores('toggle')

    render(<BoardAssistantView projectId={projectId} />)
    fireEvent.click(screen.getByRole('button', { name: 'Create all' }))

    await waitFor(() => {
      expect(useKanbanStore.getState().isBoardViewActive).toBe(true)
    })
    expect(useSessionStore.getState().activeBoardAssistantProjectId).toBeNull()
  })
})
