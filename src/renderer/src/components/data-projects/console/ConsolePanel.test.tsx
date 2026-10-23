// The Console tab: lists the server's log, follows the live channel (entries, clears, a new
// server epoch), lists again every renewal while mounted (the server's watch lease), hides
// metadata behind its toggle, filters, opens statements in an editor tab (never runs them;
// never masked ones), copies, clears; and the console tab kind of both workspace stores.
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DataConsoleEntry, DataConsoleEvent } from '@shared/data-projects/console-types'

const mocks = vi.hoisted(() => ({
  list: vi.fn(),
  clear: vi.fn(async () => ({ success: true })),
  listener: null as ((event: DataConsoleEvent) => void) | null,
  unsubscribe: vi.fn(),
  copy: vi.fn(async (_text: string) => true)
}))

vi.mock('@/api/data-console-api', () => ({
  dataConsoleApi: {
    list: mocks.list,
    clear: mocks.clear,
    onEvent: (cb: (event: DataConsoleEvent) => void) => {
      mocks.listener = cb
      return mocks.unsubscribe
    }
  }
}))
vi.mock('@/api/data-projects-api', () => ({
  dataProjectsApi: { completionSchema: vi.fn(async () => ({ databases: [], tables: [] })) }
}))
vi.mock('@/lib/clipboard', () => ({ copyTextToClipboard: mocks.copy }))
vi.mock('@/lib/toast', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

const { ConsolePanel } = await import('./ConsolePanel')
const { useDataConsoleStore, mergeConsoleEntries, CONSOLE_RENEW_MS } =
  await import('./console-store')
const { useDataWorkspaceStore } = await import('@/stores/useDataWorkspaceStore')
const { useMongoWorkspaceStore } = await import('@/stores/useMongoWorkspaceStore')

const P = 'dp-1'
let seq = 0
const entry = (overrides: Partial<DataConsoleEntry> = {}): DataConsoleEntry => ({
  seq: ++seq,
  dataProjectId: P,
  at: new Date(2026, 0, 1, 10, 0, 0, seq).toISOString(),
  source: 'query',
  language: 'sql',
  database: 'shop',
  text: `SELECT ${seq}`,
  status: 'ok',
  durationMs: 1,
  rows: 1,
  affected: null,
  error: null,
  ...overrides
})

const shown = (): string[] =>
  screen
    .queryAllByTestId(/^data-project-console-entry-/)
    .map((row) => row.querySelector('pre')?.textContent ?? '')

beforeEach(() => {
  seq = 0
  localStorage.clear()
  useDataConsoleStore.getState().reset()
  mocks.list.mockReset()
  mocks.listener = null
})
afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

async function renderPanel(entries: DataConsoleEntry[], onOpen = vi.fn()) {
  mocks.list.mockResolvedValue({ entries, epoch: 'e1' })
  const view = render(<ConsolePanel projectId={P} dialect="postgres" onOpen={onOpen} />)
  await screen.findByTestId('data-project-console')
  await act(async () => {})
  return { ...view, onOpen }
}

describe('ConsolePanel', () => {
  it('lists the log, hides metadata until asked, and follows live events', async () => {
    const meta = entry({ source: 'metadata', text: 'SET search_path TO public' })
    const q = entry({ text: 'SELECT * FROM users' })
    const { unmount } = await renderPanel([meta, q])
    expect(mocks.list).toHaveBeenCalledWith(P)
    expect(shown()).toEqual(['SELECT * FROM users'])
    fireEvent.click(screen.getByTestId('data-project-console-metadata'))
    expect(shown()).toEqual(['SET search_path TO public', 'SELECT * FROM users'])
    // The choice is remembered.
    expect(localStorage.getItem('hive:data-console:show-metadata')).toBe('1')

    act(() =>
      mocks.listener!({
        dataProjectId: P,
        epoch: 'e1',
        kind: 'entries',
        entries: [entry({ source: 'table', text: 'SELECT COUNT(*) FROM users' })]
      })
    )
    expect(shown().at(-1)).toBe('SELECT COUNT(*) FROM users')
    // Another project's entries are not ours.
    act(() =>
      mocks.listener!({
        dataProjectId: 'other',
        epoch: 'e1',
        kind: 'entries',
        entries: [entry({ dataProjectId: 'other', text: 'SELECT 99' })]
      })
    )
    expect(shown()).not.toContain('SELECT 99')
    act(() => mocks.listener!({ dataProjectId: P, epoch: 'e1', kind: 'cleared' }))
    expect(shown()).toEqual([])
    expect(screen.getByTestId('data-project-console-empty')).toHaveTextContent('No statements yet')
    unmount()
    expect(mocks.unsubscribe).toHaveBeenCalled()
  })

  it('starts over when the server restarted (new epoch)', async () => {
    await renderPanel([entry({ text: 'SELECT old' })])
    mocks.list.mockResolvedValue({ entries: [entry({ seq: 1, text: 'SELECT new' })], epoch: 'e2' })
    await act(async () =>
      mocks.listener!({
        dataProjectId: P,
        epoch: 'e2',
        kind: 'entries',
        entries: [entry({ seq: 2, text: 'SELECT live' })]
      })
    )
    expect(shown()).toEqual(['SELECT new', 'SELECT live'])
  })

  it('filters by text, source and errors', async () => {
    await renderPanel([
      entry({ text: 'SELECT * FROM users' }),
      entry({
        source: 'edit',
        text: 'UPDATE users SET a = 1 WHERE id = 2',
        rows: null,
        affected: 1
      }),
      entry({
        text: 'SELECT * FROM nope',
        status: 'error',
        error: 'relation "nope" does not exist'
      })
    ])
    expect(screen.getByTestId('data-project-console-count')).toHaveTextContent('3 of 3')
    fireEvent.change(screen.getByTestId('data-project-console-source'), {
      target: { value: 'edit' }
    })
    expect(shown()).toEqual(['UPDATE users SET a = 1 WHERE id = 2'])
    fireEvent.change(screen.getByTestId('data-project-console-source'), {
      target: { value: 'all' }
    })
    fireEvent.click(screen.getByTestId('data-project-console-errors'))
    expect(shown()).toEqual(['SELECT * FROM nope'])
    expect(screen.getByText('relation "nope" does not exist')).toBeInTheDocument()
    fireEvent.click(screen.getByTestId('data-project-console-errors'))
    fireEvent.change(screen.getByTestId('data-project-console-filter'), {
      target: { value: 'users' }
    })
    await act(() => new Promise((r) => setTimeout(r, 200)))
    expect(shown()).toEqual(['SELECT * FROM users', 'UPDATE users SET a = 1 WHERE id = 2'])
    fireEvent.change(screen.getByTestId('data-project-console-filter'), {
      target: { value: 'zzz' }
    })
    await act(() => new Promise((r) => setTimeout(r, 200)))
    expect(screen.getByTestId('data-project-console-empty')).toHaveTextContent(
      'No matching statements'
    )
  })

  it('opens whole statements in an editor tab, never summaries or cut texts', async () => {
    const q = entry({ text: 'SELECT * FROM users', database: 'shop' })
    const summary = entry({ source: 'admin', text: '-- kill query 42', summary: true })
    const cut = entry({ text: 'INSERT INTO t VALUES (1)', truncated: true })
    const { onOpen } = await renderPanel([q, summary, cut])
    fireEvent.click(screen.getByTestId(`data-project-console-open-${q.seq}`))
    expect(onOpen).toHaveBeenCalledWith('SELECT * FROM users', 'shop')
    expect(screen.getByTestId(`data-project-console-open-${summary.seq}`)).toBeDisabled()
    expect(screen.getByTestId(`data-project-console-open-${cut.seq}`)).toBeDisabled()
    fireEvent.doubleClick(screen.getByTestId(`data-project-console-entry-${summary.seq}`))
    expect(onOpen).toHaveBeenCalledTimes(1)

    // Keyboard: ↑ from nothing selects the newest, Enter opens it (when it can be opened).
    const list = screen.getByTestId('data-project-console-list')
    fireEvent.keyDown(list, { key: 'ArrowUp' })
    fireEvent.keyDown(list, { key: 'ArrowUp' })
    fireEvent.keyDown(list, { key: 'ArrowUp' })
    expect(screen.getByTestId(`data-project-console-entry-${q.seq}`)).toHaveAttribute(
      'aria-selected',
      'true'
    )
    fireEvent.keyDown(list, { key: 'Enter' })
    expect(onOpen).toHaveBeenCalledTimes(2)
    fireEvent.keyDown(list, { key: 'c', metaKey: true })
    await act(async () => {})
    expect(mocks.copy).toHaveBeenLastCalledWith('SELECT * FROM users')
  })

  it('marks entries whose secrets were masked and never opens them', async () => {
    const masked = {
      ...entry({ source: 'edit', text: `UPDATE "users" SET "password" = '***' WHERE "id" = 7` }),
      masked: true
    }
    const plain = entry({ text: 'SELECT 1' })
    const { onOpen } = await renderPanel([masked, plain])
    expect(screen.getByTestId(`data-project-console-masked-${masked.seq}`)).toHaveTextContent(
      'masked'
    )
    expect(screen.queryByTestId(`data-project-console-masked-${plain.seq}`)).toBeNull()
    const open = screen.getByTestId(`data-project-console-open-${masked.seq}`)
    expect(open).toBeDisabled()
    expect(open).toHaveAttribute('title', expect.stringMatching(/masked/))
    fireEvent.doubleClick(screen.getByTestId(`data-project-console-entry-${masked.seq}`))
    const list = screen.getByTestId('data-project-console-list')
    fireEvent.click(screen.getByTestId(`data-project-console-entry-${masked.seq}`))
    fireEvent.keyDown(list, { key: 'Enter' })
    expect(onOpen).not.toHaveBeenCalled()
    // Copy still works (the text says what ran, minus the secret)
    fireEvent.click(screen.getByTestId(`data-project-console-copy-${masked.seq}`))
    await act(async () => {})
    expect(mocks.copy).toHaveBeenLastCalledWith(masked.text)
  })

  it('lists the newer entries every renewal while mounted (the server’s watch), not after', async () => {
    vi.useFakeTimers()
    try {
      const first = entry()
      mocks.list.mockResolvedValue({ entries: [first], epoch: 'e1' })
      const view = render(<ConsolePanel projectId={P} dialect="postgres" onOpen={vi.fn()} />)
      await act(async () => {})
      expect(mocks.list).toHaveBeenCalledTimes(1)
      const later = entry({ text: 'SELECT missed' })
      mocks.list.mockResolvedValue({ entries: [later], epoch: 'e1' })
      await act(async () => {
        await vi.advanceTimersByTimeAsync(CONSOLE_RENEW_MS)
      })
      expect(mocks.list).toHaveBeenLastCalledWith(P, first.seq)
      expect(shown()).toEqual(['SELECT 1', 'SELECT missed'])
      view.unmount()
      await act(async () => {
        await vi.advanceTimersByTimeAsync(CONSOLE_RENEW_MS * 3)
      })
      expect(mocks.list).toHaveBeenCalledTimes(2)
      expect(mocks.unsubscribe).toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('copies one entry or every visible one, and clears the server log', async () => {
    const a = entry({ text: 'SELECT 1' })
    const b = entry({ text: 'SELECT 2', rows: 2 })
    await renderPanel([a, b])
    fireEvent.click(screen.getByTestId(`data-project-console-copy-${b.seq}`))
    await act(async () => {})
    expect(mocks.copy).toHaveBeenLastCalledWith('SELECT 2')
    fireEvent.click(screen.getByTestId('data-project-console-copy-all'))
    await act(async () => {})
    const all = mocks.copy.mock.calls.at(-1)![0]
    expect(all).toMatch(
      /^-- .* · Query · shop · 1 ms · 1 row\nSELECT 1;\n\n-- .* · 2 rows\nSELECT 2;$/
    )
    await act(async () => fireEvent.click(screen.getByTestId('data-project-console-clear')))
    expect(mocks.clear).toHaveBeenCalledWith(P)
    expect(shown()).toEqual([])
  })

  it('expands long statements and offers to show hidden metadata when nothing else is there', async () => {
    const long = entry({ text: `SELECT\n  a,\n  b,\n  c,\n  d\nFROM t` })
    await renderPanel([long])
    const row = screen.getByTestId(`data-project-console-entry-${long.seq}`)
    expect(within(row).getByRole('button', { name: 'Expand' })).toBeInTheDocument()
    fireEvent.click(screen.getByTestId(`data-project-console-expand-${long.seq}`))
    expect(within(row).getByRole('button', { name: 'Collapse' })).toBeInTheDocument()
    cleanup()
    useDataConsoleStore.getState().reset()
    await renderPanel([entry({ source: 'metadata', text: 'SELECT version()' })])
    fireEvent.click(screen.getByTestId('data-project-console-show-metadata'))
    expect(shown()).toEqual(['SELECT version()'])
  })
})

describe('mergeConsoleEntries', () => {
  it('dedupes by seq, orders, and caps each kind like the server', () => {
    const e = (n: number, source: DataConsoleEntry['source'] = 'query') =>
      ({ seq: n, source }) as DataConsoleEntry
    expect(mergeConsoleEntries([e(1), e(3)], [e(2), e(3)]).map((x) => x.seq)).toEqual([1, 2, 3])
    const merged = mergeConsoleEntries(
      [e(1), e(2, 'metadata'), e(3), e(4, 'metadata')],
      [e(5), e(6, 'metadata')],
      2
    )
    expect(merged.map((x) => x.seq)).toEqual([3, 4, 5, 6])
  })
})

describe('the Console tab of the workspaces', () => {
  it('is a singleton special tab in the SQL workspace and survives a restart', async () => {
    const store = useDataWorkspaceStore.getState()
    store.reset()
    const id = store.openSpecialTab(P, 'console')
    expect(store.openSpecialTab(P, 'console')).toBe(id)
    const ws = useDataWorkspaceStore.getState().workspaces[P]
    expect(ws.tabs).toEqual([{ id, kind: 'console', title: 'Console' }])
    localStorage.setItem(
      'hive-data-workspace',
      JSON.stringify({
        version: 1,
        state: {
          workspaces: {
            [P]: {
              tabs: [{ id: 'c', kind: 'console', title: 'Console' }],
              activeTabId: 'c',
              lastQueryTabId: null,
              queryCounter: 1
            }
          }
        }
      })
    )
    await useDataWorkspaceStore.persist.rehydrate()
    expect(useDataWorkspaceStore.getState().workspaces[P].tabs.map((t) => t.kind)).toEqual([
      'console'
    ])
    useDataWorkspaceStore.getState().reset()
  })

  it('is a singleton special tab in the Mongo workspace and survives a restart', async () => {
    const store = useMongoWorkspaceStore.getState()
    store.reset()
    const id = store.openSpecialTab(P, 'console')
    expect(store.openSpecialTab(P, 'console')).toBe(id)
    expect(useMongoWorkspaceStore.getState().workspaces[P].tabs).toEqual([{ id, kind: 'console' }])
    localStorage.setItem(
      'hive-mongo-workspace',
      JSON.stringify({
        version: 1,
        state: {
          workspaces: { [P]: { tabs: [{ id: 'c', kind: 'console' }], activeTabId: 'c' } },
          filterHistory: {}
        }
      })
    )
    await useMongoWorkspaceStore.persist.rehydrate()
    expect(useMongoWorkspaceStore.getState().workspaces[P].tabs).toEqual([
      { id: 'c', kind: 'console' }
    ])
    useMongoWorkspaceStore.getState().reset()
  })
})
