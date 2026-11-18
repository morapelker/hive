import type { ReactNode } from 'react'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react'
import { resetRendererRpcClientForTests, setRendererRpcClient } from '@/api/rpc-client'
import { TooltipProvider } from '@/components/ui/tooltip'

vi.mock('@/api/settings-api', () => ({
  settingsApi: {
    onSettingsUpdated: vi.fn(() => vi.fn())
  }
}))

vi.mock('@/api/pet-api', () => ({
  petApi: {
    updateSettings: vi.fn()
  }
}))

// The row's menus, flat: the context menu always open, its items plain buttons (the real
// menus spend seconds per test opening and closing in jsdom)
vi.mock('@/components/ui/context-menu', () => {
  const Passthrough = ({ children }: { children?: ReactNode }): React.JSX.Element => (
    <>{children}</>
  )
  return {
    ContextMenu: Passthrough,
    ContextMenuTrigger: Passthrough,
    ContextMenuSub: Passthrough,
    ContextMenuSubTrigger: Passthrough,
    ContextMenuSubContent: Passthrough,
    ContextMenuContent: ({ children }: { children?: ReactNode }) => (
      <div role="menu">{children}</div>
    ),
    ContextMenuSeparator: () => null,
    ContextMenuItem: ({
      children,
      onClick,
      disabled
    }: {
      children?: ReactNode
      onClick?: () => void
      disabled?: boolean
    }) => (
      <button role="menuitem" disabled={disabled} onClick={onClick}>
        {children}
      </button>
    )
  }
})

vi.mock('@/components/ui/dropdown-menu', () => {
  const Nothing = (): null => null
  return {
    DropdownMenu: Nothing,
    DropdownMenuTrigger: Nothing,
    DropdownMenuContent: Nothing,
    DropdownMenuItem: Nothing,
    DropdownMenuSeparator: Nothing
  }
})

import { ConnectionList } from '../ConnectionList'
import { useConnectionStore } from '@/stores/useConnectionStore'
import { useProjectStore } from '@/stores/useProjectStore'
import { useWorktreeStore } from '@/stores/useWorktreeStore'

type Connection = ReturnType<typeof useConnectionStore.getState>['connections'][number]
type ArchiveResult = { success: boolean; error?: string }

const member = (projectId: string): Connection['members'][number] => ({
  id: `member-${projectId}`,
  connection_id: 'conn-1',
  worktree_id: `wt-${projectId}`,
  project_id: projectId,
  symlink_name: projectId,
  added_at: '2026-01-01',
  worktree_name: `wt-${projectId}`,
  worktree_branch: `branch-${projectId}`,
  worktree_path: `/tmp/${projectId}/wt`,
  project_name: projectId
})

const makeConnection = (): Connection => ({
  id: 'conn-1',
  name: 'alpha + beta',
  custom_name: null,
  status: 'active',
  path: '/tmp/conn-1',
  color: null,
  saved_project_id: null,
  is_base: 0,
  created_at: '2026-01-01',
  updated_at: '2026-01-01',
  members: [member('alpha'), member('beta')]
})

const statusText = (): string | null => screen.getByTestId('connection-status-text').textContent

describe('ConnectionList — archiving a connection', () => {
  /** What the server holds: a member leaves as its archive starts, the last one deletes it. */
  let serverConnections: Connection[]
  /** One per archiveWorktree call, in order: the test ends each archive itself. */
  let archives: { worktreeId: string; finish: (result: ArchiveResult) => void }[]
  let originalArchiveWorktree: ReturnType<typeof useWorktreeStore.getState>['archiveWorktree']
  let originalProjects: ReturnType<typeof useProjectStore.getState>['projects']

  beforeEach(() => {
    serverConnections = [makeConnection()]
    archives = []
    setRendererRpcClient({
      request: vi.fn(async (method: string) =>
        method === 'connectionOps.getAll'
          ? { success: true, connections: serverConnections }
          : null
      ) as never,
      subscribe: vi.fn()
    })

    originalArchiveWorktree = useWorktreeStore.getState().archiveWorktree
    originalProjects = useProjectStore.getState().projects
    useProjectStore.setState({
      projects: ['alpha', 'beta'].map((id) => ({ id, name: id, path: `/tmp/${id}` }))
    } as never)
    useWorktreeStore.setState({
      archiveWorktree: vi.fn(async (worktreeId: string) => {
        serverConnections = serverConnections
          .map((c) => ({ ...c, members: c.members.filter((m) => m.worktree_id !== worktreeId) }))
          .filter((c) => c.members.length > 0)
        await useConnectionStore.getState().loadConnections()
        return new Promise<ArchiveResult>((finish) => archives.push({ worktreeId, finish }))
      })
    } as never)
    useConnectionStore.setState({ connections: [], archivingConnections: {} })
  })

  afterEach(() => {
    cleanup()
    useWorktreeStore.setState({ archiveWorktree: originalArchiveWorktree })
    useProjectStore.setState({ projects: originalProjects })
    useConnectionStore.setState({ connections: [], archivingConnections: {} })
    resetRendererRpcClientForTests()
  })

  const archiveAll = async (): Promise<void> => {
    render(
      <TooltipProvider>
        <ConnectionList />
      </TooltipProvider>
    )
    await screen.findByTestId('connection-item-conn-1')
    fireEvent.click(screen.getByRole('menuitem', { name: 'Archive All' }))
    await waitFor(() => expect(archives).toHaveLength(1))
  }

  it('reads "Archiving x/y" on the dimmed row until the last worktree is gone', async () => {
    await archiveAll()

    const row = screen.getByTestId('connection-item-conn-1')
    expect(statusText()).toBe('Archiving 1/2')
    expect(row).toHaveAttribute('data-connection-archiving')
    expect(row).toHaveClass('opacity-50', 'pointer-events-none')
    // Nothing starts a second archive while this one runs
    expect(screen.getByRole('menuitem', { name: 'Archive All' })).toBeDisabled()
    // The first member has left the connection already: the row still names both
    expect(useConnectionStore.getState().connections[0].members).toHaveLength(1)
    expect(row).toHaveTextContent('alpha + beta')

    archives[0].finish({ success: true })
    await waitFor(() => expect(statusText()).toBe('Archiving 2/2'))
    // The last member took the connection with it, and the row stays while it is archived
    expect(archives.map((a) => a.worktreeId)).toEqual(['wt-alpha', 'wt-beta'])
    expect(useConnectionStore.getState().connections).toEqual([])
    expect(screen.getByTestId('connection-item-conn-1')).toHaveTextContent('alpha + beta')

    archives[1].finish({ success: true })
    await waitFor(() =>
      expect(screen.queryByTestId('connection-item-conn-1')).not.toBeInTheDocument()
    )
    expect(useConnectionStore.getState().archivingConnections).toEqual({})
  })

  it('counts a worktree that failed to archive and ends the batch after the last one', async () => {
    await archiveAll()

    archives[0].finish({ success: false, error: 'locked' })
    await waitFor(() => expect(statusText()).toBe('Archiving 2/2'))

    archives[1].finish({ success: false, error: 'locked' })
    await waitFor(() => expect(useConnectionStore.getState().archivingConnections).toEqual({}))
  })
})
