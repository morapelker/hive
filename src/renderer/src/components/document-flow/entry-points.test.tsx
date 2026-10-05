/**
 * The ways into the "Implement document" wizard from outside this folder: the project context
 * menu and the command palette. Both are for git projects only.
 */
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setRendererRpcClient } from '@/api/rpc-client'
import { ProjectItem } from '@/components/projects/ProjectItem'
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

const initialFlowState = useDocumentFlowStore.getState()

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
  useConnectionStore.setState({ connectionModeActive: false })
  useHintStore.setState({ filterActive: false, inputFocused: false })
})

afterEach(() => {
  cleanup()
  useDocumentFlowStore.setState(initialFlowState, true)
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
    '%s is disabled without a project and for a connection project',
    async (id) => {
      await registerCommands()
      expect(command(id).isEnabled?.()).toBe(false)

      await act(async () => {
        useProjectStore.setState({ selectedProjectId: 'linked' })
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

  it('has no such item for a connection project', () => {
    render(<ProjectItem project={project('linked', 'connection')} />)

    fireEvent.contextMenu(screen.getByTestId('project-item-linked'))

    expect(screen.getByRole('menuitem', { name: 'Copy Path' })).toBeInTheDocument()
    expect(screen.queryByRole('menuitem', { name: 'Implement Document…' })).toBeNull()
  })
})
