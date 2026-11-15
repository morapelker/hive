/**
 * The project context menu offers "Pin to board", or "Unpin from board" when any worktree
 * (or instance) of the project is pinned. Both run the project pin action (lib/project-pin).
 */
import type { ReactNode } from 'react'
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, cleanup, fireEvent, waitFor, act } from '@testing-library/react'

const toastMock = vi.hoisted(() => ({
  success: vi.fn(),
  error: vi.fn(),
  loading: vi.fn(),
  dismiss: vi.fn(),
  info: vi.fn(),
  warning: vi.fn()
}))
vi.mock('@/lib/toast', () => ({ toast: toastMock, gitToast: {} }))

// The menu drawn in place, always open: a Radix menu blocks jsdom for ten seconds and more
// each time it opens, and this file is about which item is there and what it does.
vi.mock('@/components/ui/context-menu', () => {
  interface ItemProps {
    children?: ReactNode
    onClick?: () => void
    'data-testid'?: string
  }
  const Passthrough = ({ children }: { children?: ReactNode }) => <>{children}</>
  const Item = ({ children, onClick, ...rest }: ItemProps) => (
    <div role="menuitem" data-testid={rest['data-testid']} onClick={onClick}>
      {children}
    </div>
  )
  return {
    ContextMenu: Passthrough,
    ContextMenuTrigger: Passthrough,
    ContextMenuContent: ({ children }: { children?: ReactNode }) => (
      <div role="menu">{children}</div>
    ),
    ContextMenuItem: Item,
    ContextMenuCheckboxItem: Item,
    ContextMenuSeparator: () => <hr />,
    ContextMenuSub: Passthrough,
    ContextMenuSubTrigger: Item,
    ContextMenuSubContent: Passthrough
  }
})

import { setRendererRpcClient } from '@/api/rpc-client'
import { ProjectItem } from './ProjectItem'
import { useProjectStore } from '@/stores/useProjectStore'
import { useWorktreeStore } from '@/stores/useWorktreeStore'
import { useConnectionStore } from '@/stores/useConnectionStore'
import { usePinnedStore } from '@/stores/usePinnedStore'
import { useHintStore } from '@/stores/useHintStore'
import { useSettingsStore } from '@/stores/useSettingsStore'

const project = (id: string, kind?: 'git' | 'connection') => ({
  id,
  name: id,
  path: `/tmp/${id}`,
  ...(kind ? { kind } : {}),
  description: null,
  tags: null,
  language: null,
  custom_icon: null,
  detected_icon: 'none',
  setup_script: null,
  run_script: null,
  archive_script: null,
  auto_assign_port: false,
  sort_order: 0,
  created_at: '2026-01-01',
  last_accessed_at: '2026-01-01'
})

const worktreeRow = (id: string, projectId: string, isDefault: boolean) => ({
  id,
  project_id: projectId,
  name: id,
  branch_name: isDefault ? 'main' : id,
  path: `/tmp/${projectId}/${id}`,
  status: 'active',
  is_default: isDefault,
  created_at: '2026-01-01',
  last_accessed_at: '2026-01-01'
})

const baseInstance = {
  id: 'stack-base',
  name: 'stack-base',
  status: 'active',
  path: '/tmp/connections/stack-base',
  pinned: 0,
  saved_project_id: 'stack',
  is_base: 1,
  members: []
}

const pinWrites: Array<{ method: string; params: unknown }> = []
const pinnedInDatabase = new Set<string>()

const pinItem = (): HTMLElement => screen.getByTestId('project-pin-to-board-menu-item')

