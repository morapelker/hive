import { describe, test, expect, beforeEach, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { act } from '@testing-library/react'
import { RecentConnectionsDialog } from '../../../src/renderer/src/components/connections/RecentConnectionsDialog'
import { useConnectionStore } from '../../../src/renderer/src/stores/useConnectionStore'
import type { RecentConnectionEntry } from '../../../src/shared/types/connection'

const apiMocks = vi.hoisted(() => ({
  connectionApi: {
    getRecentConnections: vi.fn(),
    setRecentConnectionNote: vi.fn()
  }
}))

vi.mock('@/api/connection-api', () => ({
  connectionApi: apiMocks.connectionApi
}))

vi.mock('@/lib/toast', () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warning: vi.fn()
  }
}))

const mockConnectionApi = apiMocks.connectionApi

// ---------- Test data factories ----------
function makeEntry(overrides: Partial<RecentConnectionEntry> = {}): RecentConnectionEntry {
  return {
    id: 'hist-1',
    project_set_key: 'proj-1,proj-2',
    projects: [
      { id: 'proj-1', name: 'Frontend', path: '/repos/frontend' },
      { id: 'proj-2', name: 'Backend', path: '/repos/backend' }
    ],
    last_used_at: new Date(Date.now() - 5 * 60000).toISOString(),
    use_count: 3,
    note: null,
    ...overrides
  }
}

function makeSecondEntry(overrides: Partial<RecentConnectionEntry> = {}): RecentConnectionEntry {
  return makeEntry({
    id: 'hist-2',
    project_set_key: 'proj-3,proj-4',
    projects: [
      { id: 'proj-3', name: 'Api', path: '/repos/api' },
      { id: 'proj-4', name: 'Docs', path: '/repos/docs' }
    ],
    ...overrides
  })
}

async function flush(): Promise<void> {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 10))
  })
}

