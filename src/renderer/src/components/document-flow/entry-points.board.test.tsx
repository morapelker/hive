/**
 * The board's Import dropdown (right end of the session tab strip) offers "Implement
 * document…" for the project of the selected worktree.
 */
import { act, cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { SessionTabs } from '@/components/sessions/SessionTabs'
import { useConnectionStore } from '@/stores/useConnectionStore'
import { useDocumentFlowStore } from '@/stores/useDocumentFlowStore'
import { useKanbanStore } from '@/stores/useKanbanStore'
import { useProjectStore } from '@/stores/useProjectStore'
import { useWorktreeStore } from '@/stores/useWorktreeStore'

vi.mock('@/lib/toast', () => ({
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() }
}))

const initialFlowState = useDocumentFlowStore.getState()
const initialProjectState = useProjectStore.getState()
const initialWorktreeState = useWorktreeStore.getState()
const initialConnectionState = useConnectionStore.getState()
const initialKanbanState = useKanbanStore.getState()

beforeAll(() => {
  // Radix menus rely on these in a real browser; jsdom lacks them.
  Element.prototype.hasPointerCapture = vi.fn()
  Element.prototype.releasePointerCapture = vi.fn()
  Element.prototype.scrollIntoView = vi.fn()
})

beforeEach(() => {
  useProjectStore.setState({
    projects: [{ id: 'alpha', name: 'alpha', path: '/tmp/alpha' }]
  } as never)
  useWorktreeStore.setState({
    selectedWorktreeId: 'wt-1',
    worktreesByProject: new Map([
      ['alpha', [{ id: 'wt-1', project_id: 'alpha', name: 'main', path: '/tmp/alpha' }]]
    ])
  } as never)
  useConnectionStore.setState({ selectedConnectionId: null, connections: [] } as never)
  useKanbanStore.setState({ isBoardViewActive: true } as never)
})

afterEach(() => {
  cleanup()
  useDocumentFlowStore.setState(initialFlowState, true)
  useProjectStore.setState(initialProjectState, true)
  useWorktreeStore.setState(initialWorktreeState, true)
  useConnectionStore.setState(initialConnectionState, true)
  useKanbanStore.setState(initialKanbanState, true)
})

describe('board Import dropdown', () => {
  it('opens the wizard for the project of the selected worktree', async () => {
    const user = userEvent.setup()
    await act(async () => {
      render(<SessionTabs />)
    })

    await user.click(screen.getByTestId('kanban-import-btn'))
    const items = (await screen.findAllByRole('menuitem')).map((item) => item.textContent)
    // Sits with the imports, above the separator that sets Export apart.
    expect(items).toEqual([
      'Import from GitHub',
      'Import from Jira',
      'Import from Hive JSON',
      'Implement document…',
      'Export Board'
    ])

    await user.click(screen.getByTestId('docflow-import-menu-item'))

    expect(useDocumentFlowStore.getState().wizard).toEqual({
      open: true,
      projectId: 'alpha',
      runId: null
    })
  })
})
