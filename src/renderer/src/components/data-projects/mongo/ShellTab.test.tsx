// Shell tab against a mocked API (the editor is a stub that triggers onRun): the execute request
// (source 'mongo', tab database or the connection's default, limit), document / value / error
// outputs with the Messages tab, `use x` / `use "x"` switching the tab database, the error
// underline range, a declined confirmation, the assistant-origin badge cleared on run, a run
// that survives switching tabs (and is cancelled when its tab closes), and Save / ⌘S — including
// a tab restored with masked secrets, which reloads the saved text or never saves over it.
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { forwardRef, useImperativeHandle } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DataProject, DataQueryRequest } from '@shared/data-projects/types'

const mocks = vi.hoisted(() => ({
  execute: vi.fn(),
  cancel: vi.fn(async (_queryId: string) => ({ cancelled: true })),
  saveQuery: vi.fn(),
  savedQueries: vi.fn(),
  onSave: null as null | (() => void),
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() },
  decline: false,
  lastErrorRange: null as unknown,
  target: { text: '', from: 0, to: 0, mode: 'current' as 'current' | 'selection' | 'all' }
}))

vi.mock('@/api/data-projects-api', () => ({
  dataProjectsApi: {
    execute: mocks.execute,
    cancel: mocks.cancel,
    saveQuery: mocks.saveQuery,
    savedQueries: mocks.savedQueries,
    completionSchema: vi.fn(async () => ({ databases: [], tables: [] }))
  }
}))
vi.mock('@/lib/toast', () => ({ toast: mocks.toast }))
vi.mock('@/components/data-projects/shared', () => ({
  runWithConfirmation: async (
    call: (token?: string) => Promise<{ status: string; confirmToken?: string }>
  ) => {
    const response = await call()
    if (response.status === 'confirmation_required') {
      if (mocks.decline) return { status: 'declined' }
      return call(response.confirmToken)
    }
    return response
  },
  StatementBadge: ({ classification }: { classification: string }) => (
    <span data-testid="badge">{classification}</span>
  ),
  SaveQueryDialog: ({
    open,
    initialName,
    onSave
  }: {
    open: boolean
    initialName: string
    onSave: (name: string) => Promise<void>
  }) =>
    open ? (
      <button data-testid="save-dialog-stub" onClick={() => void onSave('Daily orders')}>
        {initialName || '(empty)'}
      </button>
    ) : null,
  startFullExport: vi.fn(),
  safeFileStem: (s: string) => s
}))
vi.mock('@/components/data-projects/grid', () => ({ ResultGrid: () => <div /> }))
vi.mock('@/components/data-projects/editor', () => ({
  QueryEditor: forwardRef(function Stub(
    props: {
      value: string
      onRun?: (t: typeof mocks.target) => void
      onSave?: () => void
      errorRange?: unknown
    },
    ref
  ) {
    mocks.lastErrorRange = props.errorRange ?? null
    mocks.onSave = props.onSave ?? null
    useImperativeHandle(ref, () => ({
      getRunTarget: () => mocks.target,
      focus: () => undefined
    }))
    return <div data-testid="editor-stub">{props.value}</div>
  })
}))
vi.mock('@/stores/useDataProjectStore', () => {
  const state = { statuses: {}, openCredentialsPrompt: vi.fn() }
  const hook = (selector: (s: typeof state) => unknown) => selector(state)
  hook.getState = () => state
  return { useDataProjectStore: hook }
})

const { useMongoWorkspaceStore } = await import('@/stores/useMongoWorkspaceStore')
const { ShellTab, resetShellCache } = await import('./ShellTab')
type ShellTabState = import('@/stores/useMongoWorkspaceStore').MongoShellTab

const project = {
  id: 'dp-s',
  name: 'Mongo',
  engine: 'mongodb',
  config: { database: 'shop' }
} as unknown as DataProject

const shellTab = (): ShellTabState =>
  useMongoWorkspaceStore.getState().workspaces[project.id].tabs[0] as ShellTabState

