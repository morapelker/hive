import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { ConnectionPushPull } from './ConnectionPushPull'
import { useGitStore } from '@/stores/useGitStore'
import { toast } from '@/lib/toast'

vi.mock('@/lib/toast', () => ({
  toast: { error: vi.fn(), success: vi.fn(), info: vi.fn() }
}))

const members = [
  { worktree_path: '/a', project_name: 'alpha' },
  { worktree_path: '/b', project_name: 'beta' },
  { worktree_path: '/c', project_name: 'gamma' }
]

const info = (ahead: number, behind: number, tracking: string | null) => ({
  name: 'feat',
  ahead,
  behind,
  tracking
})

describe('ConnectionPushPull', () => {
  const push = vi.fn()
  const pull = vi.fn()

  beforeEach(() => {
    vi.clearAllMocks()
    push.mockResolvedValue({ success: true })
    pull.mockResolvedValue({ success: true })
    useGitStore.setState({
      push,
      pull,
      branchInfoByWorktree: new Map([
        ['/a', info(2, 1, 'origin/feat')],
        ['/b', info(1, 0, 'origin/feat')],
        ['/c', info(0, 0, null)]
      ]) as never
    })
  })

  it('renders nothing without members', () => {
    const { container } = render(<ConnectionPushPull members={[]} />)
    expect(container.firstChild).toBeNull()
  })

  it('shows aggregated ahead/behind counts', () => {
    render(<ConnectionPushPull members={members} />)
    expect(screen.getByTestId('connection-push-button')).toHaveTextContent('(3)')
    expect(screen.getByTestId('connection-pull-button')).toHaveTextContent('(1)')
  })

  it('pushes every member path', async () => {
    render(<ConnectionPushPull members={members} />)
    fireEvent.click(screen.getByTestId('connection-push-button'))
    await waitFor(() => expect(push).toHaveBeenCalledTimes(3))
    expect(push.mock.calls.map((c) => c[0])).toEqual(['/a', '/b', '/c'])
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Pushed 3 repos'))
  })

  it('pulls only members with an upstream and reports skipped ones', async () => {
    render(<ConnectionPushPull members={members} />)
    fireEvent.click(screen.getByTestId('connection-pull-button'))
    await waitFor(() => expect(pull).toHaveBeenCalledTimes(2))
    expect(pull.mock.calls.map((c) => c[0])).toEqual(['/a', '/b'])
    await waitFor(() =>
      expect(toast.success).toHaveBeenCalledWith('Pulled 2 repos', {
        description: '1 repo without upstream skipped'
      })
    )
  })

  it('continues after a failure and reports which repos failed', async () => {
    push.mockImplementation(async (p: string) =>
      p === '/b' ? { success: false, error: 'rejected' } : { success: true }
    )
    render(<ConnectionPushPull members={members} />)
    fireEvent.click(screen.getByTestId('connection-push-button'))
    await waitFor(() => expect(push).toHaveBeenCalledTimes(3))
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith('Push failed for 1 of 3 repos', {
        description: 'beta: rejected'
      })
    )
  })

  it('disables pull when no member has an upstream', () => {
    useGitStore.setState({
      branchInfoByWorktree: new Map([['/a', info(0, 0, null)]]) as never
    })
    render(<ConnectionPushPull members={[members[0]]} />)
    expect(screen.getByTestId('connection-pull-button')).toBeDisabled()
    expect(screen.getByTestId('connection-push-button')).not.toBeDisabled()
  })
})
