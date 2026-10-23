// Aggregations tab against a mocked API: a card's preview request (enabled stages up to the
// card, stageIndex, limit 10) and its documents; Run of a pipeline with $out goes through the
// confirmation and re-sends with the token; text mode keeps disabled stages and converts back;
// a text-mode syntax problem keeps the user in text mode with the error; Create view sends
// db.createView through the gated execute and opens the view; the toolbar collapses in narrow
// panes instead of pushing Run out.
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { forwardRef } from 'react'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DataProject, MongoAggregateRequest } from '@shared/data-projects/types'

const mocks = vi.hoisted(() => ({
  aggregate: vi.fn(),
  execute: vi.fn(),
  confirmations: 0
}))

vi.mock('@/api/data-projects-api', () => ({
  dataProjectsApi: {
    mongo: { aggregate: mocks.aggregate, explain: vi.fn() },
    execute: mocks.execute,
    cancel: vi.fn(async () => ({ cancelled: true })),
    completionSchema: vi.fn(async () => ({ databases: [], tables: [] }))
  }
}))
vi.mock('@/components/data-projects/shared', () => ({
  runWithConfirmation: async (
    call: (token?: string) => Promise<{ status: string; confirmToken?: string }>
  ) => {
    let response = await call()
    if (response.status === 'confirmation_required') {
      mocks.confirmations++
      response = await call(response.confirmToken)
    }
    return response
  },
  startFullExport: vi.fn(),
  safeFileStem: (s: string) => s
}))
vi.mock('@/components/data-projects/grid', () => ({ ResultGrid: () => <div /> }))
vi.mock('@/stores/useDataProjectStore', () => {
  const state = { statuses: {}, openCredentialsPrompt: vi.fn() }
  const hook = (selector: (s: typeof state) => unknown) => selector(state)
  hook.getState = () => state
  return { useDataProjectStore: hook }
})
vi.mock('@/lib/toast', () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() }
}))
vi.mock('./MongoCodeEditor', () => ({
  escapeClosesCompletionFirst: () => undefined,
  MongoCodeEditor: forwardRef(function Stub(
    props: { value: string; onChange: (v: string) => void; 'data-testid'?: string },
    _ref
  ) {
    return (
      <textarea
        data-testid={props['data-testid']}
        value={props.value}
        onChange={(e) => props.onChange(e.target.value)}
      />
    )
  })
}))

const { useMongoWorkspaceStore } = await import('@/stores/useMongoWorkspaceStore')
const { AggregationsView, resetAggregationCache } = await import('./AggregationsView')
type CollectionTab = import('@/stores/useMongoWorkspaceStore').MongoCollectionTab

const project = {
  id: 'dp-a',
  name: 'Mongo',
  engine: 'mongodb',
  config: { host: '127.0.0.1' },
  icon: null,
  iconColor: null,
  environment: 'local',
  color: null,
  safeMode: 'half-safe',
  defaultLimit: 1000,
  allowAiDataAccess: false,
  pinned: false,
  secretState: 'stored',
  sortOrder: 0,
  createdAt: '',
  lastAccessedAt: ''
} as DataProject

function Harness(): React.JSX.Element {
  const tab = useMongoWorkspaceStore(
    (s) => s.workspaces[project.id].tabs.find((t) => t.kind === 'collection') as CollectionTab
  )
  return <AggregationsView project={project} tab={tab} />
}

let tabId = ''

beforeAll(() => {
  Element.prototype.hasPointerCapture = () => false
  Element.prototype.releasePointerCapture = () => undefined
  Element.prototype.scrollIntoView = () => undefined
})

beforeEach(() => {
  resetAggregationCache()
  useMongoWorkspaceStore.getState().reset()
  tabId = useMongoWorkspaceStore
    .getState()
    .openCollection(project.id, 'shop', 'orders', { subTab: 'aggregations' })
  useMongoWorkspaceStore.getState().updateAggregation(project.id, tabId, {
    autoPreview: false,
    stages: [
      { id: 's1', operator: '$match', body: "{ status: 'A' }", enabled: true, previewOpen: true },
      { id: 's2', operator: '$limit', body: '5', enabled: false, previewOpen: true },
      {
        id: 's3',
        operator: '$group',
        body: '{ _id: null, n: { $sum: 1 } }',
        enabled: true,
        previewOpen: true
      }
    ]
  })
  mocks.confirmations = 0
  mocks.aggregate.mockImplementation(async () => ({
    status: 'ok',
    documents: [{ _id: null, n: { $numberInt: '3' } }],
    truncated: false,
    durationMs: 2
  }))
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  useMongoWorkspaceStore.getState().reset()
})

