/**
 * The board's top row (BoardTopRow): which boards have it, and the project's name in its middle.
 * The pin button's own behaviour is in KanbanBoard.pin-to-board.test.tsx.
 */
import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { BoardTopRow } from '@/components/kanban/BoardTopRow'
import { TooltipProvider } from '@/components/ui/tooltip'
import { usePinnedStore } from '@/stores/usePinnedStore'
import { useProjectStore } from '@/stores/useProjectStore'

type RowProps = Parameters<typeof BoardTopRow>[0]

const renderRow = (props: RowProps = { projectId: 'project-1' }): ReturnType<typeof render> =>
  render(
    <TooltipProvider>
      <BoardTopRow {...props} />
    </TooltipProvider>
  )

const row = (): HTMLElement => screen.getByTestId('board-top-row')
const queryRow = (): HTMLElement | null => screen.queryByTestId('board-top-row')
const pinButton = (): HTMLElement => screen.getByTestId('board-pin-button')
const projectName = (): HTMLElement => screen.getByTestId('board-project-name')
const queryProjectName = (): HTMLElement | null => screen.queryByTestId('board-project-name')

/**
 * Puts the board's project in the project list: only then is its board one with a name and a
 * pin button.
 */
const listProject = (id = 'project-1', kind?: 'git' | 'connection', name = id): void => {
  act(() => {
    useProjectStore.setState({ projects: [{ id, name, ...(kind ? { kind } : {}) }] as never })
  })
}

beforeEach(() => {
  useProjectStore.setState({ projects: [] })
  usePinnedStore.setState({ pinnedProjectIds: new Set(), loaded: true })
})

afterEach(() => {
  cleanup()
  useProjectStore.setState({ projects: [] })
  usePinnedStore.setState({ pinnedProjectIds: new Set(), loaded: false })
})

describe('which boards have the row', () => {
  it('a project’s board has the row for its name and its pin button alone', () => {
    listProject()
    renderRow()

    expect(row()).toContainElement(projectName())
    expect(screen.getByTestId('board-row-start')).toBeEmptyDOMElement()
    const end = screen.getByTestId('board-row-end')
    expect(row().lastElementChild).toBe(end)
    expect(end).toHaveClass('justify-end')
    expect(end.children).toHaveLength(1)
    expect(end).toContainElement(pinButton())
    expect(pinButton()).toHaveClass('shrink-0')
  })

  it('the pinned board has it for its label', () => {
    renderRow({ isPinnedMode: true, pinnedProjectCount: 2 })
    expect(row()).toContainElement(screen.getByRole('heading', { name: 'Pinned Projects (2)' }))
  })

  it('the board of a connection that was not saved as a project has none', () => {
    listProject()
    renderRow({ connectionId: 'connection-1' })
    expect(queryRow()).toBeNull()
  })

  it('a board whose project is not in the list has none', () => {
    renderRow({ projectId: 'gone' })
    expect(queryRow()).toBeNull()
  })
})

describe('the project’s name', () => {
  it('is on a project’s board, as a heading', () => {
    listProject('project-1', undefined, 'Hive')
    renderRow()
    expect(row()).toContainElement(projectName())
    expect(projectName()).toBe(screen.getByRole('heading', { name: 'Hive' }))
  })

  it('is on a connection project’s board', () => {
    listProject('stack', 'connection', 'Stack')
    renderRow({ projectId: 'stack' })
    expect(projectName()).toHaveTextContent('Stack')
  })

  it('is not on the pinned board, which keeps its own label', () => {
    listProject()
    // MainPane gives the pinned board no project; with one the board is still the pinned one
    for (const props of [{}, { projectId: 'project-1' }]) {
      const { unmount } = renderRow({ ...props, isPinnedMode: true, pinnedProjectCount: 1 })
      expect(queryProjectName()).toBeNull()
      expect(screen.getAllByRole('heading')).toEqual([
        screen.getByRole('heading', { name: 'Pinned Projects (1)' })
      ])
      unmount()
    }
  })

  it('sits in the middle: after the left part, before the pin button', () => {
    listProject()
    renderRow()

    const start = screen.getByTestId('board-row-start')
    const end = screen.getByTestId('board-row-end')
    expect([...row().children]).toEqual([start, projectName(), end])
    expect(end).toContainElement(pinButton())
  })

  it('is centred in the row: the two sides share what it leaves, half each', () => {
    listProject()
    renderRow()
    for (const side of ['board-row-start', 'board-row-end']) {
      expect(screen.getByTestId(side)).toHaveClass('flex-1', 'basis-0')
      // Neither side gives up the room of its own controls to keep the name centred
      expect(screen.getByTestId(side)).not.toHaveClass('min-w-0')
    }
  })

  it('is cut short, on one line, before it runs into its neighbours; a hover gives all of it', () => {
    listProject('project-1', undefined, 'A very long project name')
    renderRow()
    expect(projectName()).toHaveClass('min-w-0', 'truncate')
    expect(projectName()).toHaveAttribute('title', 'A very long project name')
  })

  it('follows a rename', () => {
    listProject('project-1', undefined, 'Before')
    renderRow()
    expect(projectName()).toHaveTextContent('Before')
    listProject('project-1', undefined, 'After')
    expect(projectName()).toHaveTextContent('After')
    expect(projectName()).toHaveAttribute('title', 'After')
  })

  it('is not a stop for the keyboard', () => {
    listProject()
    renderRow()
    expect(projectName()).not.toHaveAttribute('tabindex')
    expect(projectName().querySelector('button, [tabindex]')).toBeNull()
  })
})
