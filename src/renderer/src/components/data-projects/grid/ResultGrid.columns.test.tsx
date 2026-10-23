// ResultGrid column hiding through the header context menu: the body shows the visible columns
// only, every callback (sort, edit, "Filter by this value") still reports the caller's column
// positions, the corner button lists and restores hidden columns, and a new column set (another
// result) starts with everything visible. The Radix context menu is replaced by plain elements
// (an opened Radix menu keeps jsdom busy for seconds after each test); the grid's own menu logic
// (which items a header / cell right-click offers) is what runs.
import type { ReactNode } from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import type { DataCell, DataColumnMeta } from '@shared/data-projects/types'

vi.mock('@tanstack/react-virtual', () => ({
  useVirtualizer: (opts: { count: number; estimateSize: (i: number) => number }) => {
    const items = Array.from({ length: opts.count }, (_, index) => {
      let start = 0
      for (let i = 0; i < index; i++) start += opts.estimateSize(i)
      const size = opts.estimateSize(index)
      return { index, key: index, start, size, end: start + size, lane: 0 }
    })
    return {
      getVirtualItems: () => items,
      getTotalSize: () => items.reduce((sum, item) => sum + item.size, 0),
      measure: vi.fn(),
      scrollToIndex: vi.fn()
    }
  }
}))
vi.mock('@/components/ui/context-menu', () => {
  type Props = { children?: ReactNode; 'data-testid'?: string }
  const Pass = ({ children }: Props): ReactNode => children
  const Box = ({ children, 'data-testid': testId }: Props): ReactNode => (
    <div data-testid={testId}>{children}</div>
  )
  const Item = ({
    children,
    onSelect,
    disabled,
    'data-testid': testId
  }: Props & { onSelect?: () => void; disabled?: boolean }): ReactNode => (
    <button type="button" data-testid={testId} disabled={disabled} onClick={() => onSelect?.()}>
      {children}
    </button>
  )
  return {
    ContextMenu: Pass,
    ContextMenuTrigger: Pass,
    ContextMenuContent: Box,
    ContextMenuItem: Item,
    ContextMenuSeparator: () => null,
    ContextMenuShortcut: Pass,
    ContextMenuSub: Pass,
    ContextMenuSubTrigger: Box,
    ContextMenuSubContent: Box
  }
})
vi.mock('@/lib/clipboard', () => ({ copyTextToClipboard: vi.fn(async () => true) }))
vi.mock('@/lib/toast', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

const { ResultGrid } = await import('./ResultGrid')

const columns: DataColumnMeta[] = [
  { name: 'id', type: 'int4' },
  { name: 'email', type: 'text' },
  { name: 'avatar', type: 'bytea' },
  { name: 'active', type: 'bool' }
]
const rows: DataCell[][] = [
  [1, 'a@x.io', { $t: 'bin', hex: 'cafe', len: 2 }, true],
  [2, null, null, false],
  [3, 'c@x.io', null, true]
]

beforeAll(() => {
  Element.prototype.hasPointerCapture ??= () => false
  Element.prototype.releasePointerCapture ??= () => undefined
  Element.prototype.scrollIntoView ??= () => undefined
})
afterEach(cleanup)

const cell = (row: number, col: number): HTMLElement =>
  document.querySelector(`[data-row="${row}"][data-col="${col}"]`) as HTMLElement

describe('ResultGrid column hiding', () => {
  it('hides a column from the header menu; callbacks keep the original positions', () => {
    const onCommitEdit = vi.fn()
    const onFilter = vi.fn()
    const onSort = vi.fn()
    render(
      <ResultGrid
        columns={columns}
        rows={rows}
        editing={{ isEditable: () => true, onCommitEdit }}
        onFilterByValue={onFilter}
        onSortColumn={onSort}
      />
    )
    fireEvent.contextMenu(screen.getByTestId('data-project-grid-header-1'))
    fireEvent.click(screen.getByTestId('data-project-grid-menu-hide-column'))
    // email is gone; avatar now sits at position 1 on screen
    expect(screen.getByTestId('data-project-grid-header-1')).toHaveTextContent('avatar')
    expect(screen.getByTestId('data-project-grid-show-hidden')).toHaveTextContent('1')
    fireEvent.click(screen.getByTestId('data-project-grid-header-2'))
    expect(onSort).toHaveBeenLastCalledWith('active', false, 3)
    // editing the on-screen column 2 (active) reports the caller's column 3
    fireEvent.doubleClick(cell(0, 2))
    const input = screen.getByTestId('data-project-grid-cell-input')
    fireEvent.change(input, { target: { value: 'false' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(onCommitEdit).toHaveBeenCalledWith(0, 3, false)
    // "Filter by this value" on a cell of a shifted column
    fireEvent.contextMenu(cell(2, 0))
    fireEvent.click(screen.getByTestId('data-project-grid-menu-filter'))
    expect(onFilter).toHaveBeenLastCalledWith('id', 3, 0)
    // the corner button shows everything again
    fireEvent.click(screen.getByTestId('data-project-grid-show-hidden'))
    expect(screen.getByTestId('data-project-grid-header-1')).toHaveTextContent('email')
    expect(screen.queryByTestId('data-project-grid-show-hidden')).toBeNull()
  })

  it('forgets hidden columns when another result (column set) arrives', () => {
    const { rerender } = render(<ResultGrid columns={columns} rows={rows} />)
    fireEvent.contextMenu(screen.getByTestId('data-project-grid-header-0'))
    fireEvent.click(screen.getByTestId('data-project-grid-menu-hide-column'))
    expect(screen.getByTestId('data-project-grid-header-0')).toHaveTextContent('email')
    rerender(<ResultGrid columns={[{ name: 'x' }, { name: 'y' }]} rows={[[1, 2]]} />)
    expect(screen.getByTestId('data-project-grid-header-0')).toHaveTextContent('x')
    expect(screen.queryByTestId('data-project-grid-show-hidden')).toBeNull()
  })
})
