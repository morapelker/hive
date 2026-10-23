// The Documents tab against a mocked RPC API: the first Find on open (with count for
// "x–y of N"), Find with a typed filter (remembered in the recent filters), paging, Edit →
// replaceOne of the loaded version → the safe mode asks → re-sent with the confirm token →
// refresh, an edit that hits a document changed meanwhile (Reload / Overwrite), Delete with the
// inline confirmation → deleteOne by _id, re-reading a projected document in full before editing,
// Update/Delete matching… with the query bar's collation, and the error banner. The editors are
// replaced by textareas (CodeMirror has its own tests); the confirm dialog is simulated as "the
// user confirmed".
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { forwardRef, useImperativeHandle } from 'react'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DataProject, MongoFindRequest, MongoWriteRequest } from '@shared/data-projects/types'

const mocks = vi.hoisted(() => ({
  find: vi.fn(),
  write: vi.fn(),
  explain: vi.fn(),
  cancel: vi.fn(async () => ({ cancelled: true })),
  confirmations: [] as unknown[],
  focus: vi.fn(),
  toast: {
    success: vi.fn(),
    error: vi.fn(),
    warning: vi.fn(),
    info: vi.fn(),
    loading: vi.fn(),
    dismiss: vi.fn()
  }
}))

vi.mock('@/api/data-projects-api', () => ({
  dataProjectsApi: {
    mongo: { find: mocks.find, write: mocks.write, explain: mocks.explain },
    cancel: mocks.cancel,
    completionSchema: vi.fn(async () => ({ databases: ['shop'], tables: [] })),
    saveTextFile: vi.fn(async () => ({ filePath: null })),
    onExportProgress: () => () => undefined
  }
}))

// The shared confirm flow, with the dialog answered "Confirm".
vi.mock('@/components/data-projects/shared', () => ({
  runWithConfirmation: async (call: (token?: string) => Promise<{ status: string }>) => {
    let response = (await call()) as { status: string; plan?: unknown; confirmToken?: string }
    if (response.status === 'confirmation_required') {
      mocks.confirmations.push(response.plan)
      response = (await call(response.confirmToken)) as typeof response
    }
    return response
  },
  startFullExport: vi.fn(async () => null),
  safeFileStem: (name: string) => name
}))

vi.mock('@/components/data-projects/grid', () => ({
  ResultGrid: ({ rows }: { rows: unknown[][] }) => (
    <div data-testid="grid-stub">{rows.length} rows</div>
  )
}))

vi.mock('@/stores/useDataProjectStore', () => {
  const state = { statuses: {}, openCredentialsPrompt: vi.fn() }
  const hook = (selector: (s: typeof state) => unknown) => selector(state)
  hook.getState = () => state
  return { useDataProjectStore: hook }
})

vi.mock('@/lib/toast', () => ({ toast: mocks.toast }))

vi.mock('./MongoCodeEditor', () => ({
  escapeClosesCompletionFirst: () => undefined,
  MongoCodeEditor: forwardRef(function Stub(
    props: {
      value: string
      onChange: (v: string) => void
      onSubmit?: () => void
      'data-testid'?: string
    },
    ref
  ) {
    useImperativeHandle(ref, () => ({
      focus: (cursor?: number) => mocks.focus(props['data-testid'], cursor),
      getView: () => null
    }))
    return (
      <textarea
        data-testid={props['data-testid']}
        value={props.value}
        onChange={(e) => props.onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) props.onSubmit?.()
        }}
      />
    )
  })
}))

const { useMongoWorkspaceStore } = await import('@/stores/useMongoWorkspaceStore')
const { DocumentsView, resetDocumentsCache } = await import('./DocumentsView')
type CollectionTab = import('@/stores/useMongoWorkspaceStore').MongoCollectionTab

const project: DataProject = {
  id: 'dp-m',
  name: 'Shop Mongo',
  engine: 'mongodb',
  config: { host: '127.0.0.1', port: 27018, database: 'shop' },
  icon: null,
  iconColor: null,
  environment: 'development',
  color: null,
  safeMode: 'half-safe',
  defaultLimit: 1000,
  allowAiDataAccess: false,
  pinned: false,
  secretState: 'stored',
  sortOrder: 0,
  createdAt: '2026-10-01T00:00:00.000Z',
  lastAccessedAt: '2026-10-01T00:00:00.000Z'
}

