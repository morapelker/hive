// Query tab run flow against a mocked RPC API (editor and virtualizer mocked): a plain run shows
// the rows and the status line; `confirmation_required` opens the confirm dialog and Run re-sends
// with the token; Cancel in the dialog declines; Cancel while running calls query.cancel and the
// cancelled outcome lands in Messages; an error position is underlined in the editor; the limit
// selector feeds the request and "Load all" re-runs without a limit.
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { forwardRef, useImperativeHandle } from 'react'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DataProject, DataQueryRequest, DataQueryResponse } from '@shared/data-projects/types'

const mocks = vi.hoisted(() => ({
  execute: vi.fn(),
  cancel: vi.fn(async () => ({ cancelled: true })),
  completionSchema: vi.fn(async () => ({ databases: ['shop'], tables: [] })),
  saveQuery: vi.fn(),
  editorProps: null as null | Record<string, unknown>,
  openCredentialsPrompt: vi.fn()
}))

vi.mock('@/api/data-projects-api', () => ({
  dataProjectsApi: {
    execute: mocks.execute,
    cancel: mocks.cancel,
    completionSchema: mocks.completionSchema,
    saveQuery: mocks.saveQuery,
    onExportProgress: () => () => undefined
  }
}))
vi.mock('@/stores/useDataProjectStore', () => ({
  useDataProjectStore: { getState: () => ({ openCredentialsPrompt: mocks.openCredentialsPrompt }) }
}))
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
// The CodeMirror editor is tested on its own; here a textarea with the same handle.
vi.mock('../editor/QueryEditor', () => ({
  QueryEditor: forwardRef(function MockEditor(props: Record<string, unknown>, ref) {
    mocks.editorProps = props
    const value = props.value as string
    useImperativeHandle(ref, () => ({
      focus: () => undefined,
      setText: () => undefined,
      insertText: () => undefined,
      getView: () => null,
      format: () => ({ changed: false, failed: 0 }),
      getRunTarget: () =>
        value.trim() ? { text: value, from: 0, to: value.length, mode: 'current' } : null
    }))
    return (
      <textarea
        data-testid="data-project-query-editor"
        value={value}
        onChange={(e) => (props.onChange as (v: string) => void)(e.target.value)}
      />
    )
  })
}))

const { useDataWorkspaceStore } = await import('@/stores/useDataWorkspaceStore')
const { QueryTab } = await import('./QueryTab')
const { DataConfirmHost } = await import('../shared/DataConfirmHost')
const { useDataConfirmStore } = await import('../shared/confirm')

