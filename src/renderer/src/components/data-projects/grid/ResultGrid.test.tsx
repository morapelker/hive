// ResultGrid rendering and interaction with the virtualizer mocked (jsdom has no layout): header
// and sort callbacks (by name and by position), NULL / binary / boolean rendering, row numbers
// with an offset, click and shift-click selection with Cmd+C copying TSV, Cmd+A, the inline
// editor (staged commit, NULL button), pending-state overlays, Delete → onDeleteRows, and the
// empty state. Hiding columns (through the Radix header menu) is in ResultGrid.columns.test.tsx.
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DataCell, DataColumnMeta } from '@shared/data-projects/types'

const mocks = vi.hoisted(() => ({ copy: vi.fn(async (_text: string) => true) }))

vi.mock('@tanstack/react-virtual', () => ({
  useVirtualizer: (opts: {
    count: number
    estimateSize: (i: number) => number
    horizontal?: boolean
  }) => {
    const items = Array.from({ length: opts.count }, (_, index) => {
      let start = 0
      for (let i = 0; i < index; i++) start += opts.estimateSize(i)
      return {
        index,
        key: index,
        start,
        size: opts.estimateSize(index),
        end: start + opts.estimateSize(index),
        lane: 0
      }
    })
    return {
      getVirtualItems: () => items,
      getTotalSize: () => items.reduce((sum, item) => sum + item.size, 0),
      measure: vi.fn(),
      scrollToIndex: vi.fn()
    }
  }
}))
vi.mock('@/lib/clipboard', () => ({ copyTextToClipboard: mocks.copy }))
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
beforeEach(() => mocks.copy.mockClear())
afterEach(cleanup)

const cell = (row: number, col: number): HTMLElement =>
  document.querySelector(`[data-row="${row}"][data-col="${col}"]`) as HTMLElement

