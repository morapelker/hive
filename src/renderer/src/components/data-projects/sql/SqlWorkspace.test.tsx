// SqlWorkspace wiring with the RPC API, the connection store and the editor mocked: connect on
// mount, database list → working database, the schema tree (groups, row estimates, filter),
// opening a table tab from the tree, Generate SELECT / Drop landing in new query tabs through the
// editor bridge (never run), bridge insertions from elsewhere (assistant replace, new tab), and
// ⌘W from the main process closing the active tab only while focus is inside the workspace.
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { forwardRef } from 'react'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DataProject } from '@shared/data-projects/types'

const mocks = vi.hoisted(() => ({
  ensureConnected: vi.fn(async () => true),
  closeShortcut: null as null | (() => void),
  api: {
    databases: vi.fn(async () => [
      { name: 'shop' },
      { name: 'information_schema', isSystem: true }
    ]),
    objects: vi.fn(async () => ({
      schemas: ['public', 'analytics'],
      objects: [
        { name: 'users', schema: 'public', kind: 'table', rowEstimate: 12000, sizeBytes: 65536 },
        { name: 'orders', schema: 'public', kind: 'table', rowEstimate: 1_200_000 },
        { name: 'active_users', schema: 'public', kind: 'view' },
        { name: 'touch_updated', schema: 'public', kind: 'function', detail: '' }
      ]
    })),
    completionSchema: vi.fn(async () => ({ databases: ['shop'], tables: [] })),
    describe: vi.fn(async () => ({
      ref: { name: 'users' },
      kind: 'table',
      columns: [{ name: 'id', type: 'int4', nullable: false, isPrimaryKey: true, ordinal: 1 }],
      indexes: [],
      foreignKeys: [],
      triggers: [],
      primaryKey: ['id']
    })),
    tableRows: vi.fn(async () => ({
      result: {
        kind: 'rows',
        columns: [{ name: 'id', type: 'int4' }],
        rows: [[1], [2]],
        truncated: false,
        limit: 100,
        autoLimited: false
      },
      sql: 'SELECT * FROM "public"."users" LIMIT 100',
      primaryKey: ['id'],
      totalRows: 2,
      totalIsEstimate: false,
      durationMs: 3
    })),
    ddl: vi.fn(async () => 'CREATE FUNCTION touch_updated() ...'),
    cancel: vi.fn(async () => ({ cancelled: true })),
    execute: vi.fn()
  }
}))

