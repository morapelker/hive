// Row detail panel through ResultGrid (virtualizer mocked, Radix menus / dialogs replaced by plain
// elements): Space toggles it (Shift+Space and the menu still reach the cell inspector, grids
// without a panel keep Space = inspector), it follows the selection (arrow keys, ↑ / ↓ buttons),
// lists every column (hidden ones too) with NULL / empty string / JSON / binary / booleans shown
// distinctly, filters fields by name, selects a field's cell in the grid, copies a value or the
// row, and in an editable grid stages field edits through `editing` exactly like the inline
// editor (Enter, blur, Esc reverts, Set NULL, JSON compacted / refused, read-only cells and
// deleted rows, a draft left behind when the row changes staged for its own row). JSON shows and
// stages with every number and escape as stored; drafts belong to the row's identity, so a reload
// that puts another row at the focused position stages the draft for the row it was typed into
// and never hands it to the new one, and a reload that changes the value under a draft of the
// same row keeps the typing.
import { useState, type ReactNode } from 'react'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DataCell, DataColumnMeta } from '@shared/data-projects/types'
import type { ResultGridEditing } from './ResultGrid'

const mocks = vi.hoisted(() => ({ copy: vi.fn(async (_text: string) => true) }))

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
vi.mock('@/components/ui/dialog', () => {
  type Props = { children?: ReactNode; 'data-testid'?: string }
  const Pass = ({ children }: Props): ReactNode => children
  return {
    Dialog: ({ open, children }: Props & { open: boolean }): ReactNode => (open ? children : null),
    DialogContent: ({ children, 'data-testid': testId }: Props): ReactNode => (
      <div data-testid={testId}>{children}</div>
    ),
    DialogDescription: Pass,
    DialogFooter: Pass,
    DialogHeader: Pass,
    DialogTitle: Pass
  }
})
vi.mock('@/lib/clipboard', () => ({ copyTextToClipboard: mocks.copy }))
vi.mock('@/lib/toast', () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }))

const { ResultGrid } = await import('./ResultGrid')

