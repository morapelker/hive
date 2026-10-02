import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
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

import { ConnectionItem } from '../ConnectionItem'
import { useConnectionStore } from '@/stores/useConnectionStore'

type Connection = ReturnType<typeof useConnectionStore.getState>['connections'][number]

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

const makeConnection = (overrides: Partial<Connection> = {}): Connection => ({
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
  members: [member('alpha'), member('beta')],
  ...overrides
})

function renderItem(connection: Connection): void {
  render(
    <TooltipProvider>
      <ConnectionItem connection={connection} />
    </TooltipProvider>
  )
}

describe('ConnectionItem — Duplicate', () => {
  let duplicateConnection: ReturnType<typeof vi.fn>
  let originalDuplicateConnection: ReturnType<
    typeof useConnectionStore.getState
  >['duplicateConnection']

  beforeEach(() => {
    setRendererRpcClient({ request: vi.fn(async () => null) as never, subscribe: vi.fn() })
    originalDuplicateConnection = useConnectionStore.getState().duplicateConnection
    duplicateConnection = vi.fn().mockResolvedValue('conn-2')
    useConnectionStore.setState({ duplicateConnection } as never)
  })

  afterEach(() => {
    cleanup()
    useConnectionStore.setState({ duplicateConnection: originalDuplicateConnection })
    resetRendererRpcClientForTests()
  })

  it('offers Duplicate on right-click and duplicates the connection', () => {
    renderItem(makeConnection())

    fireEvent.contextMenu(screen.getByTestId('connection-item-conn-1'))
    fireEvent.click(screen.getByText('Duplicate'))

    expect(duplicateConnection).toHaveBeenCalledTimes(1)
    expect(duplicateConnection).toHaveBeenCalledWith('conn-1')
  })

  it('offers Duplicate on the base instance of a connection project', () => {
    renderItem(makeConnection({ saved_project_id: 'proj-1', is_base: 1 }))

    fireEvent.contextMenu(screen.getByTestId('connection-item-conn-1'))

    expect(screen.getByText('Duplicate')).not.toHaveAttribute('data-disabled')
    // The base instance still can't be renamed or deleted
    expect(screen.queryByText('Rename')).not.toBeInTheDocument()
  })

  it('disables Duplicate when the connection spans fewer than two projects', () => {
    renderItem(makeConnection({ members: [member('alpha')] }))

    fireEvent.contextMenu(screen.getByTestId('connection-item-conn-1'))

    expect(screen.getByText('Duplicate')).toHaveAttribute('data-disabled')
  })
})
