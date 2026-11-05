/**
 * "Orchestrate tickets…" sits next to every "Implement Document…" with the same gating, and
 * opens the same wizard on the project's board tickets: the project context menu (git and
 * connection projects), the connection rows (an ad-hoc connection is saved as a project on the
 * way in), the sidebar worktree menu and the command palette. The document path's wizard state
 * is unchanged (see entry-points.test.tsx); this one adds `source: 'tickets'`.
 */
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { setRendererRpcClient } from '@/api/rpc-client'
import { ConnectionItem } from '@/components/connections/ConnectionItem'
import { ProjectItem } from '@/components/projects/ProjectItem'
import { TooltipProvider } from '@/components/ui/tooltip'
import { WorktreeItem } from '@/components/worktrees/WorktreeItem'
import { useCommands } from '@/hooks/useCommands'
import { commandRegistry } from '@/lib/command-registry'
import { useCommandPaletteStore } from '@/stores/useCommandPaletteStore'
import { useConnectionStore } from '@/stores/useConnectionStore'
import { useDocumentFlowStore } from '@/stores/useDocumentFlowStore'
import { useHintStore } from '@/stores/useHintStore'
import { useProjectStore } from '@/stores/useProjectStore'
import { useSettingsStore } from '@/stores/useSettingsStore'
import { useWorktreeStore } from '@/stores/useWorktreeStore'
import type { Worktree } from '../../../../main/db/types'

vi.mock('@/lib/toast', () => ({
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() }
}))

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
  worktree_create_script: null,
  custom_commands: null,
  auto_assign_port: false,
  sort_order: 0,
  created_at: '2026-01-01',
  last_accessed_at: '2026-01-01'
})

type Connection = ReturnType<typeof useConnectionStore.getState>['connections'][number]

const member = (projectId: string, worktreeId: string) => ({
  id: `member-${worktreeId}`,
  connection_id: 'conn-1',
  worktree_id: worktreeId,
  added_at: '2026-01-01',
  project_id: projectId,
  symlink_name: projectId,
  worktree_name: 'main',
  worktree_branch: 'main',
  worktree_path: `/tmp/${projectId}`,
  project_name: projectId
})

const connection = (overrides: Partial<Connection> = {}): Connection =>
  ({
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
    members: [member('alpha', 'wt-alpha'), member('beta', 'wt-beta')],
    ...overrides
  }) as unknown as Connection

const worktree = {
  id: 'wt-feature',
  project_id: 'alpha',
  name: 'feature',
  branch_name: 'feature',
  path: '/tmp/alpha-feature',
  status: 'active' as const,
  is_default: false,
  created_at: '2026-01-01',
  last_accessed_at: '2026-01-01',
  attachments: '[]'
} as unknown as Worktree

const ORCHESTRATE_ALPHA = { open: true, projectId: 'alpha', runId: null, source: 'tickets' }

// floating-ui probes every positioned element with matches(':popover-open') and
// matches(':modal'); jsdom recurses on them for seconds per menu. Answer them directly.
const TOP_LAYER_PROBES = new Set([':popover-open', ':modal'])
const originalMatches = Element.prototype.matches

const initialFlowState = useDocumentFlowStore.getState()
const initialConnectionState = useConnectionStore.getState()

beforeAll(() => {
  Element.prototype.matches = function (this: Element, selectors: string): boolean {
    return TOP_LAYER_PROBES.has(selectors) ? false : originalMatches.call(this, selectors)
  }
})

afterAll(() => {
  Element.prototype.matches = originalMatches
})

beforeEach(() => {
  setRendererRpcClient({
    request: async <T,>(): Promise<T> => ({ success: true }) as T,
    subscribe: () => () => {}
  })
  useSettingsStore.setState({ tipsEnabled: false })
  useProjectStore.setState({
    projects: [project('alpha'), project('linked', 'connection')],
    expandedProjectIds: new Set(),
    selectedProjectId: null
  })
  useWorktreeStore.setState({
    worktreesByProject: new Map(),
    loadedProjectIds: new Set(),
    worktreeOrderByProject: new Map()
  })
  useConnectionStore.setState({
    connectionModeActive: false,
    selectedConnectionId: null,
    connections: []
  })
  useHintStore.setState({ filterActive: false, inputFocused: false })
})

afterEach(() => {
  cleanup()
  useDocumentFlowStore.setState(initialFlowState, true)
  useConnectionStore.setState(initialConnectionState, true)
  useCommandPaletteStore.setState({ isOpen: false })
})

/** The menu items now rendered, by their text (role queries are slow on these trees). */
const menuItemNames = (): string[] =>
  Array.from(document.querySelectorAll<HTMLElement>('[role="menuitem"]')).map(
    (item) => item.textContent ?? ''
  )

