// ResultsPanel's client-side view of loaded rows: header clicks sort (asc → desc → off, numbers
// as numbers, NULLs last, shift-click adds a column) without running anything; the filter box and
// "Filter by this value" narrow the rows (chips, "N of M rows"); copy takes the rows as shown;
// "Export all" re-runs the statement with the run's database and PostgreSQL schema; the row
// detail toggle shows the focused row read-only and follows the arrow keys. Radix menus are
// replaced by plain elements (jsdom stays slow for seconds after a Radix menu opened).
import type { ReactNode } from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DataProject, DataStatementResult } from '@shared/data-projects/types'
import type { QueryTabRun } from '@/stores/useDataWorkspaceStore'

const mocks = vi.hoisted(() => ({
  copy: vi.fn(async (_text: string) => true),
  startFullExport: vi.fn(async () => null),
  saveVisibleResults: vi.fn(async () => null)
}))

vi.mock('@tanstack/react-virtual', () => ({
  useVirtualizer: (opts: { count: number; estimateSize: (i: number) => number }) => {
    const items = Array.from({ length: opts.count }, (_, index) => ({
      index,
      key: index,
      start: index * opts.estimateSize(index),
      size: opts.estimateSize(index),
      end: (index + 1) * opts.estimateSize(index),
      lane: 0
    }))
    return {
      getVirtualItems: () => items,
      getTotalSize: () => items.reduce((s, i) => s + i.size, 0),
      measure: () => undefined,
      scrollToIndex: () => undefined
    }
  }
}))
vi.mock('@/lib/clipboard', () => ({ copyTextToClipboard: mocks.copy }))
vi.mock('@/lib/toast', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))
vi.mock('../shared/export-actions', () => ({
  FULL_EXPORT_FORMATS: [{ format: 'csv', label: 'CSV' }],
  startFullExport: mocks.startFullExport,
  saveVisibleResults: mocks.saveVisibleResults
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
    'data-testid': testId
  }: Props & { onSelect?: () => void }): ReactNode => (
    <button type="button" data-testid={testId} onClick={() => onSelect?.()}>
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
vi.mock('@/components/ui/dropdown-menu', () => {
  type Props = { children?: ReactNode; 'data-testid'?: string }
  const Pass = ({ children }: Props): ReactNode => children
  const Item = ({
    children,
    onSelect,
    'data-testid': testId
  }: Props & { onSelect?: () => void }): ReactNode => (
    <button type="button" data-testid={testId} onClick={() => onSelect?.()}>
      {children}
    </button>
  )
  return {
    DropdownMenu: Pass,
    DropdownMenuTrigger: Pass,
    DropdownMenuContent: Pass,
    DropdownMenuItem: Item,
    DropdownMenuLabel: Pass,
    DropdownMenuSeparator: () => null
  }
})

const { ResultsPanel } = await import('./ResultsPanel')

const project = { id: 'dp-1', name: 'Shop PG', engine: 'postgres' } as DataProject

const statement: DataStatementResult = {
  index: 0,
  text: 'SELECT id, email FROM daily_revenue',
  start: 0,
  end: 35,
  classification: 'read',
  durationMs: 4,
  output: {
    kind: 'rows',
    columns: [
      { name: 'id', type: 'int8' },
      { name: 'email', type: 'text' }
    ],
    rows: [
      ['10', 'a@x.io'],
      ['9', 'b@x.io'],
      [null, 'a@y.io'],
      ['100', null]
    ],
    truncated: false,
    limit: 1000,
    autoLimited: false
  }
}

const run: QueryTabRun = {
  runId: 7,
  status: 'ok',
  target: { text: statement.text, from: 0, to: statement.end, mode: 'current' },
  queryId: null,
  startedAt: 0,
  database: 'shop',
  schema: 'analytics',
  limit: 1000,
  statements: [statement],
  activeResult: 0
}

const cell = (row: number, col: number): HTMLElement =>
  document.querySelector(`[data-row="${row}"][data-col="${col}"]`) as HTMLElement
const column = (col: number): string[] =>
  [0, 1, 2, 3].flatMap((r) => (cell(r, col) ? [cell(r, col).textContent ?? ''] : []))

beforeAll(() => {
  Element.prototype.hasPointerCapture ??= () => false
  Element.prototype.releasePointerCapture ??= () => undefined
  Element.prototype.scrollIntoView ??= () => undefined
})
beforeEach(() => {
  mocks.copy.mockClear()
  mocks.startFullExport.mockClear()
})
afterEach(() => {
  cleanup()
  localStorage.clear() // the row detail's open / width preference
})

function renderPanel(): void {
  render(
    <ResultsPanel
      project={project}
      dialect="postgres"
      tabTitle="Query 1"
      run={run}
      onSelectResult={vi.fn()}
      onRerun={vi.fn()}
      onCancel={vi.fn()}
      onShowError={vi.fn()}
    />
  )
}

describe('ResultsPanel client-side view', () => {
  it('sorts the loaded rows by header clicks (asc, desc, off) without running anything', () => {
    renderPanel()
    expect(column(0)).toEqual(['10', '9', 'NULL', '100'])
    fireEvent.click(screen.getByTestId('data-project-grid-header-0'))
    expect(column(0)).toEqual(['9', '10', '100', 'NULL'])
    fireEvent.click(screen.getByTestId('data-project-grid-header-0'))
    expect(column(0)).toEqual(['100', '10', '9', 'NULL'])
    // shift-click adds a second key (email asc); both headers show their position
    fireEvent.click(screen.getByTestId('data-project-grid-header-1'), { shiftKey: true })
    expect(screen.getByTestId('data-project-grid-header-0')).toHaveTextContent(/1$/)
    expect(screen.getByTestId('data-project-grid-header-1')).toHaveTextContent(/2$/)
    // a plain click replaces the sort: email was asc, so now email desc alone
    fireEvent.click(screen.getByTestId('data-project-grid-header-1'))
    expect(column(1)).toEqual(['b@x.io', 'a@y.io', 'a@x.io', 'NULL'])
    expect(screen.getByTestId('data-project-grid-header-0').querySelector('svg')).toBeNull()
    fireEvent.click(screen.getByTestId('data-project-grid-header-1'))
    expect(column(0)).toEqual(['10', '9', 'NULL', '100'])
  })

  it('narrows the rows with the filter box and by value, and copies them as shown', async () => {
    renderPanel()
    fireEvent.change(screen.getByTestId('data-project-results-filter'), {
      target: { value: 'A@X' }
    })
    await waitFor(() =>
      expect(screen.getByTestId('data-project-status-rows')).toHaveTextContent('1 of 4 rows')
    )
    expect(column(1)).toEqual(['a@x.io'])
    fireEvent.keyDown(screen.getByTestId('data-project-results-filter'), { key: 'Escape' })
    await waitFor(() => expect(column(0)).toHaveLength(4))

    // "Filter by this value" on the NULL id
    fireEvent.contextMenu(cell(2, 0))
    fireEvent.click(screen.getByTestId('data-project-grid-menu-filter'))
    expect(screen.getByTestId('data-project-results-value-filters')).toHaveTextContent('id = NULL')
    await waitFor(() => expect(column(1)).toEqual(['a@y.io']))
    await act(async () => {
      fireEvent.click(screen.getByTestId('data-project-results-copy-csv'))
    })
    expect(mocks.copy.mock.calls[0][0]).toMatch(/^id,email\r?\n,a@y\.io\r?\n?$/)
    fireEvent.click(screen.getByTestId('data-project-results-value-filter-remove-0'))
    await waitFor(() => expect(column(0)).toHaveLength(4))
    expect(screen.queryByTestId('data-project-results-value-filters')).toBeNull()
  })

  it('exports all rows with the run database and PostgreSQL schema', () => {
    renderPanel()
    fireEvent.click(screen.getByTestId('data-project-results-export-csv'))
    expect(mocks.startFullExport).toHaveBeenCalledWith({
      dataProjectId: 'dp-1',
      source: {
        kind: 'query',
        text: 'SELECT id, email FROM daily_revenue',
        database: 'shop',
        schema: 'analytics'
      },
      format: 'csv'
    })
  })
  it('shows the focused row in a read-only row detail panel that follows the arrow keys', () => {
    renderPanel()
    const toggle = screen.getByTestId('data-project-results-row-detail')
    fireEvent.click(toggle)
    expect(toggle).toHaveAttribute('aria-pressed', 'true')
    fireEvent.mouseDown(cell(1, 1), { button: 0 })
    const fieldValue = (col: number): string =>
      within(screen.getByTestId(`data-project-row-detail-field-${col}`)).getByTestId(
        'data-project-row-detail-value'
      ).textContent ?? ''
    expect(screen.getByTestId('data-project-row-detail-title')).toHaveTextContent('Row 2')
    expect(fieldValue(0)).toBe('9')
    expect(fieldValue(1)).toBe('b@x.io')
    expect(screen.queryByTestId('data-project-row-detail-input')).toBeNull()
    const grid = screen.getByTestId('data-project-result-grid')
    fireEvent.keyDown(grid, { key: 'ArrowDown' })
    expect(screen.getByTestId('data-project-row-detail-title')).toHaveTextContent('Row 3')
    expect(fieldValue(0)).toBe('NULL')
    // the panel shows the rows as sorted on screen (email desc puts b@x.io first)
    fireEvent.click(screen.getByTestId('data-project-grid-header-1'))
    fireEvent.click(screen.getByTestId('data-project-grid-header-1'))
    fireEvent.mouseDown(cell(0, 0), { button: 0 })
    expect(fieldValue(1)).toBe('b@x.io')
    fireEvent.keyDown(grid, { key: ' ' })
    expect(screen.queryByTestId('data-project-row-detail')).toBeNull()
    expect(toggle).toHaveAttribute('aria-pressed', 'false')
  })
})
