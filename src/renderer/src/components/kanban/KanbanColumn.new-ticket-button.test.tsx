/**
 * The To Do column's new-ticket button lives in the column header row, outside the
 * scrollable card list.
 */
import type { PropsWithChildren } from 'react'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { KanbanColumn } from '@/components/kanban/KanbanColumn'
import { TooltipProvider } from '@/components/ui/tooltip'
import { useKanbanStore } from '@/stores/useKanbanStore'
import type { KanbanTicketColumn } from '../../../../main/db/types'

vi.mock('@/components/kanban/KanbanTicketCard', () => ({ KanbanTicketCard: () => null }))
vi.mock('@/components/kanban/WorktreePickerModal', () => ({ WorktreePickerModal: () => null }))
vi.mock('@/components/kanban/TicketCreateModal', () => ({
  TicketCreateModal: ({ open }: { open: boolean }) =>
    open ? <div data-testid="ticket-create-modal" /> : null
}))

vi.mock('motion/react', () => ({
  LayoutGroup: ({ children }: PropsWithChildren) => <>{children}</>,
  motion: {
    div: ({
      children,
      layoutId: _layoutId,
      layout: _layout,
      layoutScroll: _layoutScroll,
      transition: _transition,
      ...props
    }: PropsWithChildren<Record<string, unknown>>) => <div {...props}>{children}</div>
  }
}))

const initialKanbanState = useKanbanStore.getState()

function renderColumn(column: KanbanTicketColumn): void {
  render(
    <TooltipProvider>
      <KanbanColumn column={column} projectId="proj-1" tickets={[]} />
    </TooltipProvider>
  )
}

beforeEach(() => {
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    }
  )
})

afterEach(() => {
  cleanup()
  useKanbanStore.setState(initialKanbanState, true)
  vi.unstubAllGlobals()
})

describe('KanbanColumn new-ticket button', () => {
  it('sits in the To Do header row, not in the card list', () => {
    renderColumn('todo')

    const button = screen.getByRole('button', { name: 'New ticket' })
    const header = screen.getByRole('heading', { name: 'To Do' }).parentElement!.parentElement!
    expect(header).toContainElement(button)
    expect(screen.getByTestId('kanban-drop-area-todo')).not.toContainElement(button)
    // An empty To Do column now reads like any other empty column
    expect(within(screen.getByTestId('kanban-drop-area-todo')).getByText('No tickets')).toBeTruthy()
  })

  it('opens the create-ticket modal', () => {
    renderColumn('todo')

    expect(screen.queryByTestId('ticket-create-modal')).toBeNull()
    fireEvent.click(screen.getByTestId('kanban-column-add-ticket-btn'))
    expect(screen.getByTestId('ticket-create-modal')).toBeTruthy()
  })

  it('is hidden while a board search is active', () => {
    useKanbanStore.setState({ boardSearch: { ...initialKanbanState.boardSearch, open: true, query: 'x' } })
    renderColumn('todo')

    expect(screen.queryByTestId('kanban-column-add-ticket-btn')).toBeNull()
  })

  it('is not rendered on other columns', () => {
    renderColumn('review')

    expect(screen.queryByTestId('kanban-column-add-ticket-btn')).toBeNull()
  })
})
