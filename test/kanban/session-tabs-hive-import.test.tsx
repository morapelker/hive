import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom'
import type { ReactNode } from 'react'
import { SessionTabs } from '../../src/renderer/src/components/sessions/SessionTabs'
import { resetRendererRpcClientForTests, setRendererRpcClient } from '@/api/rpc-client'
import { BOARD_TAB_ID, useSessionStore } from '@/stores/useSessionStore'
import { toast } from '@/lib/toast'
import { useConnectionStore } from '@/stores/useConnectionStore'
import { useFileViewerStore } from '@/stores/useFileViewerStore'
import { useKanbanStore } from '@/stores/useKanbanStore'
import { useProjectStore } from '@/stores/useProjectStore'
import { useWorktreeStore } from '@/stores/useWorktreeStore'

vi.mock('@/components/ui/dropdown-menu', () => ({
  DropdownMenu: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DropdownMenuTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
  DropdownMenuContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DropdownMenuItem: ({
    children,
    onClick
  }: {
    children: ReactNode
    onClick?: () => void | Promise<void>
  }) => (
    <button type="button" onClick={() => void onClick?.()}>
      {children}
    </button>
  ),
  DropdownMenuSeparator: () => <hr />
}))

vi.mock('@/lib/toast', () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn()
  }
}))

vi.mock('@/components/kanban/TicketCreateModal', () => ({
  TicketCreateModal: () => null
}))

vi.mock('@/components/kanban/ImportTicketsModal', () => ({
  ImportTicketsModal: () => null
}))

vi.mock('@/components/kanban/JiraImportModal', () => ({
  JiraImportModal: () => null
}))

vi.mock('@/components/kanban/HiveImportModal', () => ({
  HiveImportModal: ({
    open,
    tickets,
    dependencies
  }: {
    open: boolean
    tickets: Array<{ id: string }>
    dependencies?: Array<{ dependentId: string; blockerId: string }>
  }) =>
    open ? (
      <div data-testid="hive-import-modal">
        {tickets.length}:{dependencies?.length ?? 0}
      </div>
    ) : null
}))

vi.mock('@/stores/useSettingsStore', () => ({
  useSettingsStore: Object.assign(
    (selector: (state: Record<string, unknown>) => unknown) =>
      selector({
        autoStartSession: false,
        availableAgentSdks: { opencode: true, claude: false, codex: false },
        boardMode: 'sticky-tab',
        defaultAgentSdk: 'opencode',
        selectedModel: null
      }),
    {
      getState: () => ({
        autoStartSession: false,
        availableAgentSdks: { opencode: true, claude: false, codex: false },
        boardMode: 'sticky-tab',
        defaultAgentSdk: 'opencode',
        selectedModel: null
      })
    }
  )
}))

describe('SessionTabs Hive JSON import', () => {
  let request: ReturnType<typeof vi.fn>

  beforeEach(() => {
    request = vi.fn((method: string) => {
      if (method === 'kanban.board.openImportFile') {
        return Promise.resolve({
          tickets: [
            {
              id: 'ticket-1',
              title: 'Imported ticket',
              description: null,
              attachments: [],
              column: 'todo'
            }
          ],
          dependencies: [{ dependentId: 'ticket-1', blockerId: 'ticket-2' }],
          projectName: null
        })
      }
      if (method === 'kanban.board.export') {
        return Promise.resolve({
          success: true,
          ticketCount: 3,
          path: '/tmp/Hive.hive.json'
        })
      }
      return Promise.resolve(undefined)
    })
    setRendererRpcClient({ request, subscribe: vi.fn() })

    useConnectionStore.setState({
      selectedConnectionId: null,
      connections: []
    })
    useFileViewerStore.setState({
      openFiles: new Map(),
      activeFilePath: null,
      activeDiff: null
    })
    useKanbanStore.setState({
      isBoardViewActive: true
    })
    useProjectStore.setState({
      projects: [
        {
          id: 'project-1',
          name: 'Hive',
          path: '/repo/hive',
          description: null,
          tags: null,
          language: null,
          custom_icon: null,
          detected_icon: null,
          setup_script: null,
          run_script: null,
          archive_script: null,
          auto_assign_port: false,
          sort_order: 0,
          created_at: '2026-05-29T00:00:00.000Z',
          last_accessed_at: '2026-05-29T00:00:00.000Z'
        }
      ]
    })
    useWorktreeStore.setState({
      selectedWorktreeId: 'worktree-1',
      worktreesByProject: new Map([
        [
          'project-1',
          [
            {
              id: 'worktree-1',
              project_id: 'project-1',
              name: 'main',
              branch_name: 'main',
              path: '/repo/hive',
              status: 'active',
              is_default: true,
              branch_renamed: 0,
              last_message_at: null,
              session_titles: '[]',
              last_model_provider_id: null,
              last_model_id: null,
              last_model_variant: null,
              created_at: '2026-05-29T00:00:00.000Z',
              last_accessed_at: '2026-05-29T00:00:00.000Z',
              github_pr_number: null,
              github_pr_url: null
            }
          ]
        ]
      ])
    })
    useSessionStore.setState({
      activeSessionId: BOARD_TAB_ID,
      activeWorktreeId: 'worktree-1',
      activeSessionByWorktree: { 'worktree-1': BOARD_TAB_ID },
      activePinnedSessionId: null,
      inlineConnectionSessionId: null,
      orphanedSessions: new Set(),
      pinnedSessionIds: new Set(),
      sessionsByWorktree: new Map(),
      tabOrderByWorktree: new Map(),
      sessionsByConnection: new Map(),
      tabOrderByConnection: new Map(),
      loadSessions: vi.fn().mockResolvedValue(undefined)
    })
  })

  afterEach(() => {
    resetRendererRpcClientForTests()
    vi.clearAllMocks()
  })

  test('opens Hive JSON import through kanbanApi', async () => {
    render(<SessionTabs />)

    fireEvent.click(screen.getByRole('button', { name: /Import from Hive JSON/i }))

    await waitFor(() => {
      expect(request).toHaveBeenCalledWith('kanban.board.openImportFile', {})
    })
    expect(await screen.findByTestId('hive-import-modal')).toHaveTextContent('1:1')
  })

  test('exports the board through kanbanApi', async () => {
    render(<SessionTabs />)

    fireEvent.click(screen.getByRole('button', { name: /Export Board/i }))

    await waitFor(() => {
      expect(request).toHaveBeenCalledWith('kanban.board.export', {
        projectId: 'project-1',
        projectName: 'Hive'
      })
    })
    expect(toast.success).toHaveBeenCalledWith('Exported 3 tickets')
  })
})