function Harness(): React.JSX.Element {
  const tab = useMongoWorkspaceStore((s) => s.workspaces[project.id].tabs[0] as ShellTabState)
  return <ShellTab project={project} tab={tab} databases={['shop', 'admin']} />
}

const ok = (statements: unknown[], database?: string) => ({
  status: 'ok',
  statements,
  durationMs: 3,
  ...(database ? { database } : {})
})

beforeEach(() => {
  resetShellCache()
  mocks.decline = false
  useMongoWorkspaceStore.getState().reset()
  useMongoWorkspaceStore.getState().openShell(project.id, {
    database: 'shop',
    text: 'db.orders.find()',
    origin: 'assistant'
  })
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  useMongoWorkspaceStore.getState().reset()
})

describe('ShellTab', () => {
  it('runs the statement with the tab database and limit and shows the documents', async () => {
    mocks.target = { text: 'db.orders.find()', from: 0, to: 16, mode: 'current' }
    mocks.execute.mockResolvedValueOnce(
      ok([
        {
          index: 0,
          text: 'db.orders.find()',
          start: 0,
          end: 16,
          classification: 'read',
          durationMs: 2,
          output: {
            kind: 'documents',
            documents: [{ _id: { $oid: 'abc' }, n: 1 }],
            truncated: false,
            limit: 100
          }
        }
      ])
    )
    render(<Harness />)
    expect(screen.getByTestId('data-project-mongo-shell-origin')).toBeInTheDocument()
    await userEvent.click(screen.getByTestId('data-project-mongo-shell-run'))
    await waitFor(() => expect(mocks.execute).toHaveBeenCalledTimes(1))
    const req = mocks.execute.mock.calls[0][0] as DataQueryRequest
    expect(req).toMatchObject({
      dataProjectId: 'dp-s',
      text: 'db.orders.find()',
      database: 'shop',
      limit: 100,
      source: 'mongo'
    })
    expect(req.confirmToken).toBeUndefined()
    expect(await screen.findByTestId('data-project-mongo-shell-doc-count')).toHaveTextContent(
      '1 document'
    )
    expect(screen.getByTestId('data-project-mongo-shell-result-doc-0')).toHaveTextContent(
      "ObjectId('abc')"
    )
    // Running clears the "inserted by the assistant" badge.
    expect(screen.queryByTestId('data-project-mongo-shell-origin')).toBeNull()
  })

  it('switches the tab database after `use`, shows values and underlines errors', async () => {
    const doc = '    use admin\ndb.version()\ndb.x.find({ $bad: 1 })'
    const tabId = useMongoWorkspaceStore.getState().workspaces[project.id].tabs[0].id
    useMongoWorkspaceStore.getState().updateShell(project.id, tabId, { text: doc })
    mocks.target = { text: doc.slice(4), from: 4, to: doc.length, mode: 'all' }
    mocks.execute.mockResolvedValueOnce(
      ok(
        [
          {
            index: 0,
            text: 'use admin',
            start: 0,
            end: 9,
            classification: 'session',
            durationMs: 1,
            output: { kind: 'command', message: 'switched to db admin' }
          },
          {
            index: 1,
            text: 'db.version()',
            start: 10,
            end: 22,
            classification: 'read',
            durationMs: 1,
            output: { kind: 'value', value: '8.0.4' }
          },
          {
            index: 2,
            text: 'db.x.find({ $bad: 1 })',
            start: 23,
            end: 45,
            classification: 'read',
            durationMs: 1,
            output: null,
            error: { message: 'unknown top level operator: $bad', position: 12 }
          }
        ],
        'admin'
      )
    )
    render(<Harness />)
    await userEvent.click(screen.getByTestId('data-project-mongo-shell-run-all'))
    await waitFor(() =>
      expect(
        (useMongoWorkspaceStore.getState().workspaces[project.id].tabs[0] as ShellTabState).database
      ).toBe('admin')
    )
    // An error among several statements opens Messages.
    expect(await screen.findByTestId('data-project-mongo-shell-messages')).toHaveTextContent(
      'unknown top level operator'
    )
    expect(mocks.lastErrorRange).toEqual({
      from: 4 + 23 + 12,
      to: 4 + 23 + 13,
      message: 'unknown top level operator: $bad'
    })
    await userEvent.click(screen.getByTestId('data-project-mongo-shell-result-tab-1'))
    expect(screen.getByTestId('data-project-mongo-shell-value')).toHaveTextContent("'8.0.4'")
  })

  it('reports a declined confirmation and sends nothing more', async () => {
    mocks.decline = true
    mocks.target = { text: 'db.orders.deleteMany({})', from: 0, to: 24, mode: 'current' }
    mocks.execute.mockResolvedValueOnce({
      status: 'confirmation_required',
      plan: {},
      confirmToken: 't'
    })
    render(<Harness />)
    await userEvent.click(screen.getByTestId('data-project-mongo-shell-run'))
    expect(await screen.findByTestId('data-project-mongo-shell-messages')).toHaveTextContent(
      'not confirmed'
    )
    expect(mocks.execute).toHaveBeenCalledTimes(1)
  })
})