const OID_A = '66f0a0a0a0a0a0a0a0a0a0a1'
const OID_B = '66f0a0a0a0a0a0a0a0a0a0a2'
const docs = [
  { _id: { $oid: OID_A }, status: 'A', total: { $numberDouble: '10.0' } },
  { _id: { $oid: OID_B }, status: 'B', total: { $numberInt: '7' } }
]

const plan = {
  dataProjectId: 'dp-m',
  projectName: 'Shop Mongo',
  engine: 'mongodb',
  environment: 'development',
  safeMode: 'half-safe',
  statements: []
}

function Harness(): React.JSX.Element {
  const tab = useMongoWorkspaceStore(
    (s) => s.workspaces[project.id].tabs.find((t) => t.kind === 'collection') as CollectionTab
  )
  return <DocumentsView project={project} tab={tab} />
}

beforeAll(() => {
  // Radix menus in jsdom.
  Element.prototype.hasPointerCapture = () => false
  Element.prototype.releasePointerCapture = () => undefined
  Element.prototype.scrollIntoView = () => undefined
})

beforeEach(() => {
  resetDocumentsCache()
  useMongoWorkspaceStore.getState().reset()
  useMongoWorkspaceStore
    .getState()
    .openCollection(project.id, 'shop', 'orders', { collectionType: 'collection' })
  mocks.confirmations = []
  mocks.find.mockImplementation(async () => ({
    documents: docs,
    truncated: false,
    count: 2,
    durationMs: 4
  }))
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  useMongoWorkspaceStore.getState().reset()
})

const lastFind = (): MongoFindRequest => mocks.find.mock.calls.at(-1)![0] as MongoFindRequest