const columns: DataColumnMeta[] = [
  { name: 'id', type: 'int4' },
  { name: 'email', type: 'text' },
  { name: 'attrs', type: 'jsonb' },
  { name: 'avatar', type: 'bytea' },
  { name: 'active', type: 'bool' }
]
const rows: DataCell[][] = [
  [1, 'a@x.io', '{"tier":"gold","tags":["a"]}', { $t: 'bin', hex: 'cafe', len: 2 }, true],
  [2, null, null, null, false],
  [3, '', '[1,2]', null, true]
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
const grid = (): HTMLElement => screen.getByTestId('data-project-result-grid')
const panel = (): HTMLElement => screen.getByTestId('data-project-row-detail')
const field = (col: number): HTMLElement =>
  screen.getByTestId(`data-project-row-detail-field-${col}`)
const value = (col: number): string =>
  within(field(col)).getByTestId('data-project-row-detail-value').textContent ?? ''
const input = (col: number): HTMLTextAreaElement =>
  within(field(col)).getByTestId('data-project-row-detail-input') as HTMLTextAreaElement

function Harness({
  editing,
  initialOpen = false
}: {
  editing?: ResultGridEditing
  initialOpen?: boolean
}): React.JSX.Element {
  const [open, setOpen] = useState(initialOpen)
  return (
    <ResultGrid
      columns={columns}
      rows={rows}
      rowNumberOffset={100}
      editing={editing}
      rowDetail={{ open, onOpenChange: setOpen, keyColumns: ['id'] }}
    />
  )
}

describe('row detail panel', () => {
  it('toggles with Space, follows the selection and keeps the inspector one key away', () => {
    render(<Harness />)
    expect(screen.queryByTestId('data-project-row-detail')).toBeNull()
    // Space with nothing selected opens the panel on the first row
    fireEvent.keyDown(grid(), { key: ' ' })
    expect(screen.getByTestId('data-project-row-detail-title')).toHaveTextContent('Row 101')
    expect(field(0)).toHaveAttribute('data-focused')
    // arrow keys in the grid move the row; the panel follows
    fireEvent.keyDown(grid(), { key: 'ArrowDown' })
    expect(screen.getByTestId('data-project-row-detail-title')).toHaveTextContent('Row 102')
    fireEvent.keyDown(grid(), { key: 'ArrowRight' })
    expect(field(1)).toHaveAttribute('data-focused')
    // the panel's own ↑ / ↓
    fireEvent.click(screen.getByTestId('data-project-row-detail-next'))
    expect(screen.getByTestId('data-project-row-detail-title')).toHaveTextContent('Row 103')
    expect(screen.getByTestId('data-project-row-detail-next')).toBeDisabled()
    fireEvent.click(screen.getByTestId('data-project-row-detail-prev'))
    expect(screen.getByTestId('data-project-row-detail-title')).toHaveTextContent('Row 102')
    // a multi-row selection shows its focused row
    fireEvent.keyDown(grid(), { key: 'ArrowDown', shiftKey: true })
    expect(panel()).toHaveTextContent('2 selected')
    // Shift+Space is the cell inspector now
    fireEvent.keyDown(grid(), { key: ' ', shiftKey: true })
    expect(screen.getByTestId('data-project-cell-inspector')).toBeInTheDocument()
    // Space closes the panel again; the selection survives
    fireEvent.keyDown(grid(), { key: ' ' })
    expect(screen.queryByTestId('data-project-row-detail')).toBeNull()
    expect(cell(2, 1).className).toContain('outline')
  })

  it('shows every value distinctly: NULL, empty string, JSON, binary, booleans, keys', () => {
    render(<Harness initialOpen />)
    expect(screen.getByTestId('data-project-row-detail-empty')).toHaveTextContent('Select a row')
    fireEvent.mouseDown(cell(0, 0), { button: 0 })
    expect(within(field(0)).getByLabelText('Primary key column')).toBeInTheDocument()
    expect(field(0)).toHaveTextContent('int4')
    expect(value(1)).toBe('a@x.io')
    expect(value(2)).toBe('{\n  "tier": "gold",\n  "tags": [\n    "a"\n  ]\n}')
    expect(value(3)).toBe('0xcafe (2 bytes)')
    expect(value(4)).toBe('true')
    // read-only grid: no editors, no Set NULL
    expect(screen.queryByTestId('data-project-row-detail-input')).toBeNull()
    expect(screen.queryByTestId('data-project-row-detail-set-null')).toBeNull()
    fireEvent.mouseDown(cell(1, 0), { button: 0 })
    expect(value(1)).toBe('NULL')
    expect(
      within(field(1)).getByTestId('data-project-row-detail-value').querySelector('.italic')
    ).not.toBeNull()
    fireEvent.mouseDown(cell(2, 0), { button: 0 })
    expect(value(1)).toBe('empty string')
  })

  it('lists hidden columns, filters fields by name and selects a field in the grid', () => {
    render(<Harness initialOpen />)
    fireEvent.contextMenu(screen.getByTestId('data-project-grid-header-1'))
    fireEvent.click(screen.getByTestId('data-project-grid-menu-hide-column'))
    fireEvent.mouseDown(cell(0, 0), { button: 0 })
    expect(screen.getAllByTestId(/^data-project-row-detail-field-/)).toHaveLength(5)
    expect(within(field(1)).getByLabelText('Hidden in the grid')).toBeInTheDocument()
    // field 4 (active) sits at on-screen column 3 while email is hidden
    fireEvent.click(within(field(4)).getByTestId('data-project-row-detail-name'))
    expect(field(4)).toHaveAttribute('data-focused')
    expect(cell(0, 3).className).toContain('outline')
    fireEvent.change(screen.getByTestId('data-project-row-detail-search'), {
      target: { value: 'AV' }
    })
    expect(screen.getAllByTestId(/^data-project-row-detail-field-/)).toHaveLength(1)
    expect(field(3)).toBeInTheDocument()
    fireEvent.change(screen.getByTestId('data-project-row-detail-search'), {
      target: { value: 'zzz' }
    })
    expect(panel()).toHaveTextContent('No column matches “zzz”')
  })

  it('copies a value and the whole row, and opens a value in the inspector', async () => {
    render(<Harness initialOpen />)
    fireEvent.mouseDown(cell(0, 0), { button: 0 })
    await act(async () => {
      fireEvent.click(within(field(1)).getByTestId('data-project-row-detail-copy'))
    })
    expect(mocks.copy).toHaveBeenLastCalledWith('a@x.io')
    await act(async () => {
      fireEvent.click(screen.getByTestId('data-project-row-detail-copy-row'))
    })
    expect(JSON.parse(mocks.copy.mock.calls.at(-1)?.[0] ?? '')).toEqual({
      id: 1,
      email: 'a@x.io',
      attrs: { tier: 'gold', tags: ['a'] },
      avatar: '0xcafe',
      active: true
    })
    fireEvent.click(within(field(2)).getByTestId('data-project-row-detail-inspect'))
    expect(screen.getByTestId('data-project-cell-inspector')).toHaveTextContent('attrs')
  })

  it('stages field edits through the grid editing hooks like the inline editor', () => {
    const onCommitEdit = vi.fn()
    const editing: ResultGridEditing = {
      isEditable: (_r, c) => c !== 3,
      onCommitEdit,
      rowState: (r) => (r === 2 ? 'deleted' : null),
      cellState: (r, c) => (r === 0 && c === 4 ? 'modified' : null)
    }
    render(<Harness editing={editing} initialOpen />)
    fireEvent.mouseDown(cell(0, 0), { button: 0 })
    expect(field(4)).toHaveAttribute('data-cell-state', 'modified')
    // Enter stages, parsed like the grid (numbers stay numeric)
    fireEvent.change(input(0), { target: { value: '10' } })
    fireEvent.keyDown(input(0), { key: 'Enter' })
    expect(onCommitEdit).toHaveBeenLastCalledWith(0, 0, 10)
    // leaving the field stages it
    fireEvent.change(input(1), { target: { value: 'z@x.io' } })
    fireEvent.blur(input(1))
    expect(onCommitEdit).toHaveBeenLastCalledWith(0, 1, 'z@x.io')
    // Esc reverts the draft; nothing staged
    const calls = onCommitEdit.mock.calls.length
    fireEvent.change(input(4), { target: { value: 'false' } })
    fireEvent.keyDown(input(4), { key: 'Escape' })
    expect(input(4).value).toBe('true')
    fireEvent.blur(input(4))
    expect(onCommitEdit).toHaveBeenCalledTimes(calls)
    // Set NULL
    fireEvent.click(within(field(1)).getByTestId('data-project-row-detail-set-null'))
    expect(onCommitEdit).toHaveBeenLastCalledWith(0, 1, null)
    // JSON is edited pretty and stored compact; invalid JSON is refused
    expect(input(2).value).toContain('\n  "tier": "gold"')
    fireEvent.change(input(2), { target: { value: '{\n  "tier": "silver"\n}' } })
    fireEvent.keyDown(input(2), { key: 'Enter' })
    expect(onCommitEdit).toHaveBeenLastCalledWith(0, 2, '{"tier":"silver"}')
    fireEvent.change(input(2), { target: { value: '{"tier":' } })
    fireEvent.keyDown(input(2), { key: 'Enter' })
    expect(within(field(2)).getByTestId('data-project-row-detail-invalid')).toHaveTextContent(
      'Not valid JSON'
    )
    expect(onCommitEdit).toHaveBeenLastCalledWith(0, 2, '{"tier":"silver"}')
    fireEvent.keyDown(input(2), { key: 'Escape' })
    // a cell the grid cannot edit (binary) stays read-only
    expect(within(field(3)).queryByTestId('data-project-row-detail-input')).toBeNull()
    expect(value(3)).toBe('0xcafe (2 bytes)')
    // a draft left behind when the row changes is staged for the row it was typed into
    fireEvent.change(input(1), { target: { value: 'left@behind.io' } })
    fireEvent.keyDown(grid(), { key: 'ArrowDown' })
    expect(onCommitEdit).toHaveBeenLastCalledWith(0, 1, 'left@behind.io')
    expect(screen.getByTestId('data-project-row-detail-title')).toHaveTextContent('Row 102')
    expect(input(1).value).toBe('')
    expect(input(1).placeholder).toBe('NULL')
    // a row staged for deletion is read-only
    fireEvent.keyDown(grid(), { key: 'ArrowDown' })
    expect(panel()).toHaveTextContent('deleted')
    expect(screen.queryByTestId('data-project-row-detail-input')).toBeNull()
  })

  it('shows and stages JSON with its numbers and escapes exactly as stored', () => {
    const json = '{"id": 1234567890123456789, "name": "Alice", "ratio": 1.0, "s": "\\u00e9"}'
    const jsonRows: DataCell[][] = [[1, 'a@x.io', json, null, true]]
    const onCommitEdit = vi.fn()
    const { rerender } = render(
      <ResultGrid
        columns={columns}
        rows={jsonRows}
        rowDetail={{ open: true, onOpenChange: () => undefined, keyColumns: ['id'] }}
      />
    )
    fireEvent.mouseDown(cell(0, 0), { button: 0 })
    expect(value(2)).toContain('"id": 1234567890123456789,')
    expect(value(2)).toContain('"ratio": 1.0,')
    expect(value(2)).toContain('"s": "\\u00e9"')
    rerender(
      <ResultGrid
        columns={columns}
        rows={jsonRows}
        editing={{ isEditable: () => true, onCommitEdit }}
        rowDetail={{ open: true, onOpenChange: () => undefined, keyColumns: ['id'] }}
      />
    )
    expect(input(2).value).toContain('"id": 1234567890123456789,')
    // leaving it untouched, or only re-spacing it, stages nothing
    fireEvent.blur(input(2))
    fireEvent.change(input(2), { target: { value: json } })
    fireEvent.blur(input(2))
    expect(onCommitEdit).not.toHaveBeenCalled()
    fireEvent.change(input(2), { target: { value: input(2).value.replace('Alice', 'Alicia') } })
    fireEvent.keyDown(input(2), { key: 'Enter' })
    expect(onCommitEdit).toHaveBeenLastCalledWith(
      0,
      2,
      '{"id":1234567890123456789,"name":"Alicia","ratio":1.0,"s":"\\u00e9"}'
    )
  })

  it('keeps a draft with its row when a reload moves another row into its position', () => {
    // Each render's editing hooks resolve rows through that render's page (like TableDataView).
    const staged: Array<{ id: DataCell; col: number; value: DataCell }> = []
    const editingFor = (page: DataCell[][]): ResultGridEditing => ({
      isEditable: (_r, c) => c !== 3,
      onCommitEdit: (r, col, value) => staged.push({ id: page[r][0], col, value })
    })
    const view = (page: DataCell[][]): React.JSX.Element => (
      <ResultGrid
        columns={columns}
        rows={page}
        editing={editingFor(page)}
        rowDetail={{ open: true, onOpenChange: () => undefined, keyColumns: ['id'] }}
      />
    )
    const first: DataCell[][] = [
      [1, 'same@x.io', null, null, true],
      [2, 'same@x.io', null, null, false]
    ]
    const { rerender } = render(view(first))
    fireEvent.mouseDown(cell(0, 0), { button: 0 })
    fireEvent.change(input(1), { target: { value: 'typed@x.io' } })
    // ⌘R while typing: the same email sorts the other row first now
    const reordered: DataCell[][] = [first[1], first[0]]
    rerender(view(reordered))
    expect(staged).toEqual([{ id: 1, col: 1, value: 'typed@x.io' }])
    expect(input(1).value).toBe('same@x.io')
    expect(input(1)).not.toHaveAttribute('data-dirty')
    // leaving the new row's untouched field stages nothing for it
    fireEvent.blur(input(1))
    expect(staged).toHaveLength(1)

    // A different value at that position: the draft is still staged for its own row.
    fireEvent.change(input(1), { target: { value: 'two@x.io' } })
    rerender(view([[3, 'other@x.io', null, null, true], reordered[1]]))
    expect(staged.at(-1)).toEqual({ id: 2, col: 1, value: 'two@x.io' })
    expect(input(1).value).toBe('other@x.io')
  })

  it('keeps the typing when a reload changes the value under it, until Esc', () => {
    const onCommitEdit = vi.fn()
    const editing: ResultGridEditing = { isEditable: () => true, onCommitEdit }
    const view = (email: string): React.JSX.Element => (
      <ResultGrid
        columns={columns}
        rows={[[1, email, null, null, true]]}
        editing={editing}
        rowDetail={{ open: true, onOpenChange: () => undefined, keyColumns: ['id'] }}
      />
    )
    const { rerender } = render(view('a@x.io'))
    fireEvent.mouseDown(cell(0, 0), { button: 0 })
    fireEvent.change(input(1), { target: { value: 'mine@x.io' } })
    rerender(view('theirs@x.io'))
    expect(input(1).value).toBe('mine@x.io')
    expect(within(field(1)).getByTestId('data-project-row-detail-stale')).toBeInTheDocument()
    fireEvent.keyDown(input(1), { key: 'Enter' })
    expect(onCommitEdit).toHaveBeenLastCalledWith(0, 1, 'mine@x.io')
    expect(within(field(1)).queryByTestId('data-project-row-detail-stale')).toBeNull()
    // Esc takes the new value instead
    fireEvent.change(input(1), { target: { value: 'again@x.io' } })
    rerender(view('newer@x.io'))
    expect(input(1).value).toBe('again@x.io')
    fireEvent.keyDown(input(1), { key: 'Escape' })
    expect(input(1).value).toBe('newer@x.io')
    expect(within(field(1)).queryByTestId('data-project-row-detail-stale')).toBeNull()
    expect(onCommitEdit).toHaveBeenCalledTimes(1)
  })

  it('offers the panel in the cell menu; grids without one keep Space for the inspector', () => {
    render(<Harness />)
    fireEvent.contextMenu(cell(1, 1))
    fireEvent.click(screen.getByTestId('data-project-grid-menu-row-detail'))
    expect(screen.getByTestId('data-project-row-detail-title')).toHaveTextContent('Row 102')
    fireEvent.click(screen.getByTestId('data-project-row-detail-close'))
    expect(screen.queryByTestId('data-project-row-detail')).toBeNull()
    cleanup()

    render(<ResultGrid columns={columns} rows={rows} />)
    expect(screen.queryByTestId('data-project-grid-with-detail')).toBeNull()
    fireEvent.mouseDown(cell(0, 1), { button: 0 })
    fireEvent.keyDown(grid(), { key: ' ' })
    expect(screen.getByTestId('data-project-cell-inspector')).toHaveTextContent('email')
    expect(screen.queryByTestId('data-project-grid-menu-row-detail')).toBeNull()
  })
})
