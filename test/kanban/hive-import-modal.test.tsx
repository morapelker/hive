import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { toast } from 'sonner'
import { HiveImportModal } from '../../src/renderer/src/components/kanban/HiveImportModal'
import { resetRendererRpcClientForTests, setRendererRpcClient } from '@/api/rpc-client'
import { useKanbanStore } from '@/stores/useKanbanStore'

vi.mock('sonner', () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn()
  }
}))

vi.mock('@/api/settings-api', () => ({
  settingsApi: {
    detectEditors: vi.fn().mockResolvedValue([]),
    detectTerminals: vi.fn().mockResolvedValue([]),
    openWithTerminal: vi.fn().mockResolvedValue({ success: true }),
    onSettingsUpdated: vi.fn(() => () => {})
  }
}))

vi.mock('@/api/pet-api', () => ({
  petApi: {
    hide: vi.fn().mockResolvedValue(undefined),
    show: vi.fn().mockResolvedValue(undefined),
    updateSettings: vi.fn(),
    onStatus: vi.fn(() => () => {}),
    onSettingsUpdated: vi.fn(() => () => {}),
    onJumpToWorktree: vi.fn(() => () => {})
  }
}))

describe('HiveImportModal', () => {
  let request: ReturnType<typeof vi.fn>
  let loadTickets: ReturnType<typeof vi.fn>
  let loadDependencies: ReturnType<typeof vi.fn>
  let onOpenChange: ReturnType<typeof vi.fn>

  beforeEach(() => {
    request = vi.fn((method: string) => {
      if (method === 'kanban.board.importTickets') {
        return Promise.resolve({
          created: 2,
          updated: 0,
          dependencyCount: 1,
          ignoredDependencyCount: 0
        })
      }
      return Promise.resolve(undefined)
    })
    setRendererRpcClient({ request, subscribe: vi.fn() })

    loadTickets = vi.fn().mockResolvedValue(undefined)
    loadDependencies = vi.fn().mockResolvedValue(undefined)
    onOpenChange = vi.fn()
    useKanbanStore.setState({
      tickets: new Map(),
      loadTickets,
      loadDependencies
    })
  })

  afterEach(() => {
    resetRendererRpcClientForTests()
    vi.clearAllMocks()
  })

  test('imports selected tickets through kanbanApi and reloads board data', async () => {
    const tickets = [
      {
        id: 'ticket-1',
        title: 'Imported ticket one',
        description: null,
        attachments: [],
        column: 'todo'
      },
      {
        id: 'ticket-2',
        title: 'Imported ticket two',
        description: 'Second ticket',
        attachments: [],
        column: 'review'
      }
    ]
    const dependencies = [
      { dependentId: 'ticket-2', blockerId: 'ticket-1' },
      { dependentId: 'ticket-2', blockerId: 'external-ticket' }
    ]

    render(
      <HiveImportModal
        open
        onOpenChange={onOpenChange}
        projectId="project-1"
        tickets={tickets}
        dependencies={dependencies}
      />
    )

    fireEvent.click(screen.getByRole('button', { name: 'Import 2 tickets' }))

    await waitFor(() => {
      expect(request).toHaveBeenCalledWith('kanban.board.importTickets', {
        projectId: 'project-1',
        tickets,
        dependencies: [{ dependentId: 'ticket-2', blockerId: 'ticket-1' }]
      })
    })
    expect(loadTickets).toHaveBeenCalledWith('project-1')
    expect(loadDependencies).toHaveBeenCalledWith('project-1')
    expect(toast.success).toHaveBeenCalledWith(
      'Import complete: 2 created, 1 dependencies restored'
    )
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })
})