describe('DocumentsView', () => {
  it('runs Find when the tab opens and shows the page label', async () => {
    render(<Harness />)
    await screen.findByTestId('data-project-mongo-doc-0')
    expect(mocks.find).toHaveBeenCalledTimes(1)
    expect(lastFind()).toMatchObject({
      dataProjectId: 'dp-m',
      database: 'shop',
      collection: 'orders',
      limit: 20,
      withCount: true
    })
    expect(lastFind().filter).toBeUndefined()
    expect(screen.getByTestId('data-project-mongo-page-label')).toHaveTextContent('1–2 of 2')
    // mongosh-style values in the List view.
    expect(screen.getByTestId('data-project-mongo-doc-0')).toHaveTextContent(`ObjectId('${OID_A}')`)
  })

  it('runs the typed filter on Find and remembers it', async () => {
    render(<Harness />)
    await screen.findByTestId('data-project-mongo-doc-0')
    fireEvent.change(screen.getByTestId('data-project-mongo-filter'), {
      target: { value: "{ status: 'A' }" }
    })
    await userEvent.click(screen.getByTestId('data-project-mongo-find'))
    await waitFor(() => expect(mocks.find).toHaveBeenCalledTimes(2))
    expect(lastFind().filter).toBe("{ status: 'A' }")
    const history = useMongoWorkspaceStore.getState().filterHistory
    expect(Object.values(history)).toEqual([["{ status: 'A' }"]])
  })

  it('pages with the applied query', async () => {
    mocks.find.mockImplementation(async (req: MongoFindRequest) => ({
      documents: docs,
      truncated: true,
      count: req.skip ? 45 : 45,
      durationMs: 3
    }))
    render(<Harness />)
    await screen.findByTestId('data-project-mongo-doc-0')
    expect(screen.getByTestId('data-project-mongo-page-label')).toHaveTextContent('1–2 of 45')
    await userEvent.click(screen.getByTestId('data-project-mongo-next'))
    await waitFor(() => expect(lastFind().skip).toBe(20))
  })

  it('edits a document: replaceOne of the loaded version, confirms, re-sends with the token, refreshes', async () => {
    mocks.write
      .mockResolvedValueOnce({ status: 'confirmation_required', plan, confirmToken: 'tok-1' })
      .mockResolvedValueOnce({ status: 'ok', matchedCount: 1, modifiedCount: 1, durationMs: 3 })
    render(<Harness />)
    const card = await screen.findByTestId('data-project-mongo-doc-0')
    await userEvent.click(within(card).getByTestId('data-project-mongo-doc-0-edit'))
    const editor = await screen.findByTestId('data-project-mongo-doc-dialog-editor')
    // Lossless edit text: the integral double stays a Double.
    expect((editor as HTMLTextAreaElement).value).toContain('total: Double(10)')
    const edited = `{ _id: ObjectId('${OID_A}'), status: 'C', total: Double(10) }`
    fireEvent.change(editor, { target: { value: edited } })
    await userEvent.click(screen.getByTestId('data-project-mongo-doc-dialog-save'))

    await waitFor(() => expect(mocks.write).toHaveBeenCalledTimes(2))
    const first = mocks.write.mock.calls[0][0] as MongoWriteRequest
    const second = mocks.write.mock.calls[1][0] as MongoWriteRequest
    expect(first).toEqual({
      dataProjectId: 'dp-m',
      database: 'shop',
      collection: 'orders',
      op: 'replaceOne',
      // The loaded version only: every field and the field count (optimistic concurrency),
      // compared binary-exact whatever the collection's default collation.
      filter:
        `{ _id: ObjectId('${OID_A}'), status: 'A', total: Double(10), ` +
        "$expr: { $eq: [{ $size: { $objectToArray: '$$ROOT' } }, 3] } }",
      collation: "{ locale: 'simple' }",
      document: edited
    })
    expect(second).toEqual({ ...first, confirmToken: 'tok-1' })
    expect(mocks.confirmations).toHaveLength(1)
    await waitFor(() => expect(mocks.find).toHaveBeenCalledTimes(2))
    expect(mocks.toast.success).toHaveBeenCalledWith('Document saved')
    await waitFor(() => expect(screen.queryByTestId('data-project-mongo-doc-dialog')).toBeNull())
  })

  it('never overwrites a document changed meanwhile: Reload loads it, Overwrite forces', async () => {
    mocks.write.mockResolvedValue({
      status: 'ok',
      matchedCount: 0,
      modifiedCount: 0,
      durationMs: 1
    })
    render(<Harness />)
    const card = await screen.findByTestId('data-project-mongo-doc-0')
    await userEvent.click(within(card).getByTestId('data-project-mongo-doc-0-edit'))
    const editor = await screen.findByTestId('data-project-mongo-doc-dialog-editor')
    const mine = `{ _id: ObjectId('${OID_A}'), status: 'MINE', total: Double(10) }`
    fireEvent.change(editor, { target: { value: mine } })
    await userEvent.click(screen.getByTestId('data-project-mongo-doc-dialog-save'))
    expect(await screen.findByTestId('data-project-mongo-doc-dialog-conflict')).toHaveTextContent(
      'changed (or was deleted) since you opened it'
    )
    expect(mocks.toast.success).not.toHaveBeenCalled()
    // The user's text is still there.
    expect(screen.getByTestId('data-project-mongo-doc-dialog-editor')).toHaveValue(mine)

    // Reload: the current version, re-read by _id, becomes the editor text and the new baseline.
    mocks.find.mockResolvedValueOnce({
      documents: [{ _id: { $oid: OID_A }, status: 'shipped', total: { $numberInt: '11' } }],
      truncated: false,
      count: null,
      durationMs: 1
    })
    await userEvent.click(screen.getByTestId('data-project-mongo-doc-dialog-reload'))
    await waitFor(() =>
      expect(
        (screen.getByTestId('data-project-mongo-doc-dialog-editor') as HTMLTextAreaElement).value
      ).toContain("status: 'shipped'")
    )
    expect(lastFind()).toMatchObject({ filter: `{ _id: ObjectId('${OID_A}') }`, limit: 1 })
    expect(screen.queryByTestId('data-project-mongo-doc-dialog-conflict')).toBeNull()

    // Saving again matches the reloaded version; still changed → Overwrite sends _id only.
    await userEvent.click(screen.getByTestId('data-project-mongo-doc-dialog-save'))
    await waitFor(() =>
      expect((mocks.write.mock.calls.at(-1)![0] as MongoWriteRequest).filter).toContain(
        "status: 'shipped', total: 11"
      )
    )
    mocks.write.mockResolvedValueOnce({
      status: 'ok',
      matchedCount: 1,
      modifiedCount: 1,
      durationMs: 1
    })
    await userEvent.click(await screen.findByTestId('data-project-mongo-doc-dialog-overwrite'))
    await waitFor(() => expect(mocks.toast.success).toHaveBeenCalledWith('Document saved'))
    expect(mocks.write.mock.calls.at(-1)![0]).toMatchObject({
      op: 'replaceOne',
      filter: `{ _id: ObjectId('${OID_A}') }`
    })
    // Overwrite matches by _id alone: no collation needed.
    expect((mocks.write.mock.calls.at(-1)![0] as MongoWriteRequest).collation).toBeUndefined()
    await waitFor(() => expect(screen.queryByTestId('data-project-mongo-doc-dialog')).toBeNull())
  })

  it('keeps the dialog open with the server error when the save fails', async () => {
    mocks.write.mockRejectedValueOnce(new Error('Document: unsupported or unsafe expression'))
    render(<Harness />)
    const card = await screen.findByTestId('data-project-mongo-doc-1')
    await userEvent.click(within(card).getByTestId('data-project-mongo-doc-1-edit'))
    await userEvent.click(await screen.findByTestId('data-project-mongo-doc-dialog-save'))
    expect(await screen.findByTestId('data-project-mongo-doc-dialog-error')).toHaveTextContent(
      'unsupported or unsafe expression'
    )
    expect(screen.getByTestId('data-project-mongo-doc-dialog')).toBeInTheDocument()
  })

  it('deletes a document after the inline confirmation', async () => {
    mocks.write.mockResolvedValueOnce({ status: 'ok', deletedCount: 1, durationMs: 2 })
    render(<Harness />)
    const card = await screen.findByTestId('data-project-mongo-doc-1')
    await userEvent.click(within(card).getByTestId('data-project-mongo-doc-1-delete'))
    expect(mocks.write).not.toHaveBeenCalled()
    await userEvent.click(within(card).getByTestId('data-project-mongo-doc-1-delete-confirm'))
    await waitFor(() => expect(mocks.write).toHaveBeenCalledTimes(1))
    expect(mocks.write.mock.calls[0][0]).toEqual({
      dataProjectId: 'dp-m',
      database: 'shop',
      collection: 'orders',
      op: 'deleteOne',
      filter: `{ _id: ObjectId('${OID_B}') }`
    })
    await waitFor(() => expect(mocks.find).toHaveBeenCalledTimes(2))
    expect(mocks.toast.success).toHaveBeenCalledWith('Document deleted')
  })

  it('re-reads a projected document in full before editing it', async () => {
    const tabId = useMongoWorkspaceStore.getState().workspaces[project.id].activeTabId!
    useMongoWorkspaceStore.getState().updateQuery(project.id, tabId, { project: '{ status: 1 }' })
    mocks.find
      .mockResolvedValueOnce({
        documents: [{ _id: { $oid: OID_A }, status: 'A' }],
        truncated: false,
        count: 1,
        durationMs: 1
      })
      .mockResolvedValueOnce({ documents: [docs[0]], truncated: false, count: null, durationMs: 1 })
    render(<Harness />)
    const card = await screen.findByTestId('data-project-mongo-doc-0')
    await userEvent.click(within(card).getByTestId('data-project-mongo-doc-0-edit'))
    const editor = await screen.findByTestId('data-project-mongo-doc-dialog-editor')
    expect(lastFind()).toMatchObject({ filter: `{ _id: ObjectId('${OID_A}') }`, limit: 1 })
    expect(lastFind().projection).toBeUndefined()
    expect((editor as HTMLTextAreaElement).value).toContain('total: Double(10)')
  })

  it('focuses the filter after a Schema field click, once', async () => {
    const tabId = useMongoWorkspaceStore.getState().workspaces[project.id].activeTabId!
    useMongoWorkspaceStore.getState().addFilterField(project.id, tabId, 'total')
    const { unmount } = render(<Harness />)
    await screen.findByTestId('data-project-mongo-doc-0')
    expect(screen.getByTestId('data-project-mongo-filter')).toHaveValue('{ total:  }')
    expect(mocks.focus).toHaveBeenCalledWith('data-project-mongo-filter', '{ total: '.length)
    const tab = useMongoWorkspaceStore.getState().workspaces[project.id].tabs[0] as CollectionTab
    expect(tab.filterFocus).toBeUndefined()
    // Coming back to the tab later does not steal focus again.
    unmount()
    mocks.focus.mockClear()
    render(<Harness />)
    await screen.findByTestId('data-project-mongo-doc-0')
    expect(mocks.focus).not.toHaveBeenCalled()
  })

  it('Delete matching… counts and deletes with the query bar collation', async () => {
    const tabId = useMongoWorkspaceStore.getState().workspaces[project.id].activeTabId!
    const collation = "{ locale: 'en', numericOrdering: true }"
    useMongoWorkspaceStore
      .getState()
      .updateQuery(project.id, tabId, { filter: "{ v: { $gt: '10' } }", collation })
    render(<Harness />)
    await screen.findByTestId('data-project-mongo-doc-0')
    expect(lastFind()).toMatchObject({ collation })

    // Same filter and collation as the last Find: its count is reused, no recount.
    await userEvent.click(screen.getByTestId('data-project-mongo-delete-matching'))
    expect(await screen.findByTestId('data-project-mongo-bulk-count')).toHaveTextContent(
      'Will delete 2 documents'
    )
    expect(screen.getByTestId('data-project-mongo-bulk-collation')).toHaveTextContent(
      'numericOrdering'
    )
    expect(mocks.find).toHaveBeenCalledTimes(1)
    mocks.write.mockResolvedValueOnce({ status: 'ok', deletedCount: 2, durationMs: 1 })
    await userEvent.click(screen.getByTestId('data-project-mongo-bulk-submit'))
    await waitFor(() => expect(mocks.write).toHaveBeenCalledTimes(1))
    expect(mocks.write.mock.calls[0][0]).toEqual({
      dataProjectId: 'dp-m',
      database: 'shop',
      collection: 'orders',
      op: 'deleteMany',
      filter: "{ v: { $gt: '10' } }",
      collation
    })
    await waitFor(() => expect(screen.queryByTestId('data-project-mongo-bulk')).toBeNull())

    // The collation changed since the last Find: the count is not reused but redone with it.
    const changed = "{ locale: 'en' }"
    useMongoWorkspaceStore.getState().updateQuery(project.id, tabId, { collation: changed })
    const findsBefore = mocks.find.mock.calls.length
    mocks.find.mockImplementation(async () => ({
      documents: [],
      truncated: false,
      count: 3,
      durationMs: 1
    }))
    await userEvent.click(screen.getByTestId('data-project-mongo-update-matching'))
    await waitFor(() =>
      expect(screen.getByTestId('data-project-mongo-bulk-count')).toHaveTextContent(
        'Will update 3 documents'
      )
    )
    const count = mocks.find.mock.calls.at(-1)![0] as MongoFindRequest
    expect(mocks.find.mock.calls.length).toBeGreaterThan(findsBefore)
    expect(count).toMatchObject({ filter: "{ v: { $gt: '10' } }", collation: changed, limit: 1 })
  })

  it('Delete matching… recounts without the hint a Find counted with', async () => {
    const tabId = useMongoWorkspaceStore.getState().workspaces[project.id].activeTabId!
    // A sparse index: the hinted Find counts only the documents the index holds.
    useMongoWorkspaceStore
      .getState()
      .updateQuery(project.id, tabId, { filter: "{ status: 'A' }", hint: 'tag_1' })
    mocks.find.mockImplementation(async (req: MongoFindRequest) => ({
      documents: docs,
      truncated: false,
      count: req.hint ? 2 : 10,
      durationMs: 1
    }))
    render(<Harness />)
    await screen.findByTestId('data-project-mongo-doc-0')
    expect(lastFind()).toMatchObject({ hint: 'tag_1' })
    expect(screen.getByTestId('data-project-mongo-page-label')).toHaveTextContent('1–2 of 2')

    await userEvent.click(screen.getByTestId('data-project-mongo-delete-matching'))
    await waitFor(() =>
      expect(screen.getByTestId('data-project-mongo-bulk-count')).toHaveTextContent(
        'Will delete 10 documents'
      )
    )
    const count = lastFind()
    expect(count).toMatchObject({ filter: "{ status: 'A' }", limit: 1, withCount: true })
    expect(count.hint).toBeUndefined()
  })

  it('fits narrow panes: query-bar labels collapse, the rows wrap, Find stays labelled', async () => {
    render(<Harness />)
    await screen.findByTestId('data-project-mongo-doc-0')
    for (const id of [
      'data-project-mongo-options-toggle',
      'data-project-mongo-reset',
      'data-project-mongo-explain-button'
    ]) {
      const label = within(screen.getByTestId(id)).getByText(/Options|Reset|Explain/)
      expect(label.className).toMatch(/hidden @\[\d+px\]\/mqb:inline/)
    }
    expect(within(screen.getByTestId('data-project-mongo-find')).getByText('Find').tagName).toBe(
      'BUTTON'
    )
    const bar = screen.getByTestId('data-project-mongo-find').closest('.\\@container\\/mqb')
    expect(bar?.querySelector('.flex-wrap')).not.toBeNull()
    const actions = screen.getByTestId('data-project-mongo-next').closest('.\\@container\\/mdt')
    expect(actions?.className).toContain('flex-wrap')
    expect(actions?.className).not.toContain('overflow-hidden')
  })

  it('shows the server error of a failed Find', async () => {
    mocks.find.mockRejectedValueOnce(new Error('Filter: Unexpected token (1:9)'))
    render(<Harness />)
    expect(await screen.findByTestId('data-project-mongo-error')).toHaveTextContent(
      'Filter: Unexpected token'
    )
  })
})