describe('AggregationsView', () => {
  it('previews a card with the enabled stages up to it', async () => {
    render(<Harness />)
    await userEvent.click(screen.getByTestId('data-project-mongo-stage-2-preview-refresh'))
    await waitFor(() => expect(mocks.aggregate).toHaveBeenCalledTimes(1))
    const req = mocks.aggregate.mock.calls[0][0] as MongoAggregateRequest
    expect(req).toMatchObject({
      dataProjectId: 'dp-a',
      database: 'shop',
      collection: 'orders',
      stageIndex: 1,
      limit: 10
    })
    expect(req.pipeline).toContain('$match')
    expect(req.pipeline).toContain('$group')
    expect(req.pipeline).not.toContain('$limit')
    expect(
      await screen.findByTestId('data-project-mongo-stage-2-preview-summary')
    ).toHaveTextContent('Output after stage 2: 1 document')
    // A disabled card has no preview button.
    expect(screen.queryByTestId('data-project-mongo-stage-1-preview-refresh')).toBeNull()
  })

  it('runs a pipeline with $out through the confirmation', async () => {
    useMongoWorkspaceStore.getState().updateAggregation(project.id, tabId, (agg) => ({
      ...agg,
      stages: [
        ...agg.stages,
        { id: 's4', operator: '$out', body: "'totals'", enabled: true, previewOpen: false }
      ]
    }))
    mocks.aggregate
      .mockResolvedValueOnce({ status: 'confirmation_required', plan: {}, confirmToken: 'tok-9' })
      .mockResolvedValueOnce({ status: 'ok', documents: [], truncated: false, durationMs: 5 })
    render(<Harness />)
    expect(
      within(screen.getByTestId('data-project-mongo-stage-3')).getByText(/Writes the results to/)
    ).toBeInTheDocument()
    const run = screen.getByTestId('data-project-mongo-agg-run')
    expect(run).toHaveTextContent('Run (writes)')
    await userEvent.click(run)
    await waitFor(() => expect(mocks.aggregate).toHaveBeenCalledTimes(2))
    const first = mocks.aggregate.mock.calls[0][0] as MongoAggregateRequest
    const second = mocks.aggregate.mock.calls[1][0] as MongoAggregateRequest
    expect(first.stageIndex).toBeUndefined()
    expect(first.limit).toBe(20)
    expect(first.pipeline).toContain("$out: 'totals'")
    expect(second).toEqual({ ...first, confirmToken: 'tok-9' })
    expect(mocks.confirmations).toBe(1)
    expect(await screen.findByTestId('data-project-mongo-agg-summary')).toHaveTextContent(
      '0 documents'
    )
  })

  it('switches to text mode and back without losing disabled stages', async () => {
    render(<Harness />)
    await userEvent.click(screen.getByTestId('data-project-mongo-agg-mode-text'))
    const editor = screen.getByTestId('data-project-mongo-agg-text') as HTMLTextAreaElement
    expect(editor.value).toContain('// disabled: { $limit: 5 }')
    await userEvent.click(screen.getByTestId('data-project-mongo-agg-mode-stages'))
    const agg = (useMongoWorkspaceStore.getState().workspaces[project.id].tabs[0] as CollectionTab)
      .aggregation
    expect(agg.textMode).toBe(false)
    expect(agg.stages.map((s) => [s.operator, s.enabled])).toEqual([
      ['$match', true],
      ['$limit', false],
      ['$group', true]
    ])
  })

  it('stays in text mode with the error when the text does not parse', async () => {
    render(<Harness />)
    await userEvent.click(screen.getByTestId('data-project-mongo-agg-mode-text'))
    fireEvent.change(screen.getByTestId('data-project-mongo-agg-text'), {
      target: { value: '[ { $match: {} ' }
    })
    await userEvent.click(screen.getByTestId('data-project-mongo-agg-mode-stages'))
    expect(screen.getByTestId('data-project-mongo-agg-text-error')).toHaveTextContent('not closed')
    const agg = (useMongoWorkspaceStore.getState().workspaces[project.id].tabs[0] as CollectionTab)
      .aggregation
    expect(agg.textMode).toBe(true)
  })
})

