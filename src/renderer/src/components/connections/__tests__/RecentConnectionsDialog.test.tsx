import { beforeEach, describe, expect, it, vi } from 'vitest'
import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import { RecentConnectionsDialog } from '../RecentConnectionsDialog'
import { useConnectionStore } from '@/stores/useConnectionStore'
import { useProjectStore } from '@/stores/useProjectStore'
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

function setStoreProjects(projects: (typeof alpha)[]): void {
  useProjectStore.setState({ projects } as never)
}

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
    setStoreProjects([])
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

describe('RecentConnectionsDialog all-projects panel', () => {
  const delta = { id: 'proj-d', name: 'delta-cli', path: '/repo/delta-cli' }
  const epsilon = { id: 'proj-e', name: 'epsilon-lib', path: '/repo/epsilon-lib' }

  beforeEach(() => {
    vi.clearAllMocks()
    setStoreProjects([])
  })

  it('lists app projects that appear in no recent connection', async () => {
    setStoreProjects([alpha, delta])
    await renderDialog()

    const panel = screen.getByTestId('recent-connections-project-list')
    expect(within(panel).getByText('delta-cli')).toBeInTheDocument()
    // Entry-only projects remain listed alongside store projects, deduped
    expect(within(panel).getAllByText('alpha-service')).toHaveLength(1)
    expect(within(panel).getByText('beta-web')).toBeInTheDocument()
  })

  it('prefers the current app name over the recorded entry snapshot', async () => {
    setStoreProjects([{ ...alpha, name: 'alpha-renamed' }])
    await renderDialog()

    const panel = screen.getByTestId('recent-connections-project-list')
    expect(within(panel).getByText('alpha-renamed')).toBeInTheDocument()
    expect(within(panel).queryByText('alpha-service')).not.toBeInTheDocument()
  })

  it('creates a connection from app projects never used together before', async () => {
    const quickCreateConnection = vi.fn().mockResolvedValue('conn-2')
    useConnectionStore.setState({ quickCreateConnection } as never)
    setStoreProjects([delta, epsilon])
    await renderDialog([])

    await userEvent.click(screen.getByTestId('recent-connections-project-option-proj-d'))
    await userEvent.click(screen.getByTestId('recent-connections-project-option-proj-e'))

    // The zero-entries empty state must not hide the synthetic selection row
    expect(screen.queryByTestId('recent-connections-empty')).not.toBeInTheDocument()
    await userEvent.click(screen.getByTestId('recent-connection-row-selected-combo'))
    await userEvent.click(screen.getByTestId('recent-connections-create-button'))

    await waitFor(() =>
      expect(quickCreateConnection).toHaveBeenCalledWith(
        [delta, epsilon],
        expect.objectContaining({ autoPull: true })
      )
    )
  })

  it('filters store projects with the same fuzzy matching as the sidebar', async () => {
    setStoreProjects([delta, epsilon])
    await renderDialog([])

    await userEvent.type(screen.getByTestId('recent-connections-project-filter'), 'dcli')

    const panel = screen.getByTestId('recent-connections-project-list')
    expect(within(panel).getByText('delta-cli')).toBeInTheDocument()
    expect(within(panel).queryByText('epsilon-lib')).not.toBeInTheDocument()
  })
})