describe('command palette', () => {
  function CommandsHarness(): null {
    useCommands()
    return null
  }

  const command = () => {
    const found = commandRegistry.get('action:orchestrate-tickets')
    if (!found) throw new Error('action:orchestrate-tickets is not registered')
    return found
  }

  it('opens the wizard on the board tickets of the selected project and closes the palette', async () => {
    useProjectStore.setState({ selectedProjectId: 'alpha' })
    useCommandPaletteStore.setState({ isOpen: true })
    await act(async () => {
      render(<CommandsHarness />)
    })

    expect(command()).toMatchObject({ label: 'Orchestrate tickets…', icon: 'KanbanIcon' })
    expect(command().keywords).toEqual(expect.arrayContaining(['orchestrator', 'tickets', 'merge']))
    expect(command().isEnabled?.()).toBe(true)
    await act(async () => {
      await command().action()
    })

    expect(useDocumentFlowStore.getState().wizard).toEqual(ORCHESTRATE_ALPHA)
    expect(useCommandPaletteStore.getState().isOpen).toBe(false)
  })

  it("uses the selected instance's connection project, and is disabled without a project", async () => {
    await act(async () => {
      render(<CommandsHarness />)
    })
    expect(command().isEnabled?.()).toBe(false)
    await act(async () => {
      await command().action()
    })
    expect(useDocumentFlowStore.getState().wizard.open).toBe(false)

    await act(async () => {
      useConnectionStore.setState({
        selectedConnectionId: 'conn-1',
        connections: [connection({ saved_project_id: 'linked' })]
      })
    })
    expect(command().isEnabled?.()).toBe(true)
    await act(async () => {
      await command().action()
    })
    expect(useDocumentFlowStore.getState().wizard).toEqual({
      open: true,
      projectId: 'linked',
      runId: null,
      source: 'tickets'
    })
  })
})

describe('project context menu', () => {
  it.each([
    ['a git project', 'alpha', undefined],
    ['a connection project', 'linked', 'connection' as const]
  ])('offers it right after "Implement Document…" on %s', (_label, id, kind) => {
    render(<ProjectItem project={project(id, kind)} />)

    fireEvent.contextMenu(screen.getByTestId(`project-item-${id}`))
    const names = menuItemNames()
    expect(names[names.indexOf('Implement Document…') + 1]).toBe('Orchestrate tickets…')

    fireEvent.click(screen.getByTestId('docflow-orchestrate-project-menu-item'))
    expect(useDocumentFlowStore.getState().wizard).toEqual({
      open: true,
      projectId: id,
      runId: null,
      source: 'tickets'
    })
  })
})

describe('connection row context menu', () => {
  const renderRow = (row: Connection): void => {
    render(
      <TooltipProvider>
        <ConnectionItem connection={row} />
      </TooltipProvider>
    )
  }

  it("opens it on an instance's connection project", () => {
    const instance = connection({ saved_project_id: 'linked' })
    useConnectionStore.setState({ connections: [instance] })
    renderRow(instance)

    fireEvent.contextMenu(screen.getByTestId('connection-item-conn-1'))
    const names = menuItemNames()
    expect(names[names.indexOf('Implement Document…') + 1]).toBe('Orchestrate tickets…')
    fireEvent.click(screen.getByTestId('docflow-orchestrate-connection-menu-item'))

    expect(useDocumentFlowStore.getState().wizard).toEqual({
      open: true,
      projectId: 'linked',
      runId: null,
      source: 'tickets'
    })
  })

  it('saves an ad-hoc connection as a project first, as "Implement Document…" does', async () => {
    const adHoc = connection()
    const saveConnectionAsProject = vi.fn(async () => 'proj-new')
    useConnectionStore.setState({ connections: [adHoc], saveConnectionAsProject })
    renderRow(adHoc)

    fireEvent.contextMenu(screen.getByTestId('connection-item-conn-1'))
    await act(async () => {
      fireEvent.click(screen.getByTestId('docflow-orchestrate-connection-menu-item'))
    })

    expect(saveConnectionAsProject).toHaveBeenCalledWith('conn-1')
    expect(useDocumentFlowStore.getState().wizard).toEqual({
      open: true,
      projectId: 'proj-new',
      runId: null,
      source: 'tickets'
    })
  })

  it('is not offered where "Implement Document…" is not', () => {
    const single = connection({ members: [member('alpha', 'wt-a'), member('alpha', 'wt-b')] })
    useConnectionStore.setState({ connections: [single] })
    renderRow(single)

    fireEvent.contextMenu(screen.getByTestId('connection-item-conn-1'))

    expect(menuItemNames()).toContain('Copy Path')
    expect(screen.queryByTestId('docflow-orchestrate-connection-menu-item')).toBeNull()
  })
})

describe('sidebar worktree context menu', () => {
  it('offers it next to "Implement Document…" for a git project', () => {
    render(<WorktreeItem worktree={worktree} projectPath="/tmp/alpha" />)

    fireEvent.contextMenu(screen.getByTestId('worktree-item-wt-feature'))
    const names = menuItemNames()
    expect(names[names.indexOf('Implement Document…') + 1]).toBe('Orchestrate tickets…')
    fireEvent.click(screen.getByTestId('docflow-orchestrate-worktree-menu-item'))

    expect(useDocumentFlowStore.getState().wizard).toEqual(ORCHESTRATE_ALPHA)
  })
})