const project: DataProject = {
  id: 'dp-1',
  name: 'Shop PG',
  engine: 'postgres',
  config: { host: '127.0.0.1', database: 'shop' },
  icon: null,
  iconColor: null,
  environment: 'production',
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

const okResponse = (text: string, truncated = false): DataQueryResponse => ({
  status: 'ok',
  durationMs: 12,
  database: 'shop',
  statements: [
    {
      index: 0,
      text,
      start: 0,
      end: text.length,
      classification: 'read',
      durationMs: 11,
      output: {
        kind: 'rows',
        columns: [
          { name: 'id', type: 'int4' },
          { name: 'email', type: 'text' }
        ],
        rows: [
          [1, 'a@x.io'],
          [2, null]
        ],
        truncated,
        limit: truncated ? 2 : null,
        autoLimited: truncated
      }
    }
  ]
})

function setup(text = 'SELECT id, email FROM users'): string {
  useDataWorkspaceStore.getState().ensureWorkspace(project.id, { database: 'shop' })
  const tabId = useDataWorkspaceStore.getState().workspaces[project.id].tabs[0].id
  useDataWorkspaceStore.getState().updateQueryText(project.id, tabId, text)
  return tabId
}

function Harness({ tabId }: { tabId: string }): React.JSX.Element {
  const tab = useDataWorkspaceStore((s) =>
    s.workspaces[project.id].tabs.find((t) => t.id === tabId)
  )
  if (!tab || tab.kind !== 'query') return <div />
  return (
    <>
      <QueryTab
        project={project}
        tab={tab}
        active
        dialect="postgres"
        databases={[{ name: 'shop' }]}
      />
      <DataConfirmHost />
    </>
  )
}

beforeAll(() => {
  Element.prototype.hasPointerCapture ??= () => false
  Element.prototype.releasePointerCapture ??= () => undefined
  Element.prototype.scrollIntoView ??= () => undefined
})
beforeEach(() => {
  useDataWorkspaceStore.getState().reset()
  mocks.execute.mockReset()
  mocks.cancel.mockClear()
})
afterEach(() => {
  useDataConfirmStore.getState().cancelAll()
  cleanup()
})

describe('QueryTab run flow', () => {
  it('runs and shows the rows with the status line', async () => {
    const tabId = setup()
    mocks.execute.mockImplementation(async (req: DataQueryRequest) => okResponse(req.text))
    render(<Harness tabId={tabId} />)
    await act(async () => {
      fireEvent.click(screen.getByTestId('data-project-run'))
    })
    await screen.findByTestId('data-project-result-grid')
    const req = mocks.execute.mock.calls[0][0] as DataQueryRequest
    expect(req).toMatchObject({
      dataProjectId: 'dp-1',
      text: 'SELECT id, email FROM users',
      database: 'shop',
      limit: 1000,
      source: 'editor',
      stopOnError: true
    })
    expect(req.confirmToken).toBeUndefined()
    expect(screen.getByTestId('data-project-status-rows')).toHaveTextContent('2 rows')
    expect(useDataWorkspaceStore.getState().historyVersion[project.id]).toBe(1)
  })

  it('asks for confirmation and re-sends with the token', async () => {
    const tabId = setup('DELETE FROM orders WHERE id = 1')
    mocks.execute
      .mockResolvedValueOnce({
        status: 'confirmation_required',
        confirmToken: 'tok-1',
        plan: {
          dataProjectId: 'dp-1',
          projectName: 'Shop PG',
          engine: 'postgres',
          environment: 'production',
          safeMode: 'half-safe',
          database: 'shop',
          statements: [
            {
              index: 0,
              text: 'DELETE FROM orders WHERE id = 1',
              start: 0,
              end: 31,
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
        durationMs: 3,
        statements: [
          {
            index: 0,
            text: 'DELETE FROM orders WHERE id = 1',
            start: 0,
            end: 31,
            classification: 'write',
            durationMs: 2,
            output: { kind: 'command', affectedRows: 1, message: 'DELETE' }
          }
        ]
      })
    render(<Harness tabId={tabId} />)
    await act(async () => {
      fireEvent.click(screen.getByTestId('data-project-run'))
    })
    await screen.findByTestId('data-project-confirm-dialog')
    expect(screen.getByTestId('data-project-running')).toHaveTextContent('Waiting for confirmation')
    await act(async () => {
      fireEvent.click(screen.getByTestId('data-project-confirm-run'))
    })
    await waitFor(() => expect(mocks.execute).toHaveBeenCalledTimes(2))
    expect((mocks.execute.mock.calls[1][0] as DataQueryRequest).confirmToken).toBe('tok-1')
    expect(await screen.findByTestId('data-project-messages')).toHaveTextContent(
      'DELETE · 1 row affected'
    )
  })

  it('records a declined confirmation without running again', async () => {
    const tabId = setup('DROP TABLE t')
    mocks.execute.mockResolvedValueOnce({
      status: 'confirmation_required',
      confirmToken: 't',
      plan: {
        dataProjectId: 'dp-1',
        projectName: 'Shop PG',
        engine: 'postgres',
        environment: 'production',
        safeMode: 'half-safe',
        statements: [
          {
            index: 0,
            text: 'DROP TABLE t',
            start: 0,
            end: 12,
            classification: 'ddl',
            dangerous: ['DROP TABLE'],
            reasons: ['ddl'],
            needsConfirmation: true
          }
        ],
        typedConfirmation: 't'
      }
    })
    render(<Harness tabId={tabId} />)
    await act(async () => {
      fireEvent.click(screen.getByTestId('data-project-run'))
    })
    await act(async () => {
      fireEvent.click(await screen.findByTestId('data-project-confirm-cancel'))
    })
    expect(await screen.findByTestId('data-project-messages-declined')).toBeInTheDocument()
    expect(mocks.execute).toHaveBeenCalledTimes(1)
  })

  it('cancels a running query', async () => {
    const tabId = setup('SELECT pg_sleep(60)')
    let resolve: (r: DataQueryResponse) => void = () => undefined
    mocks.execute.mockImplementation(() => new Promise<DataQueryResponse>((r) => (resolve = r)))
    render(<Harness tabId={tabId} />)
    await act(async () => {
      fireEvent.click(screen.getByTestId('data-project-run'))
    })
    expect(await screen.findByTestId('data-project-running')).toHaveTextContent('Running')
    const queryId = (mocks.execute.mock.calls[0][0] as DataQueryRequest).queryId
    await act(async () => {
      fireEvent.click(screen.getByTestId('data-project-cancel'))
    })
    expect(mocks.cancel).toHaveBeenCalledWith(queryId)
    await act(async () => {
      resolve({ status: 'cancelled', statements: [], durationMs: 900 })
    })
    expect(await screen.findByTestId('data-project-messages-cancelled')).toBeInTheDocument()
    expect(screen.queryByTestId('data-project-running')).toBeNull()
  })

  it('underlines the error position in the editor', async () => {
    const tabId = setup('SELECT nope FROM users')
    mocks.execute.mockResolvedValueOnce({
      status: 'ok',
      durationMs: 2,
      statements: [
        {
          index: 0,
          text: 'SELECT nope FROM users',
          start: 0,
          end: 22,
          classification: 'read',
          durationMs: 1,
          output: null,
          error: { message: 'column "nope" does not exist', code: '42703', position: 7 }
        }
      ]
    })
    render(<Harness tabId={tabId} />)
    await act(async () => {
      fireEvent.click(screen.getByTestId('data-project-run'))
    })
    await screen.findByTestId('data-project-messages')
    expect(screen.getByTestId('data-project-message-error-0')).toHaveTextContent(
      '[42703] column "nope" does not exist'
    )
    await waitFor(() =>
      expect(mocks.editorProps?.errorRange).toMatchObject({
        from: 7,
        to: 11,
        message: 'column "nope" does not exist'
      })
    )
  })

  it('uses the limit selector and re-runs without a limit from "Load all"', async () => {
    const tabId = setup('SELECT * FROM big')
    mocks.execute.mockImplementation(async (req: DataQueryRequest) =>
      okResponse(req.text, req.limit !== null)
    )
    render(<Harness tabId={tabId} />)
    fireEvent.change(screen.getByTestId('data-project-limit-select'), { target: { value: '500' } })
    await act(async () => {
      fireEvent.click(screen.getByTestId('data-project-run'))
    })
    expect((mocks.execute.mock.calls[0][0] as DataQueryRequest).limit).toBe(500)
    expect(await screen.findByTestId('data-project-truncated')).toHaveTextContent('Limited to 2')
    await act(async () => {
      fireEvent.click(screen.getByTestId('data-project-load-all'))
    })
    await waitFor(() => expect(mocks.execute).toHaveBeenCalledTimes(2))
    expect((mocks.execute.mock.calls[1][0] as DataQueryRequest).limit).toBeNull()
    await waitFor(() => expect(screen.queryByTestId('data-project-truncated')).toBeNull())
  })
})
