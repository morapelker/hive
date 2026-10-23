// Table Data tab against a mocked API: paging request shape and the "rows x–y of N" label,
// header sort cycling, the filter bar (applied only on Apply), staged editing (cell edit, add row,
// delete) with the pending bar, Preview SQL, Commit through the safety confirmation (token
// re-call, reload, staged state cleared), the discard guard when paging with pending edits, the
// read-only states (no primary key, ClickHouse, read-only mode), the page field and the exact
// count of an estimated total, and the staged-edit count reported to the workspace store (which
// asks before closing / leaving) with "Discard" from there dropping the edits. Also the AND / OR
// filter join (request, export, "Filter by this value" on an OR group) and the row detail panel
// (toggle, editing a field into the staged edits, ⌘S from a field). Radix menus are replaced by
// plain elements (jsdom stays slow for seconds after a Radix menu opened).
import type { ReactNode } from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  DataApplyEditsRequest,
  DataExportRequest,
  DataProject,
  DataQueryRequest,
  DataTableRowsRequest,
  DataTableRowsResponse
} from '@shared/data-projects/types'

const mocks = vi.hoisted(() => ({
  tableRows: vi.fn(),
  applyEdits: vi.fn(),
  previewEdits: vi.fn(async () => ['UPDATE "users" SET "name" = \'Anna\' WHERE "id" = 1']),
  cancel: vi.fn(async () => ({ cancelled: true })),
  execute: vi.fn(),
  startFullExport: vi.fn(async () => null),
  toastInfo: vi.fn()
}))

vi.mock('@/api/data-projects-api', () => ({
  dataProjectsApi: {
    tableRows: mocks.tableRows,
    applyEdits: mocks.applyEdits,
    previewEdits: mocks.previewEdits,
    cancel: mocks.cancel,
    execute: mocks.execute,
    onExportProgress: () => () => undefined
  }
}))
vi.mock('@/stores/useDataProjectStore', () => ({
  useDataProjectStore: { getState: () => ({ openCredentialsPrompt: vi.fn() }) }
}))
vi.mock('@/lib/toast', () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
    info: mocks.toastInfo,
    warning: vi.fn(),
    loading: vi.fn(),
    dismiss: vi.fn()
  }
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

vi.mock('../shared/export-actions', () => ({
  FULL_EXPORT_FORMATS: [{ format: 'csv', label: 'CSV' }],
  startFullExport: mocks.startFullExport,
  saveVisibleResults: vi.fn(async () => null)
}))
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

const { TableDataView } = await import('./TableDataView')
const { useDataWorkspaceStore } = await import('@/stores/useDataWorkspaceStore')
const { DataConfirmHost } = await import('../shared/DataConfirmHost')
const { useDataConfirmStore } = await import('../shared/confirm')

const baseProject: DataProject = {
  id: 'dp-1',
  name: 'Shop',
  engine: 'postgres',
  config: { database: 'shop' },
  icon: null,
  iconColor: null,
  environment: 'local',
  color: null,
  safeMode: 'off',
  defaultLimit: 1000,
  allowAiDataAccess: false,
  pinned: false,
  secretState: 'stored',
  sortOrder: 0,
  createdAt: '2026-10-01T00:00:00.000Z',
  lastAccessedAt: '2026-10-01T00:00:00.000Z'
}
const tab = {
  id: 'table-1',
  kind: 'table' as const,
  title: 'users',
  view: 'data' as const,
  ref: { database: 'shop', schema: 'public', name: 'users', kind: 'table' as const }
}

const rowsResponse = (primaryKey = ['id'], total = 250): DataTableRowsResponse => ({
  result: {
    kind: 'rows',
    columns: [
      { name: 'id', type: 'int4' },
      { name: 'name', type: 'text' }
    ],
    rows: [
      [1, 'Ann'],
      [2, 'Bob']
    ],
    truncated: true,
    limit: 100,
    autoLimited: false
  },
  sql: 'SELECT * FROM "public"."users" LIMIT 100',
  primaryKey,
  totalRows: total,
  totalIsEstimate: true,
  durationMs: 4
})

const cell = (row: number, col: number): HTMLElement =>
  document.querySelector(`[data-row="${row}"][data-col="${col}"]`) as HTMLElement
const lastRequest = (): DataTableRowsRequest =>
  mocks.tableRows.mock.calls.at(-1)?.[0] as DataTableRowsRequest
