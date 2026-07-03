import { describe, test, expect, beforeEach, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { act } from '@testing-library/react'
import { RecentConnectionsDialog } from '../../../src/renderer/src/components/connections/RecentConnectionsDialog'
import { useConnectionStore } from '../../../src/renderer/src/stores/useConnectionStore'
import type { RecentConnectionEntry } from '../../../src/shared/types/connection'

const apiMocks = vi.hoisted(() => ({
  connectionApi: {
    getRecentConnections: vi.fn()
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
    ...overrides
  }
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
})
