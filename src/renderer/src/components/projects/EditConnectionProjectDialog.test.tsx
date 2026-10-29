/**
 * "Edit Connection…" on a connection project: a context-menu item (connection projects only)
 * opens a dialog that preselects the current member projects, enforces at least 2, and saves
 * the new member list through connectionOps.updateProjectMembers.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { setRendererRpcClient } from '@/api/rpc-client'
import { ProjectItem } from './ProjectItem'
import { EditConnectionProjectDialog } from './EditConnectionProjectDialog'
import { useProjectStore } from '@/stores/useProjectStore'
import { useWorktreeStore } from '@/stores/useWorktreeStore'
import { useConnectionStore } from '@/stores/useConnectionStore'
import { useHintStore } from '@/stores/useHintStore'
import { useSettingsStore } from '@/stores/useSettingsStore'

const project = (
  id: string,
  extra: { kind?: 'git' | 'connection'; member_project_ids?: string | null } = {}
) => ({
  id,
  name: id,
  path: `/tmp/${id}`,
  ...extra,
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

const alpha = project('alpha')
const beta = project('beta')
const gamma = project('gamma')
const linked = project('linked', {
  kind: 'connection',
  member_project_ids: JSON.stringify(['alpha', 'beta'])
})

const rpc: Array<{ method: string; params: unknown }> = []

beforeEach(() => {
  cleanup()
  rpc.length = 0
  setRendererRpcClient({
    request: async <T,>(method: string, params?: unknown): Promise<T> => {
      rpc.push({ method, params })
      if (method === 'connectionOps.updateProjectMembers') {
        const { projectId, memberProjectIds } = params as {
          projectId: string
          memberProjectIds: string[]
        }
        return {
          success: true,
          project: {
            ...linked,
            id: projectId,
            member_project_ids: JSON.stringify(memberProjectIds)
          }
        } as T
      }
      if (method === 'connectionOps.getAll') return { success: true, connections: [] } as T
      return { success: true } as T
    },
    subscribe: () => () => {}
  })
  useSettingsStore.setState({ tipsEnabled: false })
  useProjectStore.setState({
    projects: [alpha, beta, gamma, linked],
    expandedProjectIds: new Set(),
    selectedProjectId: null
  } as never)
  useWorktreeStore.setState({
    worktreesByProject: new Map(),
    loadedProjectIds: new Set(),
    worktreeOrderByProject: new Map()
  })
  useConnectionStore.setState({ connectionModeActive: false, connections: [] })
  useHintStore.setState({ filterActive: false, inputFocused: false })
})

describe('ProjectItem "Edit Connection…" context menu item', () => {
  it('is offered for a connection project and opens the dialog', async () => {
    const user = userEvent.setup()
    render(<ProjectItem project={linked} />)

    fireEvent.contextMenu(screen.getByTestId('project-item-linked'))
    const menuItem = await screen.findByRole('menuitem', { name: 'Edit Connection…' })
    expect(screen.queryByTestId('edit-connection-project-dialog')).toBeNull()

    await user.click(menuItem)

    expect(await screen.findByTestId('edit-connection-project-dialog')).toBeInTheDocument()
    // Current members are preselected; the other git project is not; the connection
    // project itself is never a candidate.
    expect(screen.getByTestId('edit-connection-project-checkbox-alpha')).toHaveAttribute(
      'data-state',
      'checked'
    )
    expect(screen.getByTestId('edit-connection-project-checkbox-beta')).toHaveAttribute(
      'data-state',
      'checked'
    )
    expect(screen.getByTestId('edit-connection-project-checkbox-gamma')).toHaveAttribute(
      'data-state',
      'unchecked'
    )
    expect(screen.queryByTestId('edit-connection-project-option-linked')).toBeNull()
  })

  it('is absent for a git project', () => {
    render(<ProjectItem project={alpha} />)

    fireEvent.contextMenu(screen.getByTestId('project-item-alpha'))

    expect(screen.getByRole('menuitem', { name: 'Copy Path' })).toBeInTheDocument()
    expect(screen.queryByRole('menuitem', { name: 'Edit Connection…' })).toBeNull()
  })
})

describe('EditConnectionProjectDialog', () => {
  it('saves retained members in their stored order plus the new one, then updates the project row', async () => {
    const user = userEvent.setup()
    let open = true
    render(
      <EditConnectionProjectDialog
        project={linked}
        open={open}
        onOpenChange={(next) => {
          open = next
        }}
      />
    )

    const save = screen.getByTestId('edit-connection-project-save-button')
    expect(save).toBeDisabled()

    await user.click(screen.getByTestId('edit-connection-project-checkbox-gamma'))
    expect(save).toBeEnabled()
    await user.click(save)

    await waitFor(() =>
      expect(rpc).toContainEqual({
        method: 'connectionOps.updateProjectMembers',
        params: { projectId: 'linked', memberProjectIds: ['alpha', 'beta', 'gamma'] }
      })
    )
    // The rebuilt base instance is re-listed and the dialog closes
    await waitFor(() => expect(rpc.some((c) => c.method === 'connectionOps.getAll')).toBe(true))
    await waitFor(() => expect(open).toBe(false))
    const updated = useProjectStore.getState().projects.find((p) => p.id === 'linked')
    expect(JSON.parse(updated?.member_project_ids ?? '[]')).toEqual(['alpha', 'beta', 'gamma'])
  })

  it('refuses to save fewer than 2 members', async () => {
    const user = userEvent.setup()
    render(<EditConnectionProjectDialog project={linked} open onOpenChange={() => {}} />)

    await user.click(screen.getByTestId('edit-connection-project-checkbox-beta'))

    expect(screen.getByText('Select at least 2 projects')).toBeInTheDocument()
    expect(screen.getByTestId('edit-connection-project-save-button')).toBeDisabled()
    expect(rpc.some((c) => c.method === 'connectionOps.updateProjectMembers')).toBe(false)
  })

  it('filters the project list', async () => {
    const user = userEvent.setup()
    render(<EditConnectionProjectDialog project={linked} open onOpenChange={() => {}} />)

    await user.type(screen.getByTestId('edit-connection-project-filter'), 'gam')

    expect(screen.getByTestId('edit-connection-project-option-gamma')).toBeInTheDocument()
    expect(screen.queryByTestId('edit-connection-project-option-alpha')).toBeNull()
  })
})
