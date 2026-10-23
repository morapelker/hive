// SqlWorkspace guards and the editor-bridge queue, with the RPC API, the connection store and
// the editor mocked: a waiting insertion is applied once under React.StrictMode; an insertion for
// a project that is not on screen waits for that project's workspace; "Close others" asks once
// when drafts / staged edits would be lost and cancels the closed tabs' running queries; closing
// a table tab with staged edits asks; `confirmDiscardPendingEdits` (project switch, connection
// edit) is answered by the workspace; DDL run in a query tab reloads the explorer and completion.
// Radix context menus are plain elements here (an opened Radix menu keeps jsdom busy).
import type { ReactNode } from 'react'
import { StrictMode, forwardRef } from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DataProject } from '@shared/data-projects/types'

const mocks = vi.hoisted(() => ({
  ensureConnected: vi.fn(async () => true),
  api: {
    databases: vi.fn(async () => [{ name: 'shop' }]),
    objects: vi.fn(async () => ({
      schemas: ['public'],
      objects: [{ name: 'users', schema: 'public', kind: 'table' }]
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
    ddl: vi.fn(async () => 'CREATE TABLE users (id int)'),
    cancel: vi.fn(async () => ({ cancelled: true })),
    execute: vi.fn()
  }
}))

vi.mock('@/api/data-projects-api', () => ({ dataProjectsApi: mocks.api }))
vi.mock('@/api/system-api', () => ({
  systemApi: { onCloseSessionShortcut: () => () => undefined }
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
  QueryEditor: forwardRef(function MockEditor(props: { value: string }, _ref) {
    return <textarea data-testid="data-project-query-editor" value={props.value} readOnly />
  })
}))
vi.mock('@/components/ui/context-menu', () => {
  type Props = { children?: ReactNode; 'data-testid'?: string }
  const Pass = ({ children }: Props): ReactNode => children
  const Box = ({ children }: Props): ReactNode => <div hidden>{children}</div>
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

const { useDataWorkspaceStore, confirmDiscardPendingEdits } =
  await import('@/stores/useDataWorkspaceStore')
const { selectPendingFor, useDataEditorBridge } =
  await import('@/components/data-projects/editor-bridge')
const { runQueryInTab } = await import('./query-runner')
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

const store = () => useDataWorkspaceStore.getState()
const ws = (id = 'dp-1') => store().workspaces[id]
const titles = (id = 'dp-1') => ws(id).tabs.map((t) => t.title)
const cell = (row: number, col: number): HTMLElement =>
  document.querySelector(`[data-row="${row}"][data-col="${col}"]`) as HTMLElement

beforeAll(() => {
  Element.prototype.hasPointerCapture ??= () => false
  Element.prototype.releasePointerCapture ??= () => undefined
  Element.prototype.scrollIntoView ??= () => undefined
})
beforeEach(() => {
  localStorage.clear()
  store().reset()
  useDataEditorBridge.getState().clear()
  mocks.api.cancel.mockClear()
  mocks.api.execute.mockReset()
})
afterEach(cleanup)

async function renderWorkspace(node: ReactNode = <SqlWorkspace project={project} />) {
  render(node)
  await screen.findByTestId('data-project-schema-object-table-users')
}

/** Opens users from the tree and stages one cell edit (id 1 → 5). */
async function stageEditInUsers(): Promise<string> {
  await act(async () => {
    fireEvent.click(screen.getByTestId('data-project-schema-object-table-users'))
  })
  await waitFor(() => expect(cell(0, 0)).toHaveTextContent('1'))
  fireEvent.doubleClick(cell(0, 0))
  const input = screen.getByTestId('data-project-grid-cell-input')
  fireEvent.change(input, { target: { value: '5' } })
  fireEvent.keyDown(input, { key: 'Enter' })
  expect(screen.getByTestId('data-project-pending-count')).toHaveTextContent('1 pending change')
  return ws().tabs.find((t) => t.kind === 'table')!.id
}

describe('SqlWorkspace bridge queue', () => {
  it('applies an insertion that waited for the workspace once under StrictMode', async () => {
    useDataEditorBridge.getState().insert({
      dataProjectId: 'dp-1',
      text: 'SELECT 42',
      mode: 'new-tab',
      title: 'AI: answer',
      origin: 'assistant'
    })
    await renderWorkspace(
      <StrictMode>
        <SqlWorkspace project={project} />
      </StrictMode>
    )
    await waitFor(() => expect(titles()).toEqual(['Query 1', 'AI: answer']))
    expect(selectPendingFor('dp-1')(useDataEditorBridge.getState())).toBeNull()
  })

  it('keeps an insertion for a project that is not on screen until its workspace opens', async () => {
    await renderWorkspace()
    act(() => {
      useDataEditorBridge
        .getState()
        .insert({ dataProjectId: 'dp-2', text: 'SELECT b', mode: 'new-tab', title: 'AI: b' })
      useDataEditorBridge
        .getState()
        .insert({ dataProjectId: 'dp-1', text: 'SELECT a', mode: 'new-tab', title: 'AI: a' })
    })
    await waitFor(() => expect(titles()).toEqual(['Query 1', 'AI: a']))
    expect(ws('dp-2')).toBeUndefined()
    cleanup()
    render(<SqlWorkspace project={{ ...project, id: 'dp-2', name: 'Other' }} />)
    await waitFor(() => expect(titles('dp-2')).toEqual(['Query 1', 'AI: b']))
  })
})

describe('SqlWorkspace close guards', () => {
  it('asks once before Close others drops drafts and staged edits, and cancels their queries', async () => {
    await renderWorkspace()
    const draft = ws().tabs[0].id
    act(() => store().updateQueryText('dp-1', draft, 'SELECT draft'))
    const slow = store().openQuery('dp-1', 'SELECT pg_sleep(60)')
    act(() => {
      store().startRun(slow, {
        status: 'running',
        target: { text: 'SELECT pg_sleep(60)', from: 0, to: 19, mode: 'current' },
        queryId: 'qid-slow',
        startedAt: Date.now(),
        limit: null,
        statements: [],
        activeResult: 0
      })
    })
    await stageEditInUsers()
    const keep = store().openQuery('dp-1', 'SELECT 1')
    await waitFor(() => expect(ws().tabs).toHaveLength(4))

    fireEvent.click(screen.getByTestId('data-project-tab-close-others-3'))
    const dialog = await screen.findByTestId('data-project-close-dirty-dialog')
    expect(dialog).toHaveTextContent('Close 3 tabs?')
    expect(dialog).toHaveTextContent('1 unsaved query (Query 1)')
    expect(dialog).toHaveTextContent('1 pending change in users')
    fireEvent.click(screen.getByText('Keep editing'))
    await waitFor(() => expect(screen.queryByTestId('data-project-close-dirty-dialog')).toBeNull())
    expect(ws().tabs).toHaveLength(4)
    expect(mocks.api.cancel).not.toHaveBeenCalledWith('qid-slow')

    fireEvent.click(screen.getByTestId('data-project-tab-close-others-3'))
    await act(async () => {
      fireEvent.click(await screen.findByTestId('data-project-close-dirty-confirm'))
    })
    expect(ws().tabs.map((t) => t.id)).toEqual([keep])
    expect(ws().activeTabId).toBe(keep)
    expect(mocks.api.cancel).toHaveBeenCalledWith('qid-slow')
    expect(store().stagedEdits).toEqual({})
  })

  it('closes clean tabs to the right at once', async () => {
    await renderWorkspace()
    store().openQuery('dp-1', 'SELECT 2')
    store().openSpecialTab('dp-1', 'history')
    await waitFor(() => expect(ws().tabs).toHaveLength(3))
    fireEvent.click(screen.getByTestId('data-project-tab-close-right-0'))
    expect(titles()).toEqual(['Query 1'])
    expect(screen.queryByTestId('data-project-close-dirty-dialog')).toBeNull()
  })

  it('asks before closing a table tab with staged edits', async () => {
    await renderWorkspace()
    await stageEditInUsers()
    fireEvent.click(screen.getByTestId('data-project-tab-close-1'))
    expect(await screen.findByTestId('data-project-close-dirty-dialog')).toHaveTextContent(
      'Discard 1 pending change in “users”?'
    )
    fireEvent.click(screen.getByText('Keep editing'))
    await waitFor(() => expect(screen.queryByTestId('data-project-close-dirty-dialog')).toBeNull())
    expect(titles()).toEqual(['Query 1', 'users'])
    fireEvent.click(screen.getByTestId('data-project-tab-close-1'))
    await act(async () => {
      fireEvent.click(await screen.findByTestId('data-project-close-dirty-confirm'))
    })
    expect(titles()).toEqual(['Query 1'])
    expect(store().stagedEdits).toEqual({})
  })

  it('answers "discard the staged edits?" before the project is left', async () => {
    await renderWorkspace()
    await stageEditInUsers()
    let answer: Promise<boolean> = Promise.resolve(true)
    act(() => {
      answer = confirmDiscardPendingEdits('dp-1')
    })
    expect(await screen.findByTestId('data-project-leave-dirty-dialog')).toHaveTextContent(
      'Discard 1 pending change?'
    )
    fireEvent.click(screen.getByTestId('data-project-leave-dirty-keep'))
    await expect(answer).resolves.toBe(false)
    expect(screen.getByTestId('data-project-pending-bar')).toBeInTheDocument()

    act(() => {
      answer = confirmDiscardPendingEdits('dp-1')
    })
    await act(async () => {
      fireEvent.click(await screen.findByTestId('data-project-leave-dirty-discard'))
    })
    await expect(answer).resolves.toBe(true)
    await waitFor(() => expect(screen.queryByTestId('data-project-pending-bar')).toBeNull())
  })
})

describe('SqlWorkspace schema changes', () => {
  it('reloads the explorer and the completion schema after DDL in a query tab', async () => {
    await renderWorkspace()
    await waitFor(() => expect(mocks.api.completionSchema).toHaveBeenCalled())
    const objectLoads = mocks.api.objects.mock.calls.length
    mocks.api.completionSchema.mockClear()
    mocks.api.execute.mockResolvedValueOnce({
      status: 'ok',
      durationMs: 3,
      database: 'shop',
      statements: [
        {
          index: 0,
          text: 'CREATE TABLE tmp_fix_d (id int)',
          start: 0,
          end: 31,
          classification: 'ddl',
          durationMs: 2,
          output: { kind: 'command', message: 'CREATE TABLE' }
        }
      ]
    })
    await act(async () => {
      await runQueryInTab({
        project,
        tabId: ws().tabs[0].id,
        target: { text: 'CREATE TABLE tmp_fix_d (id int)', from: 0, to: 31, mode: 'current' },
        database: 'shop',
        limit: 1000
      })
    })
    await waitFor(() => expect(mocks.api.objects.mock.calls.length).toBeGreaterThan(objectLoads))
    expect(mocks.api.completionSchema).toHaveBeenCalledWith('dp-1', 'shop', true)
  })
})