describe('AggregationsView: create view and narrow panes', () => {
  it('creates a view from the enabled stages through the gate and opens it', async () => {
    mocks.execute
      .mockResolvedValueOnce({ status: 'confirmation_required', plan: {}, confirmToken: 'tok' })
      .mockResolvedValueOnce({
        status: 'ok',
        durationMs: 1,
        statements: [
          {
            index: 0,
            text: '',
            start: 0,
            end: 0,
            classification: 'ddl',
            durationMs: 1,
            output: { kind: 'command', message: 'ok' }
          }
        ]
      })
    render(<Harness />)
    await userEvent.click(screen.getByTestId('data-project-mongo-agg-create-view'))
    const name = await screen.findByTestId('data-project-mongo-agg-view-name')
    expect(name).toHaveValue('orders_view')
    fireEvent.change(name, { target: { value: 'a.b$' } })
    await userEvent.click(screen.getByTestId('data-project-mongo-agg-view-create'))
    expect(screen.getByTestId('data-project-mongo-agg-view-error')).toHaveTextContent(
      'cannot contain $'
    )
    expect(mocks.execute).not.toHaveBeenCalled()
    fireEvent.change(name, { target: { value: 'shipped_orders' } })
    await userEvent.click(screen.getByTestId('data-project-mongo-agg-view-create'))
    await waitFor(() => expect(mocks.execute).toHaveBeenCalledTimes(2))
    expect(mocks.confirmations).toBe(1)
    expect(mocks.execute.mock.calls[1][0]).toMatchObject({
      dataProjectId: 'dp-a',
      database: 'shop',
      source: 'mongo',
      confirmToken: 'tok',
      text:
        "db.createView('shipped_orders', 'orders', [\n  { $match: { status: 'A' } },\n" +
        '  { $group: { _id: null, n: { $sum: 1 } } }\n])'
    })
    await waitFor(() =>
      expect(screen.queryByTestId('data-project-mongo-agg-view-dialog')).toBeNull()
    )
    const ws = useMongoWorkspaceStore.getState().workspaces[project.id]
    expect(ws.tabs.find((t) => t.id === ws.activeTabId)).toMatchObject({
      kind: 'collection',
      database: 'shop',
      collection: 'shipped_orders',
      collectionType: 'view'
    })
  })

  it('shows the server error of a failed createView and keeps the dialog', async () => {
    mocks.execute.mockResolvedValueOnce({
      status: 'ok',
      durationMs: 1,
      statements: [
        {
          index: 0,
          text: '',
          start: 0,
          end: 0,
          classification: 'ddl',
          durationMs: 1,
          output: null,
          error: { message: 'Collection already exists. NS: shop.orders_view' }
        }
      ]
    })
    render(<Harness />)
    await userEvent.click(screen.getByTestId('data-project-mongo-agg-create-view'))
    await userEvent.click(await screen.findByTestId('data-project-mongo-agg-view-create'))
    expect(await screen.findByTestId('data-project-mongo-agg-view-error')).toHaveTextContent(
      'already exists'
    )
  })

  it('collapses toolbar labels in narrow panes and keeps Run labelled', () => {
    render(<Harness />)
    const toolbar = screen.getByTestId('data-project-mongo-agg-run').closest('.\\@container\\/agg')
    expect(toolbar).not.toBeNull()
    expect(toolbar!.className).toContain('flex-wrap')
    // Secondary labels sit in container-query spans; Run's does not.
    for (const id of ['data-project-mongo-agg-explain', 'data-project-mongo-agg-export']) {
      const label = within(screen.getByTestId(id)).getByText(/Explain|Export/)
      expect(label.className).toMatch(/hidden @\[\d+px\]\/agg:inline/)
    }
    expect(within(screen.getByTestId('data-project-mongo-agg-run')).getByText('Run').tagName).toBe(
      'BUTTON'
    )
  })
})
