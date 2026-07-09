import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import { RecentConnectionsDialog } from '../RecentConnectionsDialog'
import type { RecentConnectionEntry } from '@shared/types/connection'

vi.mock('@/api/connection-api', () => ({
  connectionApi: {
    getRecentConnections: vi.fn(),
    setRecentConnectionNote: vi.fn()
  }
}))

import { connectionApi } from '@/api/connection-api'

const alpha = { id: 'proj-a', name: 'alpha-service', path: '/repo/alpha-service' }
const beta = { id: 'proj-b', name: 'beta-web', path: '/repo/beta-web' }
const gamma = { id: 'proj-c', name: 'gamma-api', path: '/repo/gamma-api' }

function entry(
  id: string,
  projects: (typeof alpha)[],
  note: string | null = null
): RecentConnectionEntry {
  return {
    id,
    project_set_key: projects.map((p) => p.id).join('|'),
    projects,
    last_used_at: '2026-07-01T00:00:00.000Z',
    use_count: 1,
    note
  }
}

const entries = [
  entry('e1', [alpha, beta]),
  entry('e2', [alpha, gamma]),
  entry('e3', [beta, gamma])
]

async function renderDialog(data: RecentConnectionEntry[] = entries): Promise<void> {
  vi.mocked(connectionApi.getRecentConnections).mockResolvedValue({
    success: true,
    entries: data
  })
  render(<RecentConnectionsDialog open onOpenChange={() => {}} />)
  await waitFor(() =>
    expect(screen.queryByTestId('recent-connections-loading')).not.toBeInTheDocument()
  )
}

describe('RecentConnectionsDialog project filter panel', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('lists the unique projects from all entries in the project panel', async () => {
    await renderDialog()

    const panel = screen.getByTestId('recent-connections-project-list')
    expect(within(panel).getByText('alpha-service')).toBeInTheDocument()
    expect(within(panel).getByText('beta-web')).toBeInTheDocument()
    expect(within(panel).getByText('gamma-api')).toBeInTheDocument()
    // Unique: alpha appears in two entries but is listed once
    expect(within(panel).getAllByText('alpha-service')).toHaveLength(1)
  })

  it('filters projects with fuzzy subsequence matching like the sidebar', async () => {
    await renderDialog()

    const input = screen.getByTestId('recent-connections-project-filter')
    // "gapi" is a subsequence of "gamma-api" but not of the others
    await userEvent.type(input, 'gapi')

    const panel = screen.getByTestId('recent-connections-project-list')
    expect(within(panel).getByText('gamma-api')).toBeInTheDocument()
    expect(within(panel).queryByText('alpha-service')).not.toBeInTheDocument()
    expect(within(panel).queryByText('beta-web')).not.toBeInTheDocument()
  })

  it('selecting a project filters entries to connections containing it', async () => {
    await renderDialog()

    await userEvent.click(screen.getByTestId('recent-connections-project-option-proj-a'))

    expect(screen.getByTestId('recent-connection-row-e1')).toBeInTheDocument()
    expect(screen.getByTestId('recent-connection-row-e2')).toBeInTheDocument()
    expect(screen.queryByTestId('recent-connection-row-e3')).not.toBeInTheDocument()
  })

  it('shows only the unselected projects prefixed with + in each row', async () => {
    await renderDialog()

    // Before selection: full names joined with +
    expect(screen.getByTestId('recent-connection-row-e1')).toHaveTextContent(
      'alpha-service + beta-web'
    )

    await userEvent.click(screen.getByTestId('recent-connections-project-option-proj-a'))

    const row1 = screen.getByTestId('recent-connection-row-e1')
    expect(row1).toHaveTextContent('+ beta-web')
    expect(row1).not.toHaveTextContent('alpha-service')
    expect(screen.getByTestId('recent-connection-row-e2')).toHaveTextContent('+ gamma-api')
  })

  it('requires all selected projects and hides them from row labels', async () => {
    await renderDialog([...entries, entry('e4', [alpha, beta, gamma])])

    await userEvent.click(screen.getByTestId('recent-connections-project-option-proj-a'))
    await userEvent.click(screen.getByTestId('recent-connections-project-option-proj-b'))

    // Only entries containing both alpha and beta remain
    expect(screen.getByTestId('recent-connection-row-e1')).toBeInTheDocument()
    expect(screen.getByTestId('recent-connection-row-e4')).toBeInTheDocument()
    expect(screen.queryByTestId('recent-connection-row-e2')).not.toBeInTheDocument()
    expect(screen.queryByTestId('recent-connection-row-e3')).not.toBeInTheDocument()

    // e4 shows only the remaining project; e1 has no remaining projects
    expect(screen.getByTestId('recent-connection-row-e4')).toHaveTextContent('+ gamma-api')
    const row1 = screen.getByTestId('recent-connection-row-e1')
    expect(row1).not.toHaveTextContent('alpha-service')
    expect(row1).not.toHaveTextContent('beta-web')
  })

  it('shows selected projects as chips at the top and removes them on click', async () => {
    await renderDialog()

    await userEvent.click(screen.getByTestId('recent-connections-project-option-proj-a'))

    const chips = screen.getByTestId('recent-connections-selected-projects')
    expect(within(chips).getByText('alpha-service')).toBeInTheDocument()

    await userEvent.click(screen.getByTestId('recent-connections-selected-chip-proj-a'))

    expect(screen.queryByTestId('recent-connections-selected-projects')).not.toBeInTheDocument()
    // All rows are back with full labels
    expect(screen.getByTestId('recent-connection-row-e3')).toBeInTheDocument()
    expect(screen.getByTestId('recent-connection-row-e1')).toHaveTextContent(
      'alpha-service + beta-web'
    )
  })

  it('combines the text filter with the project selection', async () => {
    await renderDialog([...entries, entry('e5', [alpha, beta], 'release pair')])

    await userEvent.click(screen.getByTestId('recent-connections-project-option-proj-a'))
    await userEvent.type(screen.getByTestId('recent-connections-filter'), 'release')

    expect(screen.getByTestId('recent-connection-row-e5')).toBeInTheDocument()
    expect(screen.queryByTestId('recent-connection-row-e1')).not.toBeInTheDocument()
    expect(screen.queryByTestId('recent-connection-row-e2')).not.toBeInTheDocument()
  })
})
