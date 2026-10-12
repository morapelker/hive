/**
 * The ways into the "Implement document" wizard from outside this folder: the project context
 * menu, the connection rows and the command palette. Git and connection projects both have
 * them; an ad-hoc connection is saved as a project on the way in.
 */
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setRendererRpcClient } from '@/api/rpc-client'
import { ConnectionItem } from '@/components/connections/ConnectionItem'
import { ProjectItem } from '@/components/projects/ProjectItem'
import { TooltipProvider } from '@/components/ui/tooltip'
import { useCommands } from '@/hooks/useCommands'
import { commandRegistry } from '@/lib/command-registry'
import { useCommandPaletteStore } from '@/stores/useCommandPaletteStore'
import { useConnectionStore } from '@/stores/useConnectionStore'
import { useDocumentFlowStore } from '@/stores/useDocumentFlowStore'
import { useHintStore } from '@/stores/useHintStore'
import { useProjectStore } from '@/stores/useProjectStore'
import { useSettingsStore } from '@/stores/useSettingsStore'
import { useWorktreeStore } from '@/stores/useWorktreeStore'

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

const initialFlowState = useDocumentFlowStore.getState()
const initialConnectionState = useConnectionStore.getState()

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

describe('command palette', () => {
  function CommandsHarness(): null {
    useCommands()
    return null
  }

  /** Register the commands and let the hook's own startup requests settle. */
  async function registerCommands(): Promise<void> {
    await act(async () => {
      render(<CommandsHarness />)
    })
  }

  const command = (id: string) => {
    const found = commandRegistry.get(id)
    if (!found) throw new Error(`Command ${id} is not registered`)
    return found
  }

  it.each(['action:implement-document', 'action:document-runs'])(
    '%s opens the wizard on the selected git project and closes the palette',
    async (id) => {
      useProjectStore.setState({ selectedProjectId: 'alpha' })
      useCommandPaletteStore.setState({ isOpen: true })
      await registerCommands()

      expect(command(id).isEnabled?.()).toBe(true)
      await act(async () => {
        await command(id).action()
      })

      expect(useDocumentFlowStore.getState().wizard).toEqual({
        open: true,
        projectId: 'alpha',
        runId: null
      })
      expect(useCommandPaletteStore.getState().isOpen).toBe(false)
    }
  )

  it.each(['action:implement-document', 'action:document-runs'])(
    '%s opens the wizard on a selected connection project too',
    async (id) => {
      useProjectStore.setState({ selectedProjectId: 'linked' })
      await registerCommands()

      expect(command(id).isEnabled?.()).toBe(true)
      await act(async () => {
        await command(id).action()
      })

      expect(useDocumentFlowStore.getState().wizard).toMatchObject({
        open: true,
        projectId: 'linked'
      })
    }
  )

  it.each(['action:implement-document', 'action:document-runs'])(
    "%s uses the selected instance's connection project when no project is selected",
    async (id) => {
      useConnectionStore.setState({
        selectedConnectionId: 'conn-1',
        connections: [connection({ saved_project_id: 'linked' })]
      })
      await registerCommands()

      expect(command(id).isEnabled?.()).toBe(true)
      await act(async () => {
        await command(id).action()
      })

      expect(useDocumentFlowStore.getState().wizard).toMatchObject({
        open: true,
        projectId: 'linked'
      })
    }
  )

  it.each(['action:implement-document', 'action:document-runs'])(
    '%s is disabled without a project and on an ad-hoc connection',
    async (id) => {
      await registerCommands()
      expect(command(id).isEnabled?.()).toBe(false)

      await act(async () => {
        useConnectionStore.setState({ selectedConnectionId: 'conn-1', connections: [connection()] })
      })
      expect(command(id).isEnabled?.()).toBe(false)
      // Even if it is run anyway, nothing opens.
      await act(async () => {
        await command(id).action()
      })
      expect(useDocumentFlowStore.getState().wizard.open).toBe(false)
    }
  )

  it('offers both commands with an icon the palette can draw', async () => {
    await registerCommands()

    expect(command('action:implement-document')).toMatchObject({
      label: 'Implement document…',
      icon: 'FileText'
    })
    expect(command('action:document-runs')).toMatchObject({
      label: 'Document runs',
      icon: 'History'
    })
  })
})