describe('ProjectItem "Pin to board" context menu item', () => {
  beforeEach(() => {
    cleanup()
    vi.clearAllMocks()
    pinWrites.length = 0
    pinnedInDatabase.clear()
    setRendererRpcClient({
      request: async <T,>(method: string, params?: unknown): Promise<T> => {
        const p = (params ?? {}) as Record<string, unknown>
        if (method === 'db.worktree.getActiveByProject') {
          return [
            worktreeRow(`${p.projectId}-feature`, p.projectId as string, false),
            worktreeRow(`${p.projectId}-main`, p.projectId as string, true)
          ] as T
        }
        if (method === 'db.worktree.getPinned') {
          return [...pinnedInDatabase].map((id) => ({
            id,
            project_id: id.replace(/-(main|feature)$/, '')
          })) as T
        }
        if (method === 'connectionOps.getPinned') return [] as T
        if (method === 'connectionOps.getAll') {
          return { success: true, connections: [baseInstance] } as T
        }
        if (method === 'db.worktree.setPinned' || method === 'connectionOps.setPinned') {
          pinWrites.push({ method, params })
          const id = (p.worktreeId ?? p.connectionId) as string
          if (p.pinned) pinnedInDatabase.add(id)
          else pinnedInDatabase.delete(id)
        }
        return { success: true } as T
      },
      subscribe: () => () => {}
    })
    useSettingsStore.setState({ tipsEnabled: false })
    useProjectStore.setState({ expandedProjectIds: new Set(), selectedProjectId: null })
    useWorktreeStore.setState({
      worktreesByProject: new Map(),
      loadedProjectIds: new Set(),
      worktreeOrderByProject: new Map()
    })
    useConnectionStore.setState({ connectionModeActive: false, connections: [] })
    useHintStore.setState({ filterActive: false, inputFocused: false })
    usePinnedStore.setState({
      pinnedWorktreeIds: new Set(),
      pinnedConnectionIds: new Set(),
      pinnedProjectIds: new Set(),
      loaded: true
    })
  })

  it('pins a never-expanded git project, then reads "Unpin from board" and unpins it', async () => {
    render(<ProjectItem project={project('alpha')} />)

    expect(pinItem()).toHaveTextContent('Pin to board')
    fireEvent.click(pinItem())

    await waitFor(() => expect(toastMock.success).toHaveBeenCalledWith('Pinned alpha'))
    expect(pinWrites).toEqual([
      { method: 'db.worktree.setPinned', params: { worktreeId: 'alpha-main', pinned: true } }
    ])
    expect(usePinnedStore.getState().pinnedProjectIds.has('alpha')).toBe(true)
    // Pinning neither opens nor expands the project
    expect(useProjectStore.getState().selectedProjectId).toBeNull()
    expect(useProjectStore.getState().expandedProjectIds.has('alpha')).toBe(false)
    expect(useWorktreeStore.getState().selectedWorktreeId).toBeNull()

    expect(pinItem()).toHaveTextContent('Unpin from board')
    fireEvent.click(pinItem())

    await waitFor(() => expect(toastMock.success).toHaveBeenCalledWith('Unpinned alpha'))
    expect(pinWrites).toHaveLength(2)
    expect(pinWrites[1]).toEqual({
      method: 'db.worktree.setPinned',
      params: { worktreeId: 'alpha-main', pinned: false }
    })
    expect(usePinnedStore.getState().pinnedProjectIds.has('alpha')).toBe(false)

    expect(pinItem()).toHaveTextContent('Pin to board')
  })

  it('reads "Unpin from board" after one worktree was pinned from its own menu', async () => {
    await useWorktreeStore.getState().loadWorktrees('alpha', { force: true })
    render(<ProjectItem project={project('alpha')} />)

    // What the worktree's own Pin does
    await act(() => usePinnedStore.getState().pinWorktree('alpha-feature'))

    expect(pinItem()).toHaveTextContent('Unpin from board')
  })

  it('is offered for a connection project and pins its base instance', async () => {
    render(<ProjectItem project={project('stack', 'connection')} />)

    expect(pinItem()).toHaveTextContent('Pin to board')
    fireEvent.click(pinItem())

    await waitFor(() => expect(toastMock.success).toHaveBeenCalledWith('Pinned stack'))
    expect(pinWrites).toEqual([
      { method: 'connectionOps.setPinned', params: { connectionId: 'stack-base', pinned: true } }
    ])
    expect(usePinnedStore.getState().pinnedConnectionIds.has('stack-base')).toBe(true)

    expect(pinItem()).toHaveTextContent('Unpin from board')
  })
})
