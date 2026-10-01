/**
 * The project context menu offers "Manage Skills" for git projects only, and
 * the dialog (with its skills listing request) exists only once it is opened.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { setRendererRpcClient } from '@/api/rpc-client'
import { ProjectItem } from './ProjectItem'
import { useProjectStore } from '@/stores/useProjectStore'
import { useWorktreeStore } from '@/stores/useWorktreeStore'
import { useConnectionStore } from '@/stores/useConnectionStore'
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

const rpc: Array<{ method: string; params: unknown }> = []

describe('ProjectItem "Manage Skills" context menu item', () => {
  beforeEach(() => {
    cleanup()
    rpc.length = 0
    setRendererRpcClient({
      request: async <T,>(method: string, params?: unknown): Promise<T> => {
        rpc.push({ method, params })
        if (method === 'projectOps.listSkills') {
          return {
            globalSkills: [{ id: 'pdf', name: 'pdf', description: null }],
            projectSkills: [{ id: 'deploy', name: 'deploy', description: null, enabled: true }]
          } as T
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
    useConnectionStore.setState({ connectionModeActive: false })
    useHintStore.setState({ filterActive: false, inputFocused: false })
  })

  // One test for the whole open → close round trip: opening a Radix menu is slow under jsdom.
  it('opens the dialog, lists the skills for the project path, and closes on Escape', async () => {
    const user = userEvent.setup()
    render(<ProjectItem project={project('alpha')} />)

    fireEvent.contextMenu(screen.getByTestId('project-item-alpha'))
    const menuItem = await screen.findByRole('menuitem', { name: 'Manage Skills' })

    // Nothing is mounted or requested until the item is chosen
    expect(screen.queryByTestId('manage-skills-dialog')).toBeNull()
    expect(rpc.some((call) => call.method === 'projectOps.listSkills')).toBe(false)

    await user.click(menuItem)

    expect(await screen.findByTestId('manage-skills-dialog')).toBeInTheDocument()
    await waitFor(() =>
      expect(rpc).toContainEqual({
        method: 'projectOps.listSkills',
        params: { path: '/tmp/alpha' }
      })
    )
    expect(await screen.findByTestId('manage-skills-project-deploy')).toBeInTheDocument()
    expect(screen.getByTestId('manage-skills-global-pdf')).toBeInTheDocument()

    // Local open state needs no global wiring: Radix closes the dialog on Escape
    await user.keyboard('{Escape}')

    await waitFor(() => expect(screen.queryByTestId('manage-skills-dialog')).toBeNull())
  })

  it('is absent for a connection project', () => {
    render(<ProjectItem project={project('linked', 'connection')} />)

    fireEvent.contextMenu(screen.getByTestId('project-item-linked'))

    // Radix renders the items synchronously on contextmenu; find* here costs ~10s under jsdom
    expect(screen.getByRole('menuitem', { name: 'Copy Path' })).toBeInTheDocument()
    expect(screen.queryByRole('menuitem', { name: 'Manage Skills' })).toBeNull()
    expect(screen.queryByRole('menuitem', { name: 'Project Settings' })).toBeNull()
  })
})