describe('ResultGrid', () => {
  it('renders headers, NULLs, binary and booleans with row numbers', () => {
    render(<ResultGrid columns={columns} rows={rows} rowNumberOffset={100} />)
    const grid = screen.getByTestId('data-project-result-grid')
    expect(grid).toHaveAttribute('data-db-grid')
    expect(screen.getByTestId('data-project-grid-header-1')).toHaveTextContent('email')
    expect(cell(1, 1)).toHaveTextContent('NULL')
    expect(cell(1, 1).querySelector('.italic')).not.toBeNull()
    expect(cell(0, 2)).toHaveTextContent('0xcafe (2 bytes)')
    expect(cell(1, 3)).toHaveTextContent('false')
    expect(screen.getByTestId('data-project-grid-row-0')).toHaveTextContent('101')
  })

  it('reports header clicks for sorting (shift = additive) and shows the sort arrow', () => {
    const onSort = vi.fn()
    render(
      <ResultGrid
        columns={columns}
        rows={rows}
        sort={[{ column: 'email', direction: 'desc' }]}
        onSortColumn={onSort}
      />
    )
    fireEvent.click(screen.getByTestId('data-project-grid-header-0'))
    fireEvent.click(screen.getByTestId('data-project-grid-header-1'), { shiftKey: true })
    expect(onSort).toHaveBeenNthCalledWith(1, 'id', false, 0)
    expect(onSort).toHaveBeenNthCalledWith(2, 'email', true, 1)
    expect(screen.getByTestId('data-project-grid-header-1').querySelector('svg')).not.toBeNull()
  })

  it('marks sorted columns by position when names repeat (SELECT a.id, b.id)', () => {
    render(
      <ResultGrid
        columns={[{ name: 'id' }, { name: 'id' }, { name: 'n' }]}
        rows={[[1, 2, 3]]}
        sortedColumns={[
          { col: 1, direction: 'desc' },
          { col: 2, direction: 'asc' }
        ]}
        onSortColumn={vi.fn()}
      />
    )
    expect(screen.getByTestId('data-project-grid-header-0').querySelector('svg')).toBeNull()
    expect(screen.getByTestId('data-project-grid-header-1')).toHaveTextContent('id1')
    expect(screen.getByTestId('data-project-grid-header-2')).toHaveTextContent('n2')
  })

  it('selects a rectangle with click + shift-click and copies it as TSV', async () => {
    const onSelection = vi.fn()
    render(<ResultGrid columns={columns} rows={rows} onSelectionChange={onSelection} />)
    fireEvent.mouseDown(cell(0, 0), { button: 0 })
    fireEvent.mouseDown(cell(1, 1), { button: 0, shiftKey: true })
    expect(onSelection).toHaveBeenLastCalledWith([0, 1])
    const grid = screen.getByTestId('data-project-result-grid')
    await act(async () => {
      fireEvent.keyDown(grid, { key: 'c', metaKey: true })
    })
    expect(mocks.copy).toHaveBeenCalledWith('1\ta@x.io\n2\t')
  })

  it('selects everything with Cmd+A and whole rows from the row number', async () => {
    const onSelection = vi.fn()
    render(<ResultGrid columns={columns} rows={rows} onSelectionChange={onSelection} />)
    const grid = screen.getByTestId('data-project-result-grid')
    fireEvent.keyDown(grid, { key: 'a', metaKey: true })
    expect(onSelection).toHaveBeenLastCalledWith([0, 1, 2])
    fireEvent.mouseDown(document.querySelector('[data-row-number="2"]') as HTMLElement, {
      button: 0
    })
    expect(onSelection).toHaveBeenLastCalledWith([2])
    await act(async () => {
      fireEvent.keyDown(grid, { key: 'c', metaKey: true })
    })
    expect(mocks.copy).toHaveBeenLastCalledWith('3\tc@x.io\t\ttrue')
  })

  it('edits a cell inline and commits the parsed value', () => {
    const onCommitEdit = vi.fn()
    render(
      <ResultGrid
        columns={columns}
        rows={rows}
        editing={{ isEditable: (_r, c) => c !== 2, onCommitEdit }}
      />
    )
    fireEvent.doubleClick(cell(0, 0))
    const input = screen.getByTestId('data-project-grid-cell-input') as HTMLInputElement
    expect(input.value).toBe('1')
    fireEvent.change(input, { target: { value: '10' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(onCommitEdit).toHaveBeenCalledWith(0, 0, 10)
    // NULL button
    fireEvent.doubleClick(cell(0, 1))
    fireEvent.mouseDown(screen.getByTestId('data-project-grid-cell-set-null'))
    expect(onCommitEdit).toHaveBeenLastCalledWith(0, 1, null)
    // a NULL cell opened and left empty stays NULL
    fireEvent.doubleClick(cell(1, 1))
    fireEvent.keyDown(screen.getByTestId('data-project-grid-cell-input'), { key: 'Enter' })
    expect(onCommitEdit).toHaveBeenCalledTimes(2)
    // Escape cancels; read-only cells do not open an editor
    fireEvent.doubleClick(cell(2, 1))
    fireEvent.keyDown(screen.getByTestId('data-project-grid-cell-input'), { key: 'Escape' })
    expect(onCommitEdit).toHaveBeenCalledTimes(2)
    fireEvent.doubleClick(cell(0, 2))
    expect(screen.queryByTestId('data-project-grid-cell-input')).toBeNull()
  })

  it('edits a multi-line value in a textarea without losing its line breaks', () => {
    const onCommitEdit = vi.fn()
    render(
      <ResultGrid
        columns={[{ name: 'note', type: 'text' }]}
        rows={[['line one\nline two']]}
        editing={{ isEditable: () => true, onCommitEdit }}
      />
    )
    fireEvent.doubleClick(cell(0, 0))
    const editor = screen.getByTestId('data-project-grid-cell-input')
    expect(editor.tagName).toBe('TEXTAREA')
    expect((editor as HTMLTextAreaElement).value).toBe('line one\nline two')
    fireEvent.change(editor, { target: { value: 'line one\nline two!' } })
    // Shift+Enter is a line break, plain Enter commits
    fireEvent.keyDown(editor, { key: 'Enter', shiftKey: true })
    expect(onCommitEdit).not.toHaveBeenCalled()
    fireEvent.keyDown(editor, { key: 'Enter' })
    expect(onCommitEdit).toHaveBeenCalledWith(0, 0, 'line one\nline two!')
  })

  it('draws pending overlays and stages deletes from the keyboard', () => {
    const onDeleteRows = vi.fn()
    render(
      <ResultGrid
        columns={columns}
        rows={rows}
        editing={{
          isEditable: () => true,
          onCommitEdit: vi.fn(),
          rowState: (r) => (r === 1 ? 'deleted' : r === 2 ? 'inserted' : null),
          cellState: (r, c) =>
            r === 0 && c === 1 ? 'modified' : r === 2 && c === 2 ? 'default' : null,
          onDeleteRows
        }}
      />
    )
    expect(screen.getByTestId('data-project-grid-row-1')).toHaveAttribute(
      'data-row-state',
      'deleted'
    )
    expect(screen.getByTestId('data-project-grid-row-2')).toHaveAttribute(
      'data-row-state',
      'inserted'
    )
    expect(cell(0, 1)).toHaveAttribute('data-cell-state', 'modified')
    expect(cell(2, 2)).toHaveTextContent('DEFAULT')
    fireEvent.mouseDown(cell(0, 0), { button: 0 })
    fireEvent.keyDown(screen.getByTestId('data-project-result-grid'), { key: 'Backspace' })
    expect(onDeleteRows).toHaveBeenCalledWith([0])
  })

  it('shows the empty message but keeps the headers', () => {
    render(<ResultGrid columns={columns} rows={[]} emptyMessage="0 rows" />)
    expect(screen.getByTestId('data-project-grid-header-0')).toHaveTextContent('id')
    expect(screen.getByTestId('data-project-result-grid-empty')).toHaveTextContent('0 rows')
  })
})
