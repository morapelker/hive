import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, cleanup, act } from '@testing-library/react'
import React from 'react'
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

import { PinnedList } from './PinnedList'
import { usePinnedStore } from '@/stores/usePinnedStore'
import { useConnectionStore } from '@/stores/useConnectionStore'
import { useProjectStore } from '@/stores/useProjectStore'
import { useSessionStore, type Session } from '@/stores/useSessionStore'
import { useWorktreeStatusStore } from '@/stores/useWorktreeStatusStore'

type Connection = ReturnType<typeof useConnectionStore.getState>['connections'][number]
type Project = ReturnType<typeof useProjectStore.getState>['projects'][number]

function makeConnection(overrides: Partial<Connection>): Connection {
  return {
    id: 'conn',
    name: 'connection',
    custom_name: null,
    status: 'active',
    path: '/tmp/conn',
    color: null,
    saved_project_id: null,
    is_base: 0,
    created_at: '2026-01-01',
    updated_at: '2026-01-01',
    members: [],
    ...overrides
  } as Connection
}

const baseMembers = [
  { project_name: 'alpha', worktree_branch: 'main' },
  { project_name: 'beta', worktree_branch: 'main' }
] as Connection['members']

describe('PinnedList — pinned connection project base card', () => {
  beforeEach(() => {
    const request = vi.fn(async (method: string) => {
      if (method === 'db.worktree.getPinned') return []
      if (method === 'connectionOps.getPinned') {
        return [{ id: 'base-1', saved_project_id: 'proj-1', is_base: 1, members: [] }]
      }
      return null
    })
    setRendererRpcClient({ request, subscribe: vi.fn() })

    usePinnedStore.setState({
      pinnedWorktreeIds: new Set(),
      pinnedConnectionIds: new Set(['base-1']),
      pinnedProjectIds: new Set(['proj-1']),
      loaded: true
    })
    useConnectionStore.setState({
      connections: [
        makeConnection({
          id: 'base-1',
          saved_project_id: 'proj-1',
          is_base: 1,
          members: baseMembers
        }),
        makeConnection({
          id: 'inst-1',
          saved_project_id: 'proj-1',
          custom_name: 'feature-a'
        })
      ]
    })
    useProjectStore.setState({
      projects: [{ id: 'proj-1', name: 'my-conn-proj', kind: 'connection' } as unknown as Project]
    })
    useSessionStore.setState({
      sessionsByConnection: new Map([['inst-1', [{ id: 's1' } as unknown as Session]]])
    })
    useWorktreeStatusStore.setState({
      sessionStatuses: { s1: { status: 'working', timestamp: 1 } }
    })
  })

  afterEach(() => {
    cleanup()
    resetRendererRpcClientForTests()
  })

  async function renderList(): Promise<void> {
    render(
      <TooltipProvider>
        <PinnedList />
      </TooltipProvider>
    )
    // Flush the mount-effect loadPinned() so its state update lands inside act
    await act(async () => {})
  }

  it('titles the base card "project › main" instead of bare "main"', async () => {
    await renderList()

    const card = screen.getByTestId('pinned-connection-base-1')
    expect(card.textContent).toContain('my-conn-proj')
    expect(card.textContent).toContain('main')
  })

  it('shows a working sibling chip when another instance of the project is working', async () => {
    await renderList()

    const chip = screen.getByTestId('pinned-sibling-working')
    expect(chip.textContent).toContain('1')
    expect(chip.querySelector('.agent-working-spinner')).not.toBeNull()
  })

  it('hides sibling chips when no sibling instance has an active status', async () => {
    useWorktreeStatusStore.setState({ sessionStatuses: {} })
    await renderList()

    expect(screen.queryByTestId('pinned-sibling-working')).toBeNull()
    expect(screen.queryByTestId('pinned-sibling-ready')).toBeNull()
    expect(screen.queryByTestId('pinned-sibling-waiting')).toBeNull()
  })
})