describe('Recent Connections Dialog', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockConnectionApi.getRecentConnections.mockResolvedValue({ success: true, entries: [] })
    useConnectionStore.setState({
      quickCreateConnection: vi.fn().mockResolvedValue('new-conn-id')
    })
  })

  test('shows empty state when the API returns no entries', async () => {
    mockConnectionApi.getRecentConnections.mockResolvedValue({ success: true, entries: [] })

    render(<RecentConnectionsDialog open={true} onOpenChange={vi.fn()} />)

    await act(async () => {
      await new Promise((r) => setTimeout(r, 10))
    })

    expect(screen.getByTestId('recent-connections-empty')).toBeInTheDocument()
  })

  test('shows a loading spinner while fetching, taking precedence over the empty state', async () => {
    let resolveFetch: (value: { success: true; entries: RecentConnectionEntry[] }) => void = () => {}
    const pending = new Promise<{ success: true; entries: RecentConnectionEntry[] }>((resolve) => {
      resolveFetch = resolve
    })
    mockConnectionApi.getRecentConnections.mockReturnValueOnce(pending)

    render(<RecentConnectionsDialog open={true} onOpenChange={vi.fn()} />)

    expect(screen.getByTestId('recent-connections-loading')).toBeInTheDocument()
    expect(screen.queryByTestId('recent-connections-empty')).not.toBeInTheDocument()

    await act(async () => {
      resolveFetch({ success: true, entries: [] })
      await new Promise((r) => setTimeout(r, 10))
    })

    expect(screen.queryByTestId('recent-connections-loading')).not.toBeInTheDocument()
    expect(screen.getByTestId('recent-connections-empty')).toBeInTheDocument()
  })

  test('clears previously loaded rows while refetching on reopen', async () => {
    const entry = makeEntry()
    mockConnectionApi.getRecentConnections.mockResolvedValue({ success: true, entries: [entry] })

    const { rerender } = render(<RecentConnectionsDialog open={true} onOpenChange={vi.fn()} />)

    await act(async () => {
      await new Promise((r) => setTimeout(r, 10))
    })
    expect(screen.getByTestId(`recent-connection-row-${entry.id}`)).toBeInTheDocument()

    // Close, then hold the next fetch open so we can inspect state mid-flight on reopen.
    rerender(<RecentConnectionsDialog open={false} onOpenChange={vi.fn()} />)

    let resolveFetch: (value: { success: true; entries: RecentConnectionEntry[] }) => void = () => {}
    const pending = new Promise<{ success: true; entries: RecentConnectionEntry[] }>((resolve) => {
      resolveFetch = resolve
    })
    mockConnectionApi.getRecentConnections.mockReturnValueOnce(pending)

    rerender(<RecentConnectionsDialog open={true} onOpenChange={vi.fn()} />)

    // The stale row from the previous open must not remain visible/selectable during refresh.
    expect(screen.queryByTestId(`recent-connection-row-${entry.id}`)).not.toBeInTheDocument()
    expect(screen.getByTestId('recent-connections-loading')).toBeInTheDocument()

    await act(async () => {
      resolveFetch({ success: true, entries: [entry] })
      await new Promise((r) => setTimeout(r, 10))
    })
    expect(screen.getByTestId(`recent-connection-row-${entry.id}`)).toBeInTheDocument()
  })

  test('renders rows with joined project names', async () => {
    const entry = makeEntry()
    mockConnectionApi.getRecentConnections.mockResolvedValue({ success: true, entries: [entry] })

    render(<RecentConnectionsDialog open={true} onOpenChange={vi.fn()} />)

    await act(async () => {
      await new Promise((r) => setTimeout(r, 10))
    })

    expect(screen.getByTestId(`recent-connection-row-${entry.id}`)).toBeInTheDocument()
    expect(screen.getByText('Frontend + Backend')).toBeInTheDocument()
  })

  test('Create button is disabled until a row is selected', async () => {
    const user = userEvent.setup()
    const entry = makeEntry()
    mockConnectionApi.getRecentConnections.mockResolvedValue({ success: true, entries: [entry] })

    render(<RecentConnectionsDialog open={true} onOpenChange={vi.fn()} />)

    await act(async () => {
      await new Promise((r) => setTimeout(r, 10))
    })

    const createButton = screen.getByTestId('recent-connections-create-button')
    expect(createButton).toBeDisabled()

    await user.click(screen.getByTestId(`recent-connection-row-${entry.id}`))

    expect(createButton).not.toBeDisabled()
  })

  test('shows error message instead of empty state when the API resolves unsuccessfully', async () => {
    mockConnectionApi.getRecentConnections.mockResolvedValue({
      success: false,
      error: 'Database is locked'
    })

    render(<RecentConnectionsDialog open={true} onOpenChange={vi.fn()} />)

    await act(async () => {
      await new Promise((r) => setTimeout(r, 10))
    })

    expect(screen.getByTestId('recent-connections-error')).toHaveTextContent('Database is locked')
    expect(screen.queryByTestId('recent-connections-empty')).not.toBeInTheDocument()
  })

  test('shows error message instead of empty state when the API rejects', async () => {
    mockConnectionApi.getRecentConnections.mockRejectedValue(new Error('RPC connection lost'))

    render(<RecentConnectionsDialog open={true} onOpenChange={vi.fn()} />)

    await act(async () => {
      await new Promise((r) => setTimeout(r, 10))
    })

    expect(screen.getByTestId('recent-connections-error')).toHaveTextContent('RPC connection lost')
    expect(screen.queryByTestId('recent-connections-empty')).not.toBeInTheDocument()
  })

  test('clicking Create invokes quickCreateConnection with the entry projects and closes on success', async () => {
    const user = userEvent.setup()
    const onOpenChange = vi.fn()
    const entry = makeEntry()
    mockConnectionApi.getRecentConnections.mockResolvedValue({ success: true, entries: [entry] })
    const quickCreateConnection = vi.fn().mockResolvedValue('new-conn-id')
    useConnectionStore.setState({ quickCreateConnection })

    render(<RecentConnectionsDialog open={true} onOpenChange={onOpenChange} />)

    await act(async () => {
      await new Promise((r) => setTimeout(r, 10))
    })

    await user.click(screen.getByTestId(`recent-connection-row-${entry.id}`))
    await user.click(screen.getByTestId('recent-connections-create-button'))

    await act(async () => {
      await new Promise((r) => setTimeout(r, 10))
    })

    expect(quickCreateConnection).toHaveBeenCalledWith(entry.projects)
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  test('filter input narrows rows by project name, case-insensitively', async () => {
    const user = userEvent.setup()
    const entryA = makeEntry()
    const entryB = makeSecondEntry()
    mockConnectionApi.getRecentConnections.mockResolvedValue({
      success: true,
      entries: [entryA, entryB]
    })

    render(<RecentConnectionsDialog open={true} onOpenChange={vi.fn()} />)
    await flush()

    expect(screen.getByTestId('recent-connection-row-hist-1')).toBeInTheDocument()
    expect(screen.getByTestId('recent-connection-row-hist-2')).toBeInTheDocument()

    await user.type(screen.getByTestId('recent-connections-filter'), 'FRONT')

    expect(screen.getByTestId('recent-connection-row-hist-1')).toBeInTheDocument()
    expect(screen.queryByTestId('recent-connection-row-hist-2')).not.toBeInTheDocument()

    await user.clear(screen.getByTestId('recent-connections-filter'))

    expect(screen.getByTestId('recent-connection-row-hist-1')).toBeInTheDocument()
    expect(screen.getByTestId('recent-connection-row-hist-2')).toBeInTheDocument()
  })

  test('shows a no-match state when the filter matches nothing', async () => {
    const user = userEvent.setup()
    mockConnectionApi.getRecentConnections.mockResolvedValue({
      success: true,
      entries: [makeEntry()]
    })

    render(<RecentConnectionsDialog open={true} onOpenChange={vi.fn()} />)
    await flush()

    await user.type(screen.getByTestId('recent-connections-filter'), 'zzz-no-match')

    expect(screen.getByTestId('recent-connections-no-match')).toBeInTheDocument()
    expect(screen.queryByTestId('recent-connections-empty')).not.toBeInTheDocument()
    expect(screen.queryByTestId('recent-connection-row-hist-1')).not.toBeInTheDocument()
  })

  test('filter matches the note text', async () => {
    const user = userEvent.setup()
    const entryA = makeEntry()
    const entryB = makeSecondEntry({ note: 'urgent hotfix' })
    mockConnectionApi.getRecentConnections.mockResolvedValue({
      success: true,
      entries: [entryA, entryB]
    })

    render(<RecentConnectionsDialog open={true} onOpenChange={vi.fn()} />)
    await flush()

    await user.type(screen.getByTestId('recent-connections-filter'), 'urgent')

    expect(screen.queryByTestId('recent-connection-row-hist-1')).not.toBeInTheDocument()
    expect(screen.getByTestId('recent-connection-row-hist-2')).toBeInTheDocument()
  })

  test('filtering out the selected row disables Create', async () => {
    const user = userEvent.setup()
    const entryA = makeEntry()
    const entryB = makeSecondEntry()
    mockConnectionApi.getRecentConnections.mockResolvedValue({
      success: true,
      entries: [entryA, entryB]
    })

    render(<RecentConnectionsDialog open={true} onOpenChange={vi.fn()} />)
    await flush()

    await user.click(screen.getByTestId('recent-connection-row-hist-1'))
    const createButton = screen.getByTestId('recent-connections-create-button')
    expect(createButton).not.toBeDisabled()

    await user.type(screen.getByTestId('recent-connections-filter'), 'api')

    expect(screen.queryByTestId('recent-connection-row-hist-1')).not.toBeInTheDocument()
    expect(createButton).toBeDisabled()
  })

  test('renders the note as a styled prefix only when present', async () => {
    const entryA = makeEntry({ note: 'urgent' })
    const entryB = makeSecondEntry()
    mockConnectionApi.getRecentConnections.mockResolvedValue({
      success: true,
      entries: [entryA, entryB]
    })

    render(<RecentConnectionsDialog open={true} onOpenChange={vi.fn()} />)
    await flush()

    expect(screen.getByTestId('recent-connection-note-hist-1')).toHaveTextContent('urgent')
    expect(screen.queryByTestId('recent-connection-note-hist-2')).not.toBeInTheDocument()
  })

  test('right-click, Add note, then Enter saves via the API and shows the prefix', async () => {
    const user = userEvent.setup()
    const entry = makeEntry()
    mockConnectionApi.getRecentConnections.mockResolvedValue({ success: true, entries: [entry] })
    mockConnectionApi.setRecentConnectionNote.mockResolvedValue({ success: true })

    render(<RecentConnectionsDialog open={true} onOpenChange={vi.fn()} />)
    await flush()

    fireEvent.contextMenu(screen.getByTestId('recent-connection-row-hist-1'))
    await user.click(await screen.findByText('Add note'))

    const input = await screen.findByTestId('recent-connection-note-input')
    await user.type(input, 'ship it{Enter}')
    await flush()

    expect(mockConnectionApi.setRecentConnectionNote).toHaveBeenCalledWith('hist-1', 'ship it')
    expect(screen.queryByTestId('recent-connection-note-input')).not.toBeInTheDocument()
    expect(screen.getByTestId('recent-connection-note-hist-1')).toHaveTextContent('ship it')
  })

  test('Escape cancels the note edit without calling the API', async () => {
    const user = userEvent.setup()
    const entry = makeEntry()
    mockConnectionApi.getRecentConnections.mockResolvedValue({ success: true, entries: [entry] })

    render(<RecentConnectionsDialog open={true} onOpenChange={vi.fn()} />)
    await flush()

    fireEvent.contextMenu(screen.getByTestId('recent-connection-row-hist-1'))
    await user.click(await screen.findByText('Add note'))

    const input = await screen.findByTestId('recent-connection-note-input')
    await user.type(input, 'discard me{Escape}')
    await flush()

    expect(mockConnectionApi.setRecentConnectionNote).not.toHaveBeenCalled()
    expect(screen.queryByTestId('recent-connection-note-input')).not.toBeInTheDocument()
    // The dialog itself stays open.
    expect(screen.getByTestId('recent-connections-dialog')).toBeInTheDocument()
  })

  test('Remove note is offered for noted entries and clears via the API', async () => {
    const user = userEvent.setup()
    const entry = makeEntry({ note: 'stale note' })
    mockConnectionApi.getRecentConnections.mockResolvedValue({ success: true, entries: [entry] })
    mockConnectionApi.setRecentConnectionNote.mockResolvedValue({ success: true })

    render(<RecentConnectionsDialog open={true} onOpenChange={vi.fn()} />)
    await flush()

    fireEvent.contextMenu(screen.getByTestId('recent-connection-row-hist-1'))
    // A noted entry offers Edit (not Add) alongside Remove.
    expect(await screen.findByText('Edit note')).toBeInTheDocument()
    await user.click(screen.getByText('Remove note'))
    await flush()

    expect(mockConnectionApi.setRecentConnectionNote).toHaveBeenCalledWith('hist-1', null)
    expect(screen.queryByTestId('recent-connection-note-hist-1')).not.toBeInTheDocument()
  })
})
