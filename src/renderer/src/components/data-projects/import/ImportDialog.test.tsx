// Import dialog: pick (path or native panel) → preview with detected options → mapping → Import
// through runWithConfirmation (token round trip) → progress with Cancel → clean close with a
// toast, or a report of the failing rows. Read-only mode keeps Import disabled.
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  DataImportPreviewResponse,
  DataImportProgressEvent,
  DataImportResponse,
  DataImportStartRequest
} from '@shared/data-projects/import-types'
import type { DataProject } from '@shared/data-projects/types'

const mocks = vi.hoisted(() => ({
  preview: vi.fn(),
  start: vi.fn(),
  cancel: vi.fn(async () => ({ cancelled: true })),
  progress: [] as Array<(event: DataImportProgressEvent) => void>,
  toastSuccess: vi.fn(),
  bumpHistory: vi.fn(),
  notifyTableDataChanged: vi.fn()
}))

vi.mock('@/api/data-projects-api', () => ({
  dataProjectsApi: {
    import: {
      preview: mocks.preview,
      start: mocks.start,
      cancel: mocks.cancel,
      onProgress: (cb: (event: DataImportProgressEvent) => void) => {
        mocks.progress.push(cb)
        return () => {
          mocks.progress = mocks.progress.filter((c) => c !== cb)
        }
      }
    }
  }
}))
vi.mock('@/lib/toast', () => ({
  toast: { success: mocks.toastSuccess, error: vi.fn(), warning: vi.fn(), info: vi.fn() }
}))
vi.mock('@/stores/useDataProjectStore', () => {
  const state = { openCredentialsPrompt: vi.fn() }
  const hook = (selector: (s: typeof state) => unknown) => selector(state)
  hook.getState = () => state
  return { useDataProjectStore: hook }
})
vi.mock('@/stores/useDataWorkspaceStore', () => {
  const state = {
    bumpHistory: mocks.bumpHistory,
    notifyTableDataChanged: mocks.notifyTableDataChanged
  }
  const hook = (selector: (s: typeof state) => unknown) => selector(state)
  hook.getState = () => state
  return { useDataWorkspaceStore: hook }
})
// The real flow: re-call with the token when the server asks (the dialog itself is tested
// in DataConfirmHost.test.tsx).
vi.mock('@/components/data-projects/shared/confirm', () => ({
  runWithConfirmation: async (call: (token?: string) => Promise<{ status: string }>) => {
    const first = await call()
    return first.status === 'confirmation_required' ? call('tok-1') : first
  }
}))

const { ImportDialog } = await import('./ImportDialog')

const sqlProject = {
  id: 'dp-sql',
  name: 'Shop',
  engine: 'postgres',
  config: { database: 'shop' },
  safeMode: 'half-safe',
  environment: 'development'
} as unknown as DataProject
const mongoProject = { ...sqlProject, id: 'dp-mongo', engine: 'mongodb' } as DataProject

const sqlPreview: DataImportPreviewResponse = {
  fileName: 'orders.csv',
  fileSize: 2048,
  format: 'csv',
  encoding: 'utf-8',
  csv: { delimiter: ';', quote: '"', header: true },
  detected: {
    format: 'csv',
    encoding: 'utf-8',
    csv: { delimiter: ';', quote: '"', header: true }
  },
  columns: ['ID', 'Status', 'notes'],
  rows: [
    ['1', 'paid', null],
    ['2', 'new', '']
  ],
  lines: [2, 3],
  more: true,
  tableColumns: [
    { name: 'id', type: 'integer', nullable: false, isPrimaryKey: true, ordinal: 1 },
    { name: 'status', type: 'text', nullable: true, isPrimaryKey: false, ordinal: 2 }
  ],
  supportsTransaction: true,
  warnings: []
}

const finished = (extra: Partial<DataImportResponse> = {}): DataImportResponse =>
  ({
    status: 'ok',
    rowsRead: 2,
    rowsImported: 2,
    rowsSkipped: 0,
    errorCount: 0,
    errors: [],
    durationMs: 5,
    rolledBack: false,
    ...extra
  }) as DataImportResponse

