import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, cleanup, act } from '@testing-library/react'
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

// The inline rename input is measured with a ResizeObserver, which jsdom lacks.
class ResizeObserverStub {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
;(globalThis as unknown as { ResizeObserver: typeof ResizeObserverStub }).ResizeObserver =
  ResizeObserverStub

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
  custom_name: 'My feature',
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

function renderItems(...connections: Connection[]): void {
  render(
    <TooltipProvider>
      {connections.map((connection, i) => (
        <ConnectionItem key={`${connection.id}-${i}`} connection={connection} />
      ))}
    </TooltipProvider>
  )
}

describe('ConnectionItem — rename shortcut', () => {
  beforeEach(() => {
    setRendererRpcClient({ request: vi.fn(async () => null) as never, subscribe: vi.fn() })
    useConnectionStore.setState({ pendingRenameConnectionId: null })
  })

  afterEach(() => {
    cleanup()
    useConnectionStore.setState({ pendingRenameConnectionId: null })
    resetRendererRpcClientForTests()
  })

  it('starts the inline rename, prefilled, when the shortcut requests it', () => {
    renderItems(makeConnection())
    expect(screen.queryByDisplayValue('My feature')).not.toBeInTheDocument()

    act(() => useConnectionStore.getState().requestConnectionRename('conn-1'))

    expect(screen.getByDisplayValue('My feature')).toBeInTheDocument()
    // The request is consumed, so it can't fire again later
    expect(useConnectionStore.getState().pendingRenameConnectionId).toBeNull()
  })

  it('renames only one row when the same connection is shown twice', () => {
    renderItems(makeConnection(), makeConnection())

    act(() => useConnectionStore.getState().requestConnectionRename('conn-1'))

    expect(screen.getAllByDisplayValue('My feature')).toHaveLength(1)
  })

  it('ignores requests for other connections', () => {
    renderItems(makeConnection())

    act(() => useConnectionStore.getState().requestConnectionRename('conn-other'))

    expect(screen.queryByDisplayValue('My feature')).not.toBeInTheDocument()
    expect(useConnectionStore.getState().pendingRenameConnectionId).toBe('conn-other')
  })

  it("leaves a connection project's base instance alone", () => {
    renderItems(makeConnection({ saved_project_id: 'proj-1', is_base: 1 }))

    act(() => useConnectionStore.getState().requestConnectionRename('conn-1'))

    expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
  })
})