describe('RecentConnectionsDialog pinned selection row', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    setStoreProjects([])
  })

  it('does not show the selection row with fewer than 2 projects selected', async () => {
    await renderDialog()

    await userEvent.click(screen.getByTestId('recent-connections-project-option-proj-a'))

    expect(screen.queryByTestId('recent-connection-row-selected-combo')).not.toBeInTheDocument()
  })

  it('pins a synthetic row with exactly the selected projects when no entry matches', async () => {
    // alpha+beta+gamma exists in no entry
    await renderDialog()

    await userEvent.click(screen.getByTestId('recent-connections-project-option-proj-a'))
    await userEvent.click(screen.getByTestId('recent-connections-project-option-proj-b'))
    await userEvent.click(screen.getByTestId('recent-connections-project-option-proj-c'))

    const combo = screen.getByTestId('recent-connection-row-selected-combo')
    expect(combo).toHaveTextContent('alpha-service + beta-web + gamma-api')
    expect(combo).toHaveTextContent('New connection from selected projects')
    // No entry contains all three, but the no-match empty state must not replace the row
    expect(screen.queryByTestId('recent-connections-no-match')).not.toBeInTheDocument()
  })

  it('creates a new connection from the synthetic selection row', async () => {
    const quickCreateConnection = vi.fn().mockResolvedValue('conn-1')
    useConnectionStore.setState({ quickCreateConnection } as never)
    const onOpenChange = vi.fn()

    vi.mocked(connectionApi.getRecentConnections).mockResolvedValue({
      success: true,
      entries
    })
    render(<RecentConnectionsDialog open onOpenChange={onOpenChange} />)
    await waitFor(() =>
      expect(screen.queryByTestId('recent-connections-loading')).not.toBeInTheDocument()
    )

    await userEvent.click(screen.getByTestId('recent-connections-project-option-proj-a'))
    await userEvent.click(screen.getByTestId('recent-connections-project-option-proj-b'))
    await userEvent.click(screen.getByTestId('recent-connections-project-option-proj-c'))
    await userEvent.click(screen.getByTestId('recent-connection-row-selected-combo'))
    await userEvent.click(screen.getByTestId('recent-connections-create-button'))

    await waitFor(() =>
      expect(quickCreateConnection).toHaveBeenCalledWith(
        [alpha, beta, gamma],
        expect.objectContaining({ autoPull: true })
      )
    )
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it('pins the exact matching entry first instead of a synthetic row', async () => {
    await renderDialog()

    // beta+gamma matches e3, which normally sorts last
    await userEvent.click(screen.getByTestId('recent-connections-project-option-proj-b'))
    await userEvent.click(screen.getByTestId('recent-connections-project-option-proj-c'))

    expect(screen.queryByTestId('recent-connection-row-selected-combo')).not.toBeInTheDocument()
    const rows = screen.getAllByTestId(/^recent-connection-row-/)
    expect(rows[0]).toHaveAttribute('data-testid', 'recent-connection-row-e3')
  })

  it('keeps the pinned exact match visible even when the text filter excludes it', async () => {
    await renderDialog()

    await userEvent.click(screen.getByTestId('recent-connections-project-option-proj-b'))
    await userEvent.click(screen.getByTestId('recent-connections-project-option-proj-c'))
    await userEvent.type(screen.getByTestId('recent-connections-filter'), 'zzz-no-match')

    expect(screen.getByTestId('recent-connection-row-e3')).toBeInTheDocument()
  })

  it('drops the synthetic selection when the combination gains an exact match', async () => {
    await renderDialog()

    await userEvent.click(screen.getByTestId('recent-connections-project-option-proj-a'))
    await userEvent.click(screen.getByTestId('recent-connections-project-option-proj-b'))
    await userEvent.click(screen.getByTestId('recent-connections-project-option-proj-c'))
    await userEvent.click(screen.getByTestId('recent-connection-row-selected-combo'))

    // Deselect gamma: alpha+beta matches e1 exactly, so the synthetic row vanishes
    await userEvent.click(screen.getByTestId('recent-connections-project-option-proj-c'))

    expect(screen.queryByTestId('recent-connection-row-selected-combo')).not.toBeInTheDocument()
    expect(screen.getByTestId('recent-connections-create-button')).toBeDisabled()
  })
})