const detailInput = (col: number): HTMLTextAreaElement =>
  within(screen.getByTestId(`data-project-row-detail-field-${col}`)).getByTestId(
    'data-project-row-detail-input'
  ) as HTMLTextAreaElement

beforeAll(() => {
  Element.prototype.hasPointerCapture ??= () => false
  Element.prototype.releasePointerCapture ??= () => undefined
  Element.prototype.scrollIntoView ??= () => undefined
})
beforeEach(() => {
  mocks.tableRows.mockReset()
  mocks.applyEdits.mockReset()
  mocks.tableRows.mockImplementation(async () => rowsResponse())
})
afterEach(() => {
  useDataConfirmStore.getState().cancelAll()
  cleanup()
  localStorage.clear() // the row detail's open / width preference
})

async function renderView(project: DataProject = baseProject): Promise<void> {
  render(
    <>
      <TableDataView project={project} dialect="postgres" tab={tab} details={null} />
      <DataConfirmHost />
    </>
  )
  await waitFor(() => expect(cell(0, 1)).toHaveTextContent('Ann'))
}

describe('TableDataView', () => {
  it('requests a page and shows the range, sorting and paging', async () => {
    await renderView()
    expect(mocks.tableRows.mock.calls[0][0]).toMatchObject({
      dataProjectId: 'dp-1',
      ref: tab.ref,
      limit: 100,
      offset: 0
    })
    expect(screen.getByTestId('data-project-table-range')).toHaveTextContent('rows 1–2 of ~250')
    await act(async () => {
      fireEvent.click(screen.getByTestId('data-project-grid-header-1'))
    })
    expect((mocks.tableRows.mock.calls.at(-1)?.[0] as DataTableRowsRequest).orderBy).toEqual([
      { column: 'name', direction: 'asc' }
    ])
    await act(async () => {
      fireEvent.click(screen.getByTestId('data-project-grid-header-1'))
    })
    expect((mocks.tableRows.mock.calls.at(-1)?.[0] as DataTableRowsRequest).orderBy).toEqual([
      { column: 'name', direction: 'desc' }
    ])
    await act(async () => {
      fireEvent.click(screen.getByTestId('data-project-table-next'))
    })
    expect((mocks.tableRows.mock.calls.at(-1)?.[0] as DataTableRowsRequest).offset).toBe(100)
  })

  it('applies filters only on Apply', async () => {
    await renderView()
    const calls = mocks.tableRows.mock.calls.length
    fireEvent.click(screen.getByTestId('data-project-filter-add'))
    fireEvent.change(screen.getByTestId('data-project-filter-value'), { target: { value: 'Ann' } })
    expect(mocks.tableRows.mock.calls.length).toBe(calls)
    await act(async () => {
      fireEvent.click(screen.getByTestId('data-project-filter-apply'))
    })
    expect((mocks.tableRows.mock.calls.at(-1)?.[0] as DataTableRowsRequest).filters).toEqual([
      { column: 'id', operator: '=', value: 'Ann' }
    ])
  })

  it('stages edits, previews and commits them through the confirmation', async () => {
    await renderView({ ...baseProject, safeMode: 'safe' })
    // edit Ann → Anna
    fireEvent.doubleClick(cell(0, 1))
    const input = screen.getByTestId('data-project-grid-cell-input')
    fireEvent.change(input, { target: { value: 'Anna' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(cell(0, 1)).toHaveAttribute('data-cell-state', 'modified')
    // add a row and delete Bob
    fireEvent.click(screen.getByTestId('data-project-table-add-row'))
    fireEvent.mouseDown(cell(1, 0), { button: 0 })
    fireEvent.click(screen.getByTestId('data-project-table-delete-rows'))
    expect(screen.getByTestId('data-project-pending-count')).toHaveTextContent('3 pending changes')
    expect(screen.getByTestId('data-project-grid-row-1')).toHaveAttribute(
      'data-row-state',
      'deleted'
    )
    expect(screen.getByTestId('data-project-grid-row-2')).toHaveAttribute(
      'data-row-state',
      'inserted'
    )

    await act(async () => {
      fireEvent.click(screen.getByTestId('data-project-pending-preview'))
    })
    expect(await screen.findByTestId('data-project-preview-sql')).toHaveTextContent(
      'UPDATE "users" SET "name"'
    )
    fireEvent.keyDown(screen.getByTestId('data-project-preview-dialog'), { key: 'Escape' })

    mocks.applyEdits
      .mockResolvedValueOnce({
        status: 'confirmation_required',
        confirmToken: 'tok',
        plan: {
          dataProjectId: 'dp-1',
          projectName: 'Shop',
          engine: 'postgres',
          environment: 'local',
          safeMode: 'safe',
          statements: [
            {
              index: 0,
              text: 'DELETE FROM "users" WHERE "id" = 2',
              start: 0,
              end: 10,
              classification: 'write',
              dangerous: [],
              reasons: ['write'],
              needsConfirmation: true
            }
          ]
        }
      })
      .mockResolvedValueOnce({
        status: 'ok',
        statements: ['a', 'b', 'c'],
        affectedRows: 3,
        durationMs: 5
      })
    const loadsBefore = mocks.tableRows.mock.calls.length
    await act(async () => {
      fireEvent.click(screen.getByTestId('data-project-pending-commit'))
    })
    await act(async () => {
      fireEvent.click(await screen.findByTestId('data-project-confirm-run'))
    })
    await waitFor(() => expect(mocks.applyEdits).toHaveBeenCalledTimes(2))
    const first = mocks.applyEdits.mock.calls[0][0] as DataApplyEditsRequest
    expect(first.edits).toEqual([
      { kind: 'delete', key: { id: 2 } },
      { kind: 'update', key: { id: 1 }, changes: { name: 'Anna' } },
      { kind: 'insert', values: {} }
    ])
    expect((mocks.applyEdits.mock.calls[1][0] as DataApplyEditsRequest).confirmToken).toBe('tok')
    await waitFor(() => expect(screen.queryByTestId('data-project-pending-bar')).toBeNull())
    expect(mocks.tableRows.mock.calls.length).toBeGreaterThan(loadsBefore)
  })

  it('keeps staged edits when the commit fails', async () => {
    await renderView()
    fireEvent.doubleClick(cell(0, 1))
    fireEvent.change(screen.getByTestId('data-project-grid-cell-input'), { target: { value: 'X' } })
    fireEvent.keyDown(screen.getByTestId('data-project-grid-cell-input'), { key: 'Enter' })
    mocks.applyEdits.mockRejectedValueOnce(new Error('duplicate key'))
    await act(async () => {
      fireEvent.click(screen.getByTestId('data-project-pending-commit'))
    })
    expect(screen.getByTestId('data-project-pending-count')).toHaveTextContent('1 pending change')
  })

  it('asks before paging away from pending edits', async () => {
    await renderView()
    fireEvent.doubleClick(cell(0, 1))
    fireEvent.change(screen.getByTestId('data-project-grid-cell-input'), { target: { value: 'X' } })
    fireEvent.keyDown(screen.getByTestId('data-project-grid-cell-input'), { key: 'Enter' })
    const calls = mocks.tableRows.mock.calls.length
    fireEvent.click(screen.getByTestId('data-project-table-next'))
    expect(await screen.findByTestId('data-project-discard-dialog')).toBeInTheDocument()
    expect(mocks.tableRows.mock.calls.length).toBe(calls)
    await act(async () => {
      fireEvent.click(screen.getByTestId('data-project-discard-confirm'))
    })
    expect((mocks.tableRows.mock.calls.at(-1)?.[0] as DataTableRowsRequest).offset).toBe(100)
    expect(screen.queryByTestId('data-project-pending-bar')).toBeNull()
  })

  it('is read-only without a primary key, on ClickHouse and in read-only mode', async () => {
    mocks.tableRows.mockImplementation(async () => rowsResponse([]))
    await renderView()
    expect(screen.getByTestId('data-project-table-readonly')).toHaveTextContent('No primary key')
    fireEvent.doubleClick(cell(0, 1))
    expect(screen.queryByTestId('data-project-grid-cell-input')).toBeNull()
    cleanup()
    mocks.tableRows.mockImplementation(async () => rowsResponse())
    await renderView({ ...baseProject, safeMode: 'read-only' })
    expect(screen.getByTestId('data-project-table-readonly')).toHaveTextContent('Read-only mode')
  })

  it('jumps to a typed page and counts an estimated total exactly', async () => {
    await renderView()
    expect(screen.getByTestId('data-project-table-range')).toHaveTextContent('of ~250')
    mocks.execute.mockResolvedValueOnce({
      status: 'ok',
      durationMs: 3,
      statements: [
        {
          index: 0,
          text: 'SELECT COUNT(*)',
          start: 0,
          end: 15,
          classification: 'read',
          durationMs: 2,
          output: {
            kind: 'rows',
            columns: [{ name: 'count', type: 'int8' }],
            rows: [['1234']],
            truncated: false,
            limit: null,
            autoLimited: false
          }
        }
      ]
    })
    await act(async () => {
      fireEvent.click(screen.getByTestId('data-project-table-count'))
    })
    expect(mocks.execute.mock.calls[0][0] as DataQueryRequest).toMatchObject({
      text: 'SELECT COUNT(*) FROM "public"."users"',
      database: 'shop',
      source: 'table',
      limit: null
    })
    await waitFor(() =>
      expect(screen.getByTestId('data-project-table-range')).toHaveTextContent('rows 1–2 of 1,234')
    )
    expect(screen.queryByTestId('data-project-table-count')).toBeNull()

    const page = screen.getByTestId('data-project-table-page') as HTMLInputElement
    expect(page.value).toBe('1')
    fireEvent.change(page, { target: { value: '5' } })
    await act(async () => {
      fireEvent.keyDown(page, { key: 'Enter' })
    })
    expect((mocks.tableRows.mock.calls.at(-1)?.[0] as DataTableRowsRequest).offset).toBe(400)
    // past the last page (13 of 1,234 rows) lands on the last one
    fireEvent.change(page, { target: { value: '99' } })
    await act(async () => {
      fireEvent.keyDown(page, { key: 'Enter' })
    })
    expect((mocks.tableRows.mock.calls.at(-1)?.[0] as DataTableRowsRequest).offset).toBe(1200)
  })

  it('reports staged edits to the workspace and drops them on a discard from there', async () => {
    useDataWorkspaceStore.getState().reset()
    await renderView()
    fireEvent.doubleClick(cell(0, 1))
    fireEvent.change(screen.getByTestId('data-project-grid-cell-input'), { target: { value: 'X' } })
    fireEvent.keyDown(screen.getByTestId('data-project-grid-cell-input'), { key: 'Enter' })
    expect(useDataWorkspaceStore.getState().stagedEdits[tab.id]).toBe(1)
    act(() => useDataWorkspaceStore.getState().discardStagedEdits('dp-1'))
    expect(screen.queryByTestId('data-project-pending-bar')).toBeNull()
    expect(useDataWorkspaceStore.getState().stagedEdits[tab.id]).toBeUndefined()
    // staged again, then the view unmounts (project switched): the flag goes with it
    fireEvent.doubleClick(cell(0, 1))
    fireEvent.change(screen.getByTestId('data-project-grid-cell-input'), { target: { value: 'Y' } })
    fireEvent.keyDown(screen.getByTestId('data-project-grid-cell-input'), { key: 'Enter' })
    expect(useDataWorkspaceStore.getState().stagedEdits[tab.id]).toBe(1)
    cleanup()
    expect(useDataWorkspaceStore.getState().stagedEdits[tab.id]).toBeUndefined()
  })

  it('lets its toolbars wrap so Export, paging and Commit stay reachable in narrow panes', async () => {
    await renderView()
    fireEvent.doubleClick(cell(0, 1))
    fireEvent.change(screen.getByTestId('data-project-grid-cell-input'), { target: { value: 'X' } })
    fireEvent.keyDown(screen.getByTestId('data-project-grid-cell-input'), { key: 'Enter' })
    // jsdom has no layout: assert the structure the container queries rely on instead.
    const toolbar = screen.getByTestId('data-project-table-export').closest('.flex-wrap')
    expect(toolbar).not.toBeNull()
    expect(toolbar).toContainElement(screen.getByTestId('data-project-table-next'))
    const exportGroup = screen.getByTestId('data-project-table-export').parentElement!
    const pagingGroup = screen.getByTestId('data-project-table-next').parentElement!
    expect(exportGroup).not.toBe(pagingGroup)
    expect(exportGroup.className).toContain('shrink-0')
    expect(pagingGroup.className).toContain('shrink-0')
    expect(screen.getByTestId('data-project-pending-bar').className).toContain('flex-wrap')
    expect(screen.getByTestId('data-project-pending-commit').parentElement!.className).toContain(
      'shrink-0'
    )
  })
  it('combines the filter rows with OR, sends the join and exports with it', async () => {
    await renderView()
    fireEvent.click(screen.getByTestId('data-project-filter-add'))
    fireEvent.change(screen.getByTestId('data-project-filter-value'), { target: { value: '1' } })
    // one row: nothing to join yet
    expect(screen.queryByTestId('data-project-filter-join')).toBeNull()
    fireEvent.click(screen.getByTestId('data-project-filter-add'))
    const rows = screen.getAllByTestId(/^data-project-filter-row-/)
    fireEvent.change(within(rows[1]).getByTestId('data-project-filter-column'), {
      target: { value: 'name' }
    })
    fireEvent.change(within(rows[1]).getByTestId('data-project-filter-value'), {
      target: { value: 'Bob' }
    })
    expect(screen.getByTestId('data-project-filter-connector')).toHaveTextContent('and')
    fireEvent.click(screen.getByTestId('data-project-filter-join-or'))
    expect(screen.getByTestId('data-project-filter-join-or')).toHaveAttribute(
      'aria-checked',
      'true'
    )
    expect(screen.getByTestId('data-project-filter-connector')).toHaveTextContent('or')
    await act(async () => {
      fireEvent.click(screen.getByTestId('data-project-filter-apply'))
    })
    expect(lastRequest()).toMatchObject({
      filters: [
        { column: 'id', operator: '=', value: '1' },
        { column: 'name', operator: '=', value: 'Bob' }
      ],
      filterJoin: 'or'
    })
    expect(screen.getByTestId('data-project-filter-apply')).toBeDisabled()

    fireEvent.click(screen.getByTestId('data-project-table-export-csv'))
    expect((mocks.startFullExport.mock.calls.at(-1) as unknown[])[0]).toEqual({
      dataProjectId: 'dp-1',
      source: {
        kind: 'table',
        ref: tab.ref,
        filters: [
          { column: 'id', operator: '=', value: '1' },
          { column: 'name', operator: '=', value: 'Bob' }
        ],
        filterJoin: 'or'
      },
      format: 'csv'
    } satisfies Omit<DataExportRequest, 'exportId'>)

    // back to AND: the request has its old shape (no filterJoin)
    fireEvent.click(screen.getByTestId('data-project-filter-connector'))
    expect(screen.getByTestId('data-project-filter-join-and')).toHaveAttribute(
      'aria-checked',
      'true'
    )
    await act(async () => {
      fireEvent.click(screen.getByTestId('data-project-filter-apply'))
    })
    expect(lastRequest().filters).toHaveLength(2)
    expect(lastRequest()).not.toHaveProperty('filterJoin')
  })

  it('narrows an OR group by value by replacing it, and Clear resets the join', async () => {
    await renderView()
    fireEvent.click(screen.getByTestId('data-project-filter-add'))
    fireEvent.click(screen.getByTestId('data-project-filter-add'))
    const values = screen.getAllByTestId('data-project-filter-value')
    fireEvent.change(values[0], { target: { value: '1' } })
    fireEvent.change(values[1], { target: { value: '2' } })
    fireEvent.click(screen.getByTestId('data-project-filter-join-or'))
    await act(async () => {
      fireEvent.click(screen.getByTestId('data-project-filter-apply'))
    })
    expect(lastRequest().filterJoin).toBe('or')
    fireEvent.contextMenu(cell(0, 1))
    await act(async () => {
      fireEvent.click(screen.getByTestId('data-project-grid-menu-filter'))
    })
    expect(lastRequest().filters).toEqual([{ column: 'name', operator: '=', value: 'Ann' }])
    expect(lastRequest()).not.toHaveProperty('filterJoin')
    expect(mocks.toastInfo).toHaveBeenCalledWith(expect.stringContaining('replaced the OR filters'))
    // an AND set is simply extended
    fireEvent.contextMenu(cell(0, 0))
    await act(async () => {
      fireEvent.click(screen.getByTestId('data-project-grid-menu-filter'))
    })
    expect(lastRequest().filters).toEqual([
      { column: 'name', operator: '=', value: 'Ann' },
      { column: 'id', operator: '=', value: '1' }
    ])
    expect(screen.getByTestId('data-project-filter-join-and')).toHaveAttribute(
      'aria-checked',
      'true'
    )
    fireEvent.click(screen.getByTestId('data-project-filter-join-or'))
    await act(async () => {
      fireEvent.click(screen.getByTestId('data-project-filter-clear'))
    })
    expect(lastRequest()).not.toHaveProperty('filters')
    expect(lastRequest()).not.toHaveProperty('filterJoin')
    fireEvent.click(screen.getByTestId('data-project-filter-add'))
    fireEvent.click(screen.getByTestId('data-project-filter-add'))
    expect(screen.getByTestId('data-project-filter-join-and')).toHaveAttribute(
      'aria-checked',
      'true'
    )
  })

  it('edits the selected row in the row detail panel as staged edits; ⌘S commits', async () => {
    await renderView()
    const toggle = screen.getByTestId('data-project-table-row-detail')
    expect(toggle).toHaveAttribute('aria-pressed', 'false')
    fireEvent.click(toggle)
    expect(toggle).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByTestId('data-project-row-detail-empty')).toBeInTheDocument()
    fireEvent.mouseDown(cell(0, 0), { button: 0 })
    expect(screen.getByTestId('data-project-row-detail-title')).toHaveTextContent('Row 1')
    expect(
      within(screen.getByTestId('data-project-row-detail-field-0')).getByLabelText(
        'Primary key column'
      )
    ).toBeInTheDocument()
    // a field edit is a staged cell edit: grid overlay, pending bar
    fireEvent.change(detailInput(1), { target: { value: 'Anna' } })
    fireEvent.keyDown(detailInput(1), { key: 'Enter' })
    expect(cell(0, 1)).toHaveAttribute('data-cell-state', 'modified')
    expect(cell(0, 1)).toHaveTextContent('Anna')
    expect(screen.getByTestId('data-project-row-detail-field-1')).toHaveAttribute(
      'data-cell-state',
      'modified'
    )
    expect(screen.getByTestId('data-project-pending-count')).toHaveTextContent('1 pending change')
    // Set NULL, then back to text; ⌘S in the field stages it and commits in one keystroke
    fireEvent.click(
      within(screen.getByTestId('data-project-row-detail-field-1')).getByTestId(
        'data-project-row-detail-set-null'
      )
    )
    expect(cell(0, 1)).toHaveTextContent('NULL')
    fireEvent.change(detailInput(1), { target: { value: 'Annie' } })
    mocks.applyEdits.mockResolvedValueOnce({
      status: 'ok',
      statements: ['UPDATE'],
      affectedRows: 1,
      durationMs: 2
    })
    await act(async () => {
      fireEvent.keyDown(detailInput(1), { key: 's', metaKey: true })
    })
    expect(mocks.applyEdits).toHaveBeenCalledTimes(1)
    expect((mocks.applyEdits.mock.calls[0][0] as DataApplyEditsRequest).edits).toEqual([
      { kind: 'update', key: { id: 1 }, changes: { name: 'Annie' } }
    ])
    await waitFor(() => expect(screen.queryByTestId('data-project-pending-bar')).toBeNull())
    // the panel stays open across reloads and remembers the choice for the next view
    expect(screen.getByTestId('data-project-row-detail')).toBeInTheDocument()
    cleanup()
    await renderView()
    expect(screen.getByTestId('data-project-row-detail')).toBeInTheDocument()
  })

  it('shows a read-only row detail when the table cannot be edited', async () => {
    mocks.tableRows.mockImplementation(async () => rowsResponse([]))
    await renderView()
    fireEvent.click(screen.getByTestId('data-project-table-row-detail'))
    fireEvent.mouseDown(cell(1, 1), { button: 0 })
    expect(screen.getByTestId('data-project-row-detail-title')).toHaveTextContent('Row 2')
    expect(screen.queryByTestId('data-project-row-detail-input')).toBeNull()
    expect(
      within(screen.getByTestId('data-project-row-detail-field-1')).getByTestId(
        'data-project-row-detail-value'
      )
    ).toHaveTextContent('Bob')
    // Space in the grid closes it
    fireEvent.keyDown(screen.getByTestId('data-project-result-grid'), { key: ' ' })
    expect(screen.queryByTestId('data-project-row-detail')).toBeNull()
  })
})
