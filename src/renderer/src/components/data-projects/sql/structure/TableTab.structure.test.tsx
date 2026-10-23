// TableTab wiring of the structure editor: the Structure view stays mounted while the tab shows
// Data or DDL (staged changes survive switching views), objects that cannot be altered get the
// read-only editor, and ⌘R from the data client refreshes the structure of the active tab.
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DataProject, DataTableDetails } from '@shared/data-projects/types'

const mocks = vi.hoisted(() => ({
  describe: vi.fn(),
  ddl: vi.fn(async () => 'CREATE TABLE public.users (id integer NOT NULL, note text);')
}))

vi.mock('@/api/data-projects-api', () => ({
  dataProjectsApi: {
    describe: mocks.describe,
    ddl: mocks.ddl,
    execute: vi.fn(),
    cancel: vi.fn(async () => ({ cancelled: true })),
    completionSchema: vi.fn(async () => ({ databases: [], tables: [] }))
  }
}))
vi.mock('@/stores/useDataProjectStore', () => {
  const state = () => ({
    statuses: { 'dp-1': { state: 'connected', serverVersion: 'PostgreSQL 17.11' } },
    openCredentialsPrompt: vi.fn()
  })
  return {
    useDataProjectStore: Object.assign(
      (selector: (s: ReturnType<typeof state>) => unknown) => selector(state()),
      { getState: state }
    )
  }
})
vi.mock('@/lib/toast', () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() }
}))
vi.mock('../../editor/QueryEditor', () => ({
  QueryEditor: (props: { value: string }) => (
    <textarea data-testid="data-project-ddl-editor" value={props.value} readOnly />
  )
}))

const { TableTab } = await import('../TableTab')
const { useDataWorkspaceStore } = await import('@/stores/useDataWorkspaceStore')
const { sendTableCommand } = await import('../../DataProjectWorkspaceHost')

const project: DataProject = {
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
const ref = { database: 'shop', schema: 'public', name: 'users', kind: 'table' as const }

const details = (kind: DataTableDetails['kind'] = 'table'): DataTableDetails => ({
  ref,
  kind,
  columns: [
    {
      name: 'id',
      type: 'integer',
      nullable: false,
      isPrimaryKey: true,
      ordinal: 1
    },
    { name: 'note', type: 'text', nullable: true, isPrimaryKey: false, ordinal: 2 }
  ],
  indexes: [],
  foreignKeys: [],
  triggers: [],
  primaryKey: ['id']
})

beforeAll(() => {
  Element.prototype.scrollIntoView ??= () => undefined
})
beforeEach(() => {
  mocks.describe.mockReset()
  mocks.describe.mockImplementation(async () => details())
  mocks.ddl.mockClear()
})
afterEach(() => cleanup())

const openTab = (view: 'structure' | 'ddl' = 'structure') => {
  const store = useDataWorkspaceStore.getState()
  const id = store.openTable('dp-1', ref, view)
  const tab = store.getWorkspace('dp-1')!.tabs.find((t) => t.id === id)!
  if (tab.kind !== 'table') throw new Error('not a table tab')
  return tab
}

describe('TableTab structure view', () => {
  it('keeps staged structure changes while the tab shows the DDL', async () => {
    const tab = openTab('structure')
    const view = render(<TableTab project={project} tab={tab} dialect="postgres" />)
    const note = await screen.findByTestId('data-project-structure-column-note')
    fireEvent.change(within(note).getByTestId('data-project-structure-col-comment'), {
      target: { value: 'kept' }
    })
    expect(screen.getByTestId('data-project-structure-pending-count')).toHaveTextContent(
      '1 pending'
    )
    view.rerender(<TableTab project={project} tab={{ ...tab, view: 'ddl' }} dialect="postgres" />)
    await screen.findByTestId('data-project-ddl-editor')
    expect(screen.getByTestId('data-project-table-structure').parentElement).toHaveClass('hidden')
    view.rerender(
      <TableTab project={project} tab={{ ...tab, view: 'structure' }} dialect="postgres" />
    )
    expect(
      (
        within(screen.getByTestId('data-project-structure-column-note')).getByTestId(
          'data-project-structure-col-comment'
        ) as HTMLInputElement
      ).value
    ).toBe('kept')
    expect(mocks.describe).toHaveBeenCalledTimes(1)
  })

  it('⌘R refreshes the structure of the active tab (asking first with staged changes)', async () => {
    const tab = openTab('structure')
    render(<TableTab project={project} tab={tab} dialect="postgres" />)
    await screen.findByTestId('data-project-structure-column-note')
    await waitFor(() => expect(mocks.ddl).toHaveBeenCalledTimes(1))
    expect(sendTableCommand({ projectId: 'dp-1', command: 'refresh' })).toBe(true)
    await waitFor(() => expect(mocks.describe).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(mocks.ddl).toHaveBeenCalledTimes(2))
    fireEvent.change(
      within(screen.getByTestId('data-project-structure-column-note')).getByTestId(
        'data-project-structure-col-name'
      ),
      { target: { value: 'memo' } }
    )
    expect(sendTableCommand({ projectId: 'dp-1', command: 'refresh' })).toBe(true)
    fireEvent.click(await screen.findByTestId('data-project-structure-discard-confirm'))
    await waitFor(() => expect(mocks.describe).toHaveBeenCalledTimes(3))
    expect(screen.queryByTestId('data-project-structure-pending-bar')).toBeNull()
  })

  it('a view gets the read-only structure with the reason', async () => {
    mocks.describe.mockImplementation(async () => details('view'))
    const tab = openTab('structure')
    render(
      <TableTab
        project={project}
        tab={{ ...tab, ref: { ...ref, kind: 'view' } }}
        dialect="postgres"
      />
    )
    expect(await screen.findByTestId('data-project-structure-readonly')).toHaveTextContent(
      'view’s columns come from its query'
    )
    expect(screen.queryByTestId('data-project-structure-add-column')).toBeNull()
  })
})