describe('ShellTab: database, background runs and saving', () => {
  const docsResult = (text: string) =>
    ok([
      {
        index: 0,
        text,
        start: 0,
        end: text.length,
        classification: 'read',
        durationMs: 2,
        output: { kind: 'documents', documents: [{ n: 1 }], truncated: false, limit: 100 }
      }
    ])

  it('takes the target of `use "shop"` unquoted', async () => {
    useMongoWorkspaceStore.getState().updateShell(project.id, shellTab().id, { database: 'admin' })
    mocks.target = { text: 'use "shop"', from: 0, to: 10, mode: 'current' }
    mocks.execute.mockResolvedValueOnce(
      ok([
        {
          index: 0,
          text: 'use "shop"',
          start: 0,
          end: 10,
          classification: 'session',
          durationMs: 1,
          output: { kind: 'command', message: 'switched to db shop' }
        }
      ])
    )
    render(<Harness />)
    await userEvent.click(screen.getByTestId('data-project-mongo-shell-run'))
    await waitFor(() => expect(shellTab().database).toBe('shop'))
  })

  it("sends the connection's default database for a '(connection default)' tab", async () => {
    useMongoWorkspaceStore.getState().updateShell(project.id, shellTab().id, { database: '' })
    mocks.target = { text: 'db.orders.find()', from: 0, to: 16, mode: 'current' }
    mocks.execute.mockResolvedValueOnce(docsResult('db.orders.find()'))
    render(<Harness />)
    await userEvent.click(screen.getByTestId('data-project-mongo-shell-run'))
    await waitFor(() => expect(mocks.execute).toHaveBeenCalledTimes(1))
    expect(mocks.execute.mock.calls[0][0]).toMatchObject({ database: 'shop' })
  })

  it('keeps a run going (with Cancel) across a tab switch and shows its result on return', async () => {
    let resolve!: (value: unknown) => void
    mocks.execute.mockImplementationOnce(() => new Promise((r) => (resolve = r)))
    mocks.target = { text: 'db.orders.find()', from: 0, to: 16, mode: 'current' }
    const first = render(<Harness />)
    await userEvent.click(screen.getByTestId('data-project-mongo-shell-run'))
    expect(await screen.findByTestId('data-project-mongo-shell-cancel')).toBeInTheDocument()
    // Switching tabs unmounts the Shell tab: the statement is not cancelled.
    first.unmount()
    expect(mocks.cancel).not.toHaveBeenCalled()
    render(<Harness />)
    expect(screen.getByTestId('data-project-mongo-shell-cancel')).toBeInTheDocument()
    expect(screen.queryByTestId('data-project-mongo-shell-run')).toBeNull()
    await act(async () => resolve(docsResult('db.orders.find()')))
    expect(await screen.findByTestId('data-project-mongo-shell-doc-count')).toHaveTextContent(
      '1 document'
    )
    expect(screen.getByTestId('data-project-mongo-shell-run')).toBeInTheDocument()
    // A second run is not blocked by the finished one.
    mocks.execute.mockResolvedValueOnce(docsResult('db.orders.find()'))
    await userEvent.click(screen.getByTestId('data-project-mongo-shell-run'))
    await waitFor(() => expect(mocks.execute).toHaveBeenCalledTimes(2))
  })

  it('cancels a statement still running when its tab is closed', async () => {
    mocks.execute.mockImplementationOnce(
      (req: DataQueryRequest) =>
        new Promise((_resolve, reject) => {
          mocks.cancel.mockImplementationOnce(async (queryId: string) => {
            if (queryId === req.queryId)
              reject(Object.assign(new Error('x'), { name: 'Cancelled' }))
            return { cancelled: true }
          })
        })
    )
    mocks.target = { text: 'db.slow.aggregate([])', from: 0, to: 21, mode: 'current' }
    const view = render(<Harness />)
    await userEvent.click(screen.getByTestId('data-project-mongo-shell-run'))
    await screen.findByTestId('data-project-mongo-shell-cancel')
    const queryId = (mocks.execute.mock.calls[0][0] as DataQueryRequest).queryId
    view.unmount()
    act(() => useMongoWorkspaceStore.getState().closeTab(project.id, shellTab().id))
    expect(mocks.cancel).toHaveBeenCalledWith(queryId)
  })

  it('saves the tab as a query (Save, then ⌘S updates it) and marks it clean', async () => {
    mocks.saveQuery
      .mockResolvedValueOnce({ id: 'sq-1', name: 'Daily orders', text: '', database: 'shop' })
      .mockResolvedValueOnce({ id: 'sq-1', name: 'Daily orders', text: '', database: 'shop' })
    useMongoWorkspaceStore
      .getState()
      .updateShell(project.id, shellTab().id, { text: 'db.orders.find({ day: 1 })' })
    render(<Harness />)
    await userEvent.click(screen.getByTestId('data-project-mongo-shell-save'))
    // "Shell 1" is not offered as a name.
    expect(screen.getByTestId('save-dialog-stub')).toHaveTextContent('(empty)')
    await userEvent.click(screen.getByTestId('save-dialog-stub'))
    await waitFor(() => expect(mocks.saveQuery).toHaveBeenCalledTimes(1))
    expect(mocks.saveQuery).toHaveBeenLastCalledWith('dp-s', {
      name: 'Daily orders',
      text: 'db.orders.find({ day: 1 })',
      database: 'shop'
    })
    await waitFor(() =>
      expect(shellTab()).toMatchObject({
        savedQueryId: 'sq-1',
        title: 'Daily orders',
        baseline: 'db.orders.find({ day: 1 })'
      })
    )
    expect(mocks.toast.success).toHaveBeenCalledWith('Saved "Daily orders"')

    // ⌘S on a linked tab updates the saved query without asking for a name.
    useMongoWorkspaceStore
      .getState()
      .updateShell(project.id, shellTab().id, { text: 'db.orders.find({ day: 2 })' })
    act(() => mocks.onSave?.())
    await waitFor(() => expect(mocks.saveQuery).toHaveBeenCalledTimes(2))
    expect(mocks.saveQuery).toHaveBeenLastCalledWith('dp-s', {
      id: 'sq-1',
      name: 'Daily orders',
      text: 'db.orders.find({ day: 2 })',
      database: 'shop'
    })
  })
})