vi.mock('@/api/data-projects-api', () => ({ dataProjectsApi: mocks.api }))
vi.mock('@/api/system-api', () => ({
  systemApi: {
    onCloseSessionShortcut: (cb: () => void) => {
      mocks.closeShortcut = cb
      return () => {
        mocks.closeShortcut = null
      }
    }
  }
}))
vi.mock('@/stores/useDataProjectStore', async () => {
  const { create } = await import('zustand')
  const useDataProjectStore = create(() => ({
    statuses: { 'dp-1': { dataProjectId: 'dp-1', state: 'connected', currentDatabase: 'shop' } },
    credentialsRequired: {} as Record<string, string>,
    connectionEpoch: {} as Record<string, number>,
    ensureConnected: mocks.ensureConnected,
    connect: vi.fn(async () => true),
    openCredentialsPrompt: vi.fn()
  }))
  return { useDataProjectStore }
})
vi.mock('@/lib/toast', () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
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
vi.mock('../editor/QueryEditor', () => ({
  QueryEditor: forwardRef(function MockEditor(
    props: { value: string; 'data-testid'?: string },
    _ref
  ) {
    return (
      <textarea
        data-testid={props['data-testid'] ?? 'data-project-query-editor'}
        value={props.value}
        readOnly
      />
    )
  })
}))

const { useDataWorkspaceStore } = await import('@/stores/useDataWorkspaceStore')
const { useDataEditorBridge } = await import('@/components/data-projects/editor-bridge')
const { SqlWorkspace } = await import('./SqlWorkspace')

const project: DataProject = {
  id: 'dp-1',
  name: 'Shop PG',
  engine: 'postgres',
  config: { host: '127.0.0.1', database: 'shop' },
  icon: null,
  iconColor: null,
  environment: 'development',
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

const ws = () => useDataWorkspaceStore.getState().workspaces['dp-1']
const queryTexts = () => ws().tabs.flatMap((t) => (t.kind === 'query' ? [t.text] : []))

beforeAll(() => {
  Element.prototype.hasPointerCapture ??= () => false
  Element.prototype.releasePointerCapture ??= () => undefined
  Element.prototype.scrollIntoView ??= () => undefined
})
beforeEach(() => {
  localStorage.clear()
  useDataWorkspaceStore.getState().reset()
  mocks.ensureConnected.mockClear()
})
afterEach(cleanup)

async function renderWorkspace(): Promise<void> {
  render(<SqlWorkspace project={project} />)
  await screen.findByTestId('data-project-schema-object-table-users')
}

describe('SqlWorkspace', () => {
  it('connects, picks the database and lists objects by kind with estimates', async () => {
    await renderWorkspace()
    expect(mocks.ensureConnected).toHaveBeenCalledWith('dp-1')
    expect(ws().database).toBe('shop')
    expect(mocks.api.objects).toHaveBeenCalledWith('dp-1', 'shop', 'public')
    expect(screen.getByTestId('data-project-schema-group-table')).toHaveTextContent('Tables2')
    expect(screen.getByTestId('data-project-schema-object-table-orders')).toHaveTextContent('~1.2M')
    expect(screen.getByTestId('data-project-database-select')).toHaveValue('shop')
    expect(screen.getByTestId('data-project-schema-select')).toHaveValue('public')
    // one empty query tab to start with
    expect(ws().tabs.map((t) => t.kind)).toEqual(['query'])
  })

  it('filters the tree', async () => {
    await renderWorkspace()
    fireEvent.change(screen.getByTestId('data-project-schema-filter'), { target: { value: 'ord' } })
    expect(screen.queryByTestId('data-project-schema-object-table-users')).toBeNull()
    expect(screen.getByTestId('data-project-schema-object-table-orders')).toBeInTheDocument()
  })

  it('opens a table tab with its rows from the tree', async () => {
    await renderWorkspace()
    await act(async () => {
      fireEvent.click(screen.getByTestId('data-project-schema-object-table-users'))
    })
    expect(ws().tabs[1]).toMatchObject({
      kind: 'table',
      ref: { database: 'shop', schema: 'public', name: 'users' },
      view: 'data'
    })
    await screen.findByTestId('data-project-table-data')
    await waitFor(() =>
      expect(screen.getByTestId('data-project-table-range')).toHaveTextContent('rows 1–2 of 2')
    )
    // a function opens its DDL (its group starts collapsed)
    fireEvent.click(screen.getByTestId('data-project-schema-group-function'))
    await act(async () => {
      fireEvent.click(screen.getByTestId('data-project-schema-object-function-touch_updated'))
    })
    expect(ws().tabs[2]).toMatchObject({ kind: 'table', view: 'ddl' })
    expect(await screen.findByTestId('data-project-ddl-editor')).toHaveValue(
      'CREATE FUNCTION touch_updated() ...'
    )
    const fnPanel = screen.getByTestId(`data-project-table-tab-${ws().tabs[2].id}`)
    expect(within(fnPanel).queryByTestId('data-project-table-view-data')).toBeNull()
    expect(within(fnPanel).getByTestId('data-project-table-view-ddl')).toBeInTheDocument()
  })

  it('places schema-generated SQL (Generate SELECT / Drop) into new query tabs without running it', async () => {
    // The tree's context menu calls the editor bridge exactly like this (Radix menus are not
    // clicked here: they keep jsdom's event loop busy long after closing).
    await renderWorkspace()
    act(() => {
      useDataEditorBridge.getState().insert({
        dataProjectId: 'dp-1',
        text: 'SELECT *\nFROM "users"\nLIMIT 100;',
        mode: 'new-tab',
        database: 'shop',
        title: 'SELECT users',
        origin: 'schema'
      })
    })
    await waitFor(() => expect(queryTexts()).toContain('SELECT *\nFROM "users"\nLIMIT 100;'))
    const active = ws().tabs.find((t) => t.id === ws().activeTabId)
    expect(active).toMatchObject({
      kind: 'query',
      origin: 'schema',
      title: 'SELECT users',
      database: 'shop'
    })
    expect(screen.getByTestId('data-project-tab-origin-1')).toHaveTextContent('Gen')
    expect(mocks.api.execute).not.toHaveBeenCalled()
  })

  it('applies bridge insertions (replace into the active query tab, or a new tab)', async () => {
    await renderWorkspace()
    const first = ws().tabs[0].id
    act(() => {
      useDataEditorBridge
        .getState()
        .insert({ dataProjectId: 'dp-1', text: 'SELECT 42', mode: 'replace', origin: 'assistant' })
    })
    await waitFor(() =>
      expect(ws().tabs.find((t) => t.id === first)).toMatchObject({
        text: 'SELECT 42',
        origin: 'assistant'
      })
    )
    expect(useDataEditorBridge.getState().pending).toBeNull()
    act(() => {
      useDataEditorBridge
        .getState()
        .insert({ dataProjectId: 'other', text: 'ignored', mode: 'new-tab' })
    })
    expect(useDataEditorBridge.getState().pending).not.toBeNull()
    expect(ws().tabs).toHaveLength(1)
    act(() => {
      useDataEditorBridge.getState().insert({
        dataProjectId: 'dp-1',
        text: 'SELECT 7',
        mode: 'new-tab',
        title: 'AI: seven',
        origin: 'assistant'
      })
    })
    await waitFor(() => expect(ws().tabs).toHaveLength(2))
    expect(
      within(screen.getByTestId('data-project-tabs')).getByText('AI: seven')
    ).toBeInTheDocument()
  })

  it('closes the active tab on ⌘W only while focus is inside the workspace', async () => {
    await renderWorkspace()
    useDataWorkspaceStore.getState().openQuery('dp-1')
    await waitFor(() => expect(ws().tabs).toHaveLength(2))
    ;(document.body as HTMLElement).focus()
    act(() => mocks.closeShortcut?.())
    expect(ws().tabs).toHaveLength(2)
    const tree = screen.getByTestId('data-project-schema-tree')
    tree.focus()
    act(() => mocks.closeShortcut?.())
    expect(ws().tabs).toHaveLength(1)
  })

  it('asks before closing a query tab with unsaved text', async () => {
    await renderWorkspace()
    const id = ws().tabs[0].id
    act(() => useDataWorkspaceStore.getState().updateQueryText('dp-1', id, 'SELECT draft'))
    fireEvent.click(screen.getByTestId('data-project-tab-close-0'))
    expect(await screen.findByTestId('data-project-close-dirty-dialog')).toBeInTheDocument()
    fireEvent.click(screen.getByTestId('data-project-close-dirty-confirm'))
    await waitFor(() => expect(ws().tabs).toHaveLength(0))
    expect(screen.getByTestId('data-project-workspace-empty')).toBeInTheDocument()
  })
})