// Last in the file: opening a Radix menu is slow under jsdom, and so is tearing it down.
describe('project context menu', () => {
  it('opens the wizard for the project', async () => {
    const user = userEvent.setup()
    render(<ProjectItem project={project('alpha')} />)

    fireEvent.contextMenu(screen.getByTestId('project-item-alpha'))
    await user.click(await screen.findByRole('menuitem', { name: 'Implement Document…' }))

    expect(useDocumentFlowStore.getState().wizard).toEqual({
      open: true,
      projectId: 'alpha',
      runId: null
    })
  })

  it('opens it for a connection project as well', async () => {
    const user = userEvent.setup()
    render(<ProjectItem project={project('linked', 'connection')} />)

    fireEvent.contextMenu(screen.getByTestId('project-item-linked'))
    await user.click(screen.getByTestId('docflow-project-menu-item'))

    expect(useDocumentFlowStore.getState().wizard).toEqual({
      open: true,
      projectId: 'linked',
      runId: null
    })
  })
})

describe('connection row context menu', () => {
  it("opens the wizard for an instance's connection project", async () => {
    const user = userEvent.setup()
    const instance = connection({ saved_project_id: 'linked' })
    useConnectionStore.setState({ connections: [instance] })
    render(
      <TooltipProvider>
        <ConnectionItem connection={instance} />
      </TooltipProvider>
    )

    fireEvent.contextMenu(screen.getByTestId('connection-item-conn-1'))
    await user.click(screen.getByTestId('docflow-connection-menu-item'))

    expect(useDocumentFlowStore.getState().wizard).toEqual({
      open: true,
      projectId: 'linked',
      runId: null
    })
  })

  it('saves an ad-hoc connection as a project first, then opens the wizard on it', async () => {
    const user = userEvent.setup()
    const adHoc = connection()
    const saveConnectionAsProject = vi.fn(async () => 'proj-new')
    useConnectionStore.setState({ connections: [adHoc], saveConnectionAsProject })
    render(
      <TooltipProvider>
        <ConnectionItem connection={adHoc} />
      </TooltipProvider>
    )

    fireEvent.contextMenu(screen.getByTestId('connection-item-conn-1'))
    await user.click(screen.getByTestId('docflow-connection-menu-item'))

    expect(saveConnectionAsProject).toHaveBeenCalledWith('conn-1')
    expect(useDocumentFlowStore.getState().wizard).toEqual({
      open: true,
      projectId: 'proj-new',
      runId: null
    })
  })

  it('opens nothing when saving the ad-hoc connection fails', async () => {
    const user = userEvent.setup()
    const adHoc = connection()
    useConnectionStore.setState({ connections: [adHoc], saveConnectionAsProject: async () => null })
    render(
      <TooltipProvider>
        <ConnectionItem connection={adHoc} />
      </TooltipProvider>
    )

    fireEvent.contextMenu(screen.getByTestId('connection-item-conn-1'))
    await user.click(screen.getByTestId('docflow-connection-menu-item'))

    expect(useDocumentFlowStore.getState().wizard.open).toBe(false)
  })

  it('has no such item on an ad-hoc connection with a single member project', () => {
    const single = connection({ members: [member('alpha', 'wt-a'), member('alpha', 'wt-b')] })
    useConnectionStore.setState({ connections: [single] })
    render(
      <TooltipProvider>
        <ConnectionItem connection={single} />
      </TooltipProvider>
    )

    fireEvent.contextMenu(screen.getByTestId('connection-item-conn-1'))

    expect(screen.getByRole('menuitem', { name: 'Copy Path' })).toBeInTheDocument()
    expect(screen.queryByTestId('docflow-connection-menu-item')).toBeNull()
  })
})