describe('ShellTab: a tab restored with masked secrets', () => {
  const real = "db.createUser({ user: 'app', pwd: 'S3cret!', roles: ['readWrite'] })"
  const masked = "db.createUser({ user: 'app', pwd: '***', roles: ['readWrite'] })"
  /** The tab as rehydrated after a restart: masked text, still linked, clean. */
  const restore = (patch: Partial<ShellTabState> = {}): void => {
    useMongoWorkspaceStore.getState().updateShell(project.id, shellTab().id, {
      text: masked,
      baseline: masked,
      title: 'Create app user',
      savedQueryId: 'sq-1',
      masked: true,
      ...patch
    })
  }

  it('reloads the saved text when it opens unedited, then saves that text', async () => {
    restore()
    mocks.savedQueries.mockResolvedValue([
      { id: 'sq-0', name: 'Other', text: 'db.x.find()', database: null },
      { id: 'sq-1', name: 'Create app user', text: real, database: 'shop' }
    ])
    mocks.saveQuery.mockResolvedValue({ id: 'sq-1', name: 'Create app user', text: real })
    render(<Harness />)
    await waitFor(() =>
      expect(shellTab()).toMatchObject({ text: real, baseline: real, masked: false })
    )
    expect(mocks.savedQueries).toHaveBeenCalledWith('dp-s')
    act(() => mocks.onSave?.())
    await waitFor(() => expect(mocks.saveQuery).toHaveBeenCalledTimes(1))
    expect(mocks.saveQuery).toHaveBeenLastCalledWith('dp-s', {
      id: 'sq-1',
      name: 'Create app user',
      text: real,
      database: 'shop'
    })
  })

  it('never saves an edited masked copy over the saved query; Save as keeps it as a new one', async () => {
    restore({ text: `${masked}\ndb.users.find()` })
    mocks.saveQuery.mockResolvedValue({ id: 'sq-9', name: 'Daily orders', text: '' })
    render(<Harness />)
    expect(mocks.savedQueries).not.toHaveBeenCalled()

    act(() => mocks.onSave?.())
    expect(mocks.toast.warning).toHaveBeenCalledWith(expect.stringContaining('masked (***)'))
    expect(mocks.saveQuery).not.toHaveBeenCalled()
    // Save as, offered under another name.
    const dialog = screen.getByTestId('save-dialog-stub')
    expect(dialog).toHaveTextContent('Create app user (copy)')
    await userEvent.click(dialog)
    await waitFor(() => expect(mocks.saveQuery).toHaveBeenCalledTimes(1))
    expect(mocks.saveQuery.mock.calls[0][1]).not.toHaveProperty('id')
    await waitFor(() => expect(shellTab()).toMatchObject({ savedQueryId: 'sq-9', masked: false }))
  })

  it('leaves the masked text alone when the saved query is gone', async () => {
    restore()
    mocks.savedQueries.mockResolvedValue([])
    render(<Harness />)
    await waitFor(() => expect(mocks.savedQueries).toHaveBeenCalled())
    await act(async () => undefined)
    expect(shellTab()).toMatchObject({ text: masked, masked: true })
    await userEvent.click(screen.getByTestId('data-project-mongo-shell-save'))
    expect(mocks.saveQuery).not.toHaveBeenCalled()
  })
})

describe('ShellTab: narrow panes', () => {
  it('wraps the toolbar and collapses secondary labels, keeping Run labelled', () => {
    render(<Harness />)
    const toolbar = screen
      .getByTestId('data-project-mongo-shell-run')
      .closest('.\\@container\\/mst')
    expect(toolbar?.className).toContain('flex-wrap')
    for (const [id, text] of [
      ['data-project-mongo-shell-run-all', 'Run all'],
      ['data-project-mongo-shell-save', 'Save']
    ]) {
      expect(screen.getByTestId(id).querySelector('span')?.textContent).toBe(text)
      expect(screen.getByTestId(id).querySelector('span')?.className).toMatch(
        /hidden @\[\d+px\]\/mst:inline/
      )
    }
    expect(screen.getByTestId('data-project-mongo-shell-run')).toHaveTextContent('Run')
  })
})