const openWithPath = async (path = '/Users/me/orders.csv'): Promise<void> => {
  fireEvent.change(screen.getByTestId('data-project-import-path'), { target: { value: path } })
  fireEvent.click(screen.getByTestId('data-project-import-path-open'))
  await screen.findByTestId('data-project-import-preview')
}

beforeEach(() => {
  mocks.preview.mockResolvedValue(sqlPreview)
  mocks.start.mockResolvedValue(finished())
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  mocks.start.mockReset()
  mocks.preview.mockReset()
  mocks.progress = []
  delete (window as { desktopBridge?: unknown }).desktopBridge
})

describe('ImportDialog (SQL table)', () => {
  const target = {
    kind: 'table' as const,
    ref: { name: 'orders', schema: 'public', database: 'shop' }
  }

  it('previews, maps by name, confirms and closes with a toast', async () => {
    const onClose = vi.fn()
    const onImported = vi.fn()
    mocks.start
      .mockResolvedValueOnce({ status: 'confirmation_required', plan: {}, confirmToken: 'tok-1' })
      .mockResolvedValueOnce(finished())
    render(
      <ImportDialog
        project={sqlProject}
        target={target}
        onClose={onClose}
        onImported={onImported}
        onOpenTarget={vi.fn()}
      />
    )
    expect(screen.getByText('Import into public.orders')).toBeTruthy()
    await openWithPath()
    expect(mocks.preview).toHaveBeenCalledWith(
      expect.objectContaining({ dataProjectId: 'dp-sql', filePath: '/Users/me/orders.csv', target })
    )
    // Detected values are marked; columns map by name; notes has no table column.
    expect((screen.getByTestId('data-project-import-delimiter') as HTMLSelectElement).value).toBe(
      ';'
    )
    expect(screen.getByRole('option', { name: /^Semicolon ; \(detected\)$/ })).toBeTruthy()
    expect((screen.getByTestId('data-project-import-map-0') as HTMLSelectElement).value).toBe('id')
    expect((screen.getByTestId('data-project-import-map-1') as HTMLSelectElement).value).toBe(
      'status'
    )
    expect((screen.getByTestId('data-project-import-map-2') as HTMLSelectElement).value).toBe('')
    // NULL vs the empty string in the preview.
    const preview = screen.getByTestId('data-project-import-preview')
    expect(within(preview).getByText('NULL')).toBeTruthy()
    expect(within(preview).getByText('""')).toBeTruthy()

    fireEvent.click(screen.getByTestId('data-project-import-submit'))
    await waitFor(() => expect(onClose).toHaveBeenCalled())
    expect(mocks.start).toHaveBeenCalledTimes(2)
    const first = mocks.start.mock.calls[0][0] as DataImportStartRequest
    expect(first).toMatchObject({
      dataProjectId: 'dp-sql',
      filePath: '/Users/me/orders.csv',
      target,
      format: 'csv',
      encoding: 'utf-8',
      csv: { delimiter: ';', quote: '"', header: true },
      columns: [
        { source: 0, target: 'id' },
        { source: 1, target: 'status' }
      ],
      empty: 'null',
      onError: 'rollback'
    })
    expect(first.confirmToken).toBeUndefined()
    expect(mocks.start.mock.calls[1][0]).toMatchObject({
      confirmToken: 'tok-1',
      importId: first.importId
    })
    expect(mocks.toastSuccess).toHaveBeenCalledWith(
      'Imported 2 rows from orders.csv into public.orders',
      expect.objectContaining({ action: expect.objectContaining({ label: 'Open' }) })
    )
    expect(onImported).toHaveBeenCalled()
    expect(mocks.bumpHistory).toHaveBeenCalledWith('dp-sql')
    expect(mocks.notifyTableDataChanged).toHaveBeenCalledWith('dp-sql')
  })

  it('re-reads the file when an option changes', async () => {
    render(<ImportDialog project={sqlProject} target={target} onClose={vi.fn()} />)
    await openWithPath()
    fireEvent.change(screen.getByTestId('data-project-import-delimiter'), {
      target: { value: ',' }
    })
    await waitFor(() =>
      expect(mocks.preview).toHaveBeenLastCalledWith(
        expect.objectContaining({ csv: { delimiter: ',' } })
      )
    )
    fireEvent.click(screen.getByTestId('data-project-import-header'))
    await waitFor(() =>
      expect(mocks.preview).toHaveBeenLastCalledWith(
        expect.objectContaining({ csv: { delimiter: ',', header: false } })
      )
    )
  })

  it('keeps Import disabled for errors and in read-only mode', async () => {
    const { unmount } = render(
      <ImportDialog
        project={{ ...sqlProject, safeMode: 'read-only' }}
        target={target}
        onClose={vi.fn()}
      />
    )
    await openWithPath()
    expect(screen.getByTestId('data-project-import-issues').textContent).toContain('Read-only mode')
    expect((screen.getByTestId('data-project-import-submit') as HTMLButtonElement).disabled).toBe(
      true
    )
    unmount()

    render(<ImportDialog project={sqlProject} target={target} onClose={vi.fn()} />)
    await openWithPath()
    fireEvent.change(screen.getByTestId('data-project-import-map-2'), {
      target: { value: 'status' }
    })
    expect(screen.getByTestId('data-project-import-issues').textContent).toContain(
      '"status" is mapped from more than one file column.'
    )
    expect((screen.getByTestId('data-project-import-submit') as HTMLButtonElement).disabled).toBe(
      true
    )
  })

  it('shows progress with Cancel, then a report of the failing rows', async () => {
    let resolve!: (r: DataImportResponse) => void
    mocks.start.mockImplementation(
      () =>
        new Promise<DataImportResponse>((r) => {
          resolve = r
        })
    )
    render(<ImportDialog project={sqlProject} target={target} onClose={vi.fn()} />)
    await openWithPath()
    fireEvent.click(screen.getByTestId('data-project-import-submit'))
    await screen.findByTestId('data-project-import-progress')
    const importId = (mocks.start.mock.calls[0][0] as DataImportStartRequest).importId
    act(() => {
      for (const cb of mocks.progress)
        cb({
          importId,
          phase: 'importing',
          bytesRead: 10,
          totalBytes: 20,
          rowsRead: 6,
          rowsImported: 5,
          totalRows: 10,
          done: false
        })
    })
    expect(screen.getByTestId('data-project-import-progress').textContent).toContain(
      'Importing… 5 of 10 rows'
    )
    expect(screen.getByTestId('data-project-import-progress').textContent).toContain('50%')
    fireEvent.click(screen.getByTestId('data-project-import-cancel-run'))
    expect(mocks.cancel).toHaveBeenCalledWith(importId)
    // SQL interrupts the statement at once; the button stays (a second click is harmless).
    expect(screen.getByTestId('data-project-import-progress').textContent).toContain('Stopping…')
    expect(screen.getByTestId('data-project-import-cancel-run').textContent).toBe('Cancel import')

    await act(async () => {
      resolve(
        finished({
          status: 'failed',
          message: 'Stopped at Row 7 (line 8): bad value. 6 rows were imported before it.',
          rowsImported: 6,
          errorCount: 1,
          errors: [{ row: 7, line: 8, message: 'bad value' }]
        } as Partial<DataImportResponse>)
      )
    })
    const result = await screen.findByTestId('data-project-import-result')
    expect(result.textContent).toContain('Stopped at Row 7 (line 8)')
    expect(screen.getByTestId('data-project-import-errors').textContent).toContain('7 (line 8)')
    fireEvent.click(screen.getByTestId('data-project-import-back'))
    expect(screen.getByTestId('data-project-import-submit')).toBeTruthy()
  })

  it('takes the file from the native open panel and closes when that first panel is dismissed', async () => {
    ;(window as { desktopBridge?: unknown }).desktopBridge = {
      getPathForFile: () => '/Users/me/picked.csv'
    }
    const click = vi.spyOn(HTMLInputElement.prototype, 'click').mockImplementation(() => undefined)
    const onClose = vi.fn()
    const { unmount } = render(
      <ImportDialog project={sqlProject} target={target} onClose={onClose} />
    )
    await waitFor(() => expect(click).toHaveBeenCalled())
    const input = screen.getByTestId('data-project-import-file-input') as HTMLInputElement
    expect(input.accept).toContain('.csv')
    fireEvent(input, new Event('cancel'))
    expect(onClose).toHaveBeenCalledTimes(1)
    unmount()

    render(<ImportDialog project={sqlProject} target={target} onClose={onClose} />)
    const second = screen.getByTestId('data-project-import-file-input') as HTMLInputElement
    const file = new File(['id\n1\n'], 'picked.csv', { type: 'text/csv' })
    fireEvent.change(second, { target: { files: [file] } })
    await screen.findByTestId('data-project-import-preview')
    expect(mocks.preview).toHaveBeenCalledWith(
      expect.objectContaining({ filePath: '/Users/me/picked.csv' })
    )
    click.mockRestore()
  })
})