describe('RecentConnectionsDialog auto-pull switch', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    setStoreProjects([])
  })

  it('starts switched on and creates the connection with a pull', async () => {
    const quickCreateConnection = vi.fn().mockResolvedValue('conn-1')
    useConnectionStore.setState({ quickCreateConnection } as never)
    await renderDialog()

    expect(screen.getByTestId('recent-connections-auto-pull-switch')).toBeChecked()

    await userEvent.click(screen.getByTestId('recent-connection-row-e1'))
    await userEvent.click(screen.getByTestId('recent-connections-create-button'))

    await waitFor(() =>
      expect(quickCreateConnection).toHaveBeenCalledWith(
        [alpha, beta],
        expect.objectContaining({ autoPull: true })
      )
    )
  })

  it('creates the connection without a pull when switched off', async () => {
    const quickCreateConnection = vi.fn().mockResolvedValue('conn-1')
    useConnectionStore.setState({ quickCreateConnection } as never)
    await renderDialog()

    await userEvent.click(screen.getByTestId('recent-connections-auto-pull-switch'))
    expect(screen.getByTestId('recent-connections-auto-pull-switch')).not.toBeChecked()

    await userEvent.click(screen.getByTestId('recent-connection-row-e1'))
    await userEvent.click(screen.getByTestId('recent-connections-create-button'))

    await waitFor(() =>
      expect(quickCreateConnection).toHaveBeenCalledWith(
        [alpha, beta],
        expect.objectContaining({ autoPull: false })
      )
    )
  })

  it('is back on the next time the dialog opens', async () => {
    vi.mocked(connectionApi.getRecentConnections).mockResolvedValue({ success: true, entries })
    const { rerender } = render(<RecentConnectionsDialog open onOpenChange={() => {}} />)
    await waitFor(() =>
      expect(screen.queryByTestId('recent-connections-loading')).not.toBeInTheDocument()
    )

    await userEvent.click(screen.getByTestId('recent-connections-auto-pull-switch'))
    expect(screen.getByTestId('recent-connections-auto-pull-switch')).not.toBeChecked()

    rerender(<RecentConnectionsDialog open={false} onOpenChange={() => {}} />)
    rerender(<RecentConnectionsDialog open onOpenChange={() => {}} />)

    await waitFor(() =>
      expect(screen.getByTestId('recent-connections-auto-pull-switch')).toBeChecked()
    )
  })
})

