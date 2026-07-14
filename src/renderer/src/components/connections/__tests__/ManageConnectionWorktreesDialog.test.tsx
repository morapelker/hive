import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

vi.mock('@/api/worktree-api', () => ({
  worktreeApi: {
    create: vi.fn()
  }
}))

import { worktreeApi } from '@/api/worktree-api'
import { useProjectStore } from '@/stores/useProjectStore'
import { useWorktreeStore } from '@/stores/useWorktreeStore'
import { useConnectionStore } from '@/stores/useConnectionStore'
import { ManageConnectionWorktreesDialog } from '../ManageConnectionWorktreesDialog'

function worktree(id: string, projectId: string, name: string): Record<string, unknown> {
  return {
    id,
    project_id: projectId,
    name,
    branch_name: `branch-${name}`,
    path: `/worktrees/${name}`,
    status: 'active',
    is_default: false,
    branch_renamed: 0,
    last_message_at: null,
    session_titles: '[]',
    last_model_provider_id: null,
    last_model_id: null,
    last_model_variant: null,
    attachments: '[]',
    created_at: '',
    last_accessed_at: '',
    github_pr_number: null,
    github_pr_url: null
  }
}

const connection = {
  id: 'conn-1',
  name: 'alpha + beta',
  custom_name: null,
  status: 'active' as const,
  path: '/connections/conn-1',
  color: null,
  created_at: '',
  updated_at: '',
  members: [
    {
      id: 'cm-1',
      connection_id: 'conn-1',
      worktree_id: 'wt-a1',
      project_id: 'proj-a',
      symlink_name: 'alpha',
      added_at: '',
      worktree_name: 'wt-a1',
      worktree_branch: 'branch-wt-a1',
      worktree_path: '/worktrees/wt-a1',
      project_name: 'alpha'
    }
  ]
}

describe('ManageConnectionWorktreesDialog create worktree button', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    useProjectStore.setState({
      projects: [
        { id: 'proj-a', name: 'alpha', path: '/proj/a' },
        { id: 'proj-b', name: 'beta', path: '/proj/b' }
      ]
    } as never)
    useWorktreeStore.setState({
      worktreesByProject: new Map([
        ['proj-a', [worktree('wt-a1', 'proj-a', 'wt-a1')]],
        ['proj-b', [worktree('wt-b1', 'proj-b', 'wt-b1')]]
      ]),
      creatingForProjectId: null
    } as never)
    useConnectionStore.setState({ connections: [connection] } as never)
  })

  it('renders a + button next to each project group', () => {
    render(<ManageConnectionWorktreesDialog connectionId="conn-1" open onOpenChange={() => {}} />)

    expect(screen.getByTestId('manage-worktrees-create-proj-a')).toBeInTheDocument()
    expect(screen.getByTestId('manage-worktrees-create-proj-b')).toBeInTheDocument()
  })

  it('creates a worktree for the project, shows it in the list, and checks it', async () => {
    vi.mocked(worktreeApi.create).mockResolvedValue({
      success: true,
      worktree: worktree('wt-new', 'proj-b', 'fresh-worktree')
    } as never)

    render(<ManageConnectionWorktreesDialog connectionId="conn-1" open onOpenChange={() => {}} />)

    await userEvent.click(screen.getByTestId('manage-worktrees-create-proj-b'))

    expect(worktreeApi.create).toHaveBeenCalledWith({
      projectId: 'proj-b',
      projectPath: '/proj/b',
      projectName: 'beta'
    })

    // New worktree appears in the list and is selected
    await waitFor(() =>
      expect(screen.getByTestId('manage-worktree-option-wt-new')).toBeInTheDocument()
    )
    expect(screen.getByTestId('manage-worktree-checkbox-wt-new')).toHaveAttribute(
      'aria-checked',
      'true'
    )
    // Existing selection is preserved
    expect(screen.getByTestId('manage-worktree-checkbox-wt-a1')).toHaveAttribute(
      'aria-checked',
      'true'
    )
  })

  it('does not add a selection when creation fails', async () => {
    vi.mocked(worktreeApi.create).mockResolvedValue({
      success: false,
      error: 'boom'
    } as never)

    render(<ManageConnectionWorktreesDialog connectionId="conn-1" open onOpenChange={() => {}} />)

    await userEvent.click(screen.getByTestId('manage-worktrees-create-proj-b'))

    await waitFor(() => expect(worktreeApi.create).toHaveBeenCalled())
    expect(screen.queryByTestId('manage-worktree-option-wt-new')).not.toBeInTheDocument()
    // Only the original member remains selected
    expect(screen.getByText('1 worktree selected')).toBeInTheDocument()
  })
})
