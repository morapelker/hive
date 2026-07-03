import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import { PRNotificationStack } from '../PRNotificationStack'
import { usePRNotificationStore } from '@/stores/usePRNotificationStore'
import { useWorktreeStore } from '@/stores/useWorktreeStore'
import { useProjectStore } from '@/stores/useProjectStore'

const worktree = {
  id: 'wt-1',
  path: '/repo/wt-1',
  branch_name: 'feature-x'
}

describe('PRNotificationStack archive prompt', () => {
  beforeEach(() => {
    usePRNotificationStore.setState({ notifications: [] })
    useWorktreeStore.setState({
      worktreesByProject: new Map([['proj-1', [worktree]]])
    } as never)
    useProjectStore.setState({
      projects: [{ id: 'proj-1', path: '/projects/one' }]
    } as never)
  })

  it('renders an Archive button for archive-prompt notifications', () => {
    usePRNotificationStore.getState().show({
      status: 'info',
      message: 'Nothing to PR in one',
      worktreeId: 'wt-1',
      showArchiveButton: true
    })

    render(<PRNotificationStack />)

    expect(screen.getByRole('button', { name: /archive/i })).toBeInTheDocument()
  })

  it('does not render an Archive button without the flag', () => {
    usePRNotificationStore.getState().show({
      status: 'info',
      message: 'PR #7 already exists',
      worktreeId: 'wt-1'
    })

    render(<PRNotificationStack />)

    expect(screen.queryByRole('button', { name: /archive/i })).not.toBeInTheDocument()
  })

  it('archives the worktree and dismisses the card on click', async () => {
    const archiveWorktree = vi.fn().mockResolvedValue({ success: true })
    useWorktreeStore.setState({ archiveWorktree } as never)

    usePRNotificationStore.getState().show({
      status: 'info',
      message: 'Nothing to PR in one',
      worktreeId: 'wt-1',
      showArchiveButton: true
    })

    render(<PRNotificationStack />)
    await userEvent.click(screen.getByRole('button', { name: /archive/i }))

    expect(archiveWorktree).toHaveBeenCalledWith(
      'wt-1',
      '/repo/wt-1',
      'feature-x',
      '/projects/one'
    )
    await waitFor(() => {
      expect(usePRNotificationStore.getState().notifications).toHaveLength(0)
    })
  })
})