describe('ImportDialog (Mongo collection)', () => {
  const target = { kind: 'collection' as const, database: 'shop', collection: 'users' }
  const mongoPreview: DataImportPreviewResponse = {
    ...sqlPreview,
    fileName: 'users.csv',
    csv: { delimiter: ',', quote: '"', header: true },
    detected: {
      format: 'csv',
      encoding: 'utf-8',
      csv: { delimiter: ',', quote: '"', header: true }
    },
    columns: ['name', 'age', 'address.city'],
    rows: [['Ann', '31', 'Paris']],
    lines: [2],
    more: false,
    inferredTypes: ['string', 'number', 'string'],
    tableColumns: undefined,
    supportsTransaction: false,
    transactionNote: 'MongoDB imports run in batches without a transaction.'
  }

  it('edits field names and types, toggles type detection, and sends them', async () => {
    mocks.preview.mockResolvedValue(mongoPreview)
    render(<ImportDialog project={mongoProject} target={target} onClose={vi.fn()} />)
    await openWithPath('/Users/me/users.csv')
    expect(
      (screen.getByTestId('data-project-import-field-type-1') as HTMLSelectElement).value
    ).toBe('number')
    expect((screen.getByTestId('data-project-import-on-error') as HTMLSelectElement).value).toBe(
      'stop'
    )
    expect(screen.getByRole('option', { name: /All or nothing.*not available/ })).toHaveProperty(
      'disabled',
      true
    )
    fireEvent.click(screen.getByTestId('data-project-import-detect-types'))
    expect(
      (screen.getByTestId('data-project-import-field-type-1') as HTMLSelectElement).value
    ).toBe('string')
    fireEvent.change(screen.getByTestId('data-project-import-field-type-1'), {
      target: { value: 'int32' }
    })
    fireEvent.change(screen.getByTestId('data-project-import-field-name-0'), {
      target: { value: 'address' }
    })
    expect(screen.getByTestId('data-project-import-issues').textContent).toContain(
      '"address" cannot hold a value and "address.city" at once.'
    )
    fireEvent.change(screen.getByTestId('data-project-import-field-name-0'), {
      target: { value: 'fullName' }
    })
    fireEvent.click(screen.getByTestId('data-project-import-field-include-2'))
    fireEvent.click(screen.getByTestId('data-project-import-submit'))
    await waitFor(() => expect(mocks.start).toHaveBeenCalled())
    expect(mocks.start.mock.calls[0][0]).toMatchObject({
      target,
      format: 'csv',
      empty: 'omit',
      onError: 'stop',
      columns: [
        { source: 0, target: 'fullName', type: 'string' },
        { source: 1, target: 'age', type: 'int32' }
      ]
    })
  })
})