describe('RecentConnectionsDialog create progress', () => {
  type Progress = { projectId: string; step: 'pull' | 'worktree'; status: string; error?: string }
  type CreateOptions = {
    autoPull: boolean
    onProgress: (progress: Progress) => void
    onError: (error: string) => void
  }

  /** A quickCreateConnection the test drives step by step: `finish` ends it with a result. */
  function controlledCreate(): {
    quickCreateConnection: ReturnType<typeof vi.fn>
    options: () => CreateOptions
    finish: (connectionId: string | null) => void
  } {
    let finish: (connectionId: string | null) => void = () => {}
    const quickCreateConnection = vi.fn(
      (_projects: unknown, _options: CreateOptions) =>
        new Promise<string | null>((resolve) => {
          finish = resolve
        })
    )
    useConnectionStore.setState({ quickCreateConnection } as never)
    return {
      quickCreateConnection,
      options: () => quickCreateConnection.mock.calls[0][1],
      finish: (connectionId) => finish(connectionId)
    }
  }

  const task = (step: 'pull' | 'worktree', projectId: string): HTMLElement =>
    screen.getByTestId(`recent-connections-create-task-${step}-${projectId}`)

  const startCreate = async (): Promise<void> => {
    await userEvent.click(screen.getByTestId('recent-connection-row-e1'))
    await userEvent.click(screen.getByTestId('recent-connections-create-button'))
  }

  beforeEach(() => {
    vi.clearAllMocks()
    setStoreProjects([])
  })

  it('shows no checklist before Create is pressed', async () => {
    await renderDialog()

    expect(screen.queryByTestId('recent-connections-create-progress')).not.toBeInTheDocument()
  })

  it('lists a pull and a worktree task per project, pulls first, once Create is pressed', async () => {
    const create = controlledCreate()
    await renderDialog()

    await startCreate()

    const tasks = within(screen.getByTestId('recent-connections-create-progress')).getAllByRole(
      'listitem'
    )
    expect(tasks.map((item) => item.textContent)).toEqual([
      'Pull alpha-service from origin',
      'Pull beta-web from origin',
      'Create worktree in alpha-service',
      'Create worktree in beta-web'
    ])
    for (const item of tasks) expect(item).toHaveAttribute('data-status', 'pending')
    // The picker gives way to the checklist while it runs
    expect(screen.getByTestId('recent-connections-filter')).not.toBeVisible()

    await act(async () => create.finish('conn-1'))
  })

  it('lists one task per project when the pull is switched off', async () => {
    const create = controlledCreate()
    await renderDialog()
    await userEvent.click(screen.getByTestId('recent-connections-auto-pull-switch'))

    await startCreate()

    const tasks = within(screen.getByTestId('recent-connections-create-progress')).getAllByRole(
      'listitem'
    )
    expect(tasks.map((item) => item.textContent)).toEqual([
      'Create worktree in alpha-service',
      'Create worktree in beta-web'
    ])

    await act(async () => create.finish('conn-1'))
  })

  it('marks each task as it runs and as it is done', async () => {
    const create = controlledCreate()
    const onOpenChange = vi.fn()
    vi.mocked(connectionApi.getRecentConnections).mockResolvedValue({ success: true, entries })
    render(<RecentConnectionsDialog open onOpenChange={onOpenChange} />)
    await waitFor(() =>
      expect(screen.queryByTestId('recent-connections-loading')).not.toBeInTheDocument()
    )
    await startCreate()

    act(() => create.options().onProgress({ projectId: 'proj-a', step: 'pull', status: 'running' }))
    expect(task('pull', 'proj-a')).toHaveAttribute('data-status', 'running')
    expect(task('pull', 'proj-b')).toHaveAttribute('data-status', 'pending')

    act(() => {
      create.options().onProgress({ projectId: 'proj-a', step: 'pull', status: 'done' })
      create.options().onProgress({ projectId: 'proj-b', step: 'pull', status: 'done' })
      create.options().onProgress({ projectId: 'proj-a', step: 'worktree', status: 'running' })
    })
    expect(task('pull', 'proj-a')).toHaveAttribute('data-status', 'done')
    expect(task('pull', 'proj-b')).toHaveAttribute('data-status', 'done')
    expect(task('worktree', 'proj-a')).toHaveAttribute('data-status', 'running')
    expect(task('worktree', 'proj-b')).toHaveAttribute('data-status', 'pending')

    await act(async () => create.finish('conn-1'))
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it('returns to the picker with the error when a pull fails, selection kept', async () => {
    const create = controlledCreate()
    const onOpenChange = vi.fn()
    vi.mocked(connectionApi.getRecentConnections).mockResolvedValue({ success: true, entries })
    render(<RecentConnectionsDialog open onOpenChange={onOpenChange} />)
    await waitFor(() =>
      expect(screen.queryByTestId('recent-connections-loading')).not.toBeInTheDocument()
    )
    await startCreate()

    act(() =>
      create.options().onProgress({
        projectId: 'proj-b',
        step: 'pull',
        status: 'failed',
        error: 'diverged'
      })
    )
    expect(task('pull', 'proj-b')).toHaveAttribute('data-status', 'failed')

    await act(async () => {
      create.options().onError('Could not pull "beta-web": diverged')
      create.finish(null)
    })

    expect(screen.queryByTestId('recent-connections-create-progress')).not.toBeInTheDocument()
    expect(screen.getByTestId('recent-connections-create-error')).toHaveTextContent(
      'Could not pull "beta-web": diverged'
    )
    expect(screen.getByTestId('recent-connections-filter')).toBeVisible()
    expect(onOpenChange).not.toHaveBeenCalled()
    // Still on the same row, ready to try again
    expect(screen.getByTestId('recent-connections-create-button')).toBeEnabled()
  })

  it('clears the error when Create is pressed again', async () => {
    const create = controlledCreate()
    await renderDialog()
    await startCreate()
    await act(async () => {
      create.options().onError('Could not pull "beta-web": diverged')
      create.finish(null)
    })
    expect(screen.getByTestId('recent-connections-create-error')).toBeInTheDocument()

    await userEvent.click(screen.getByTestId('recent-connections-create-button'))

    expect(screen.queryByTestId('recent-connections-create-error')).not.toBeInTheDocument()
    expect(screen.getByTestId('recent-connections-create-progress')).toBeInTheDocument()
    expect(create.quickCreateConnection).toHaveBeenCalledTimes(2)

    await act(async () => create.finish('conn-1'))
  })
})
