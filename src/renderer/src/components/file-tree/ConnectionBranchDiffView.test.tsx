import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { ConnectionBranchDiffView } from './ConnectionBranchDiffView'
import { useGitStore } from '@/stores/useGitStore'
import { useConnectionStore } from '@/stores/useConnectionStore'
import { useFileViewerStore } from '@/stores/useFileViewerStore'

const gitApiMocks = vi.hoisted(() => ({
  listBranchesWithStatus: vi.fn(),
  getBranchDiffFiles: vi.fn(),
  onStatusChanged: vi.fn(),
  onBranchChanged: vi.fn()
}))
vi.mock('@/api/git-api', () => ({ gitApi: gitApiMocks }))

const branch = (
  name: string,
  opts: { isRemote?: boolean; isCheckedOut?: boolean; worktreePath?: string } = {}
) => ({
  name,
  isRemote: opts.isRemote ?? false,
  isCheckedOut: opts.isCheckedOut ?? false,
  worktreePath: opts.worktreePath
})
const file = (relativePath: string, status = 'M') => ({
  relativePath,
  status,
  additions: 1,
  deletions: 0,
  binary: false
})

const members = [
  { worktree_path: '/repo/a', project_name: 'alpha', worktree_branch: 'feat-a' },
  { worktree_path: '/repo/b', project_name: 'beta', worktree_branch: 'feat-b' }
]

const initialGitState = useGitStore.getState()
const initialConnectionState = useConnectionStore.getState()
const initialFileViewerState = useFileViewerStore.getState()

type StatusListener = (event: { worktreePath: string }) => void

describe('ConnectionBranchDiffView', () => {
  let statusListeners: StatusListener[]
  let branchListeners: StatusListener[]

  beforeEach(() => {
    vi.clearAllMocks()
    statusListeners = []
    branchListeners = []
    gitApiMocks.onStatusChanged.mockImplementation((cb: StatusListener) => {
      statusListeners.push(cb)
      return () => {
        statusListeners = statusListeners.filter((l) => l !== cb)
      }
    })
    gitApiMocks.onBranchChanged.mockImplementation((cb: StatusListener) => {
      branchListeners.push(cb)
      return () => {
        branchListeners = branchListeners.filter((l) => l !== cb)
      }
    })
    gitApiMocks.listBranchesWithStatus.mockImplementation(async (path: string) => ({
      success: true,
      branches:
        path === '/repo/a'
          ? [
              branch('main', { isCheckedOut: true, worktreePath: '/repo/a' }),
              branch('develop'),
              branch('origin/main', { isRemote: true })
            ]
          : [branch('main'), branch('origin/main', { isRemote: true }), branch('only-b')]
    }))
    gitApiMocks.getBranchDiffFiles.mockImplementation(async (path: string) => ({
      success: true,
      files: path === '/repo/a' ? [file('src/a.ts')] : [file('src/b.ts'), file('README.md', 'A')]
    }))
    useConnectionStore.setState({ selectedConnectionId: 'conn-1' } as never)
    useGitStore.setState({ selectedDiffBranch: new Map(), branchInfoByWorktree: new Map() })
  })

  afterEach(() => {
    cleanup()
    useGitStore.setState(initialGitState, true)
    useConnectionStore.setState(initialConnectionState, true)
    useFileViewerStore.setState(initialFileViewerState, true)
  })

  const selectBranch = async (name: string): Promise<void> => {
    fireEvent.click(screen.getByTestId('branch-select-trigger'))
    fireEvent.click(await screen.findByText(name))
  }

  it('loads branches for every member and lists only the common ones', async () => {
    render(<ConnectionBranchDiffView members={members} />)
    await waitFor(() => expect(gitApiMocks.listBranchesWithStatus).toHaveBeenCalledTimes(2))
    expect(gitApiMocks.listBranchesWithStatus.mock.calls.map((c) => c[0])).toEqual([
      '/repo/a',
      '/repo/b'
    ])
    await waitFor(() => expect(screen.getByTestId('branch-select-trigger')).not.toBeDisabled())

    fireEvent.click(screen.getByTestId('branch-select-trigger'))
    const menu = await screen.findByTestId('branch-select-menu')
    expect(within(menu).getByText('main')).toBeInTheDocument()
    expect(within(menu).getByText('origin/main')).toBeInTheDocument()
    expect(within(menu).queryByText('develop')).toBeNull()
    expect(within(menu).queryByText('only-b')).toBeNull()
    // "current" only when every member has it checked out — beta does not.
    expect(within(menu).queryByText('current')).toBeNull()
  })

  it('shows an empty message when no branch is shared by every member', async () => {
    gitApiMocks.listBranchesWithStatus.mockImplementation(async (path: string) => ({
      success: true,
      branches: path === '/repo/a' ? [branch('a-only')] : [branch('b-only')]
    }))
    render(<ConnectionBranchDiffView members={members} />)
    await waitFor(() => expect(screen.getByTestId('branch-select-trigger')).not.toBeDisabled())
    fireEvent.click(screen.getByTestId('branch-select-trigger'))
    expect(await screen.findByText('No branches shared by all repos')).toBeInTheDocument()
  })

  it('remembers the selection per connection and loads a diff section per member', async () => {
    render(<ConnectionBranchDiffView members={members} />)
    expect(screen.getAllByText('Loading branches...').length).toBeGreaterThan(0)
    expect(
      await screen.findByText('Select a branch to see differences across 2 repos')
    ).toBeInTheDocument()
    expect(screen.getByTestId('branch-select-trigger')).not.toBeDisabled()

    await selectBranch('main')

    expect(useGitStore.getState().selectedDiffBranch.get('connection:conn-1')).toBe('main')
    await waitFor(() => expect(gitApiMocks.getBranchDiffFiles).toHaveBeenCalledTimes(2))
    expect(gitApiMocks.getBranchDiffFiles).toHaveBeenCalledWith('/repo/a', 'main')
    expect(gitApiMocks.getBranchDiffFiles).toHaveBeenCalledWith('/repo/b', 'main')

    const alpha = await screen.findByTestId('branch-diff-member-/repo/a')
    const beta = await screen.findByTestId('branch-diff-member-/repo/b')
    expect(await within(alpha).findByText('src/a.ts')).toBeInTheDocument()
    expect(within(alpha).getByText('alpha')).toBeInTheDocument()
    expect(within(alpha).getByText('feat-a')).toBeInTheDocument()
    expect(await within(beta).findByText('README.md')).toBeInTheDocument()
    expect(within(beta).getByText('src/b.ts')).toBeInTheDocument()
    expect(within(beta).getByText('2')).toBeInTheDocument()

    expect(screen.getByText('3 files changed across 2 repos')).toBeInTheDocument()
  })

  it('opens the diff against the member worktree when a file is clicked', async () => {
    useGitStore.setState({ selectedDiffBranch: new Map([['connection:conn-1', 'main']]) })
    render(<ConnectionBranchDiffView members={members} />)

    fireEvent.click(await screen.findByText('src/b.ts'))

    expect(useFileViewerStore.getState().activeDiff).toMatchObject({
      worktreePath: '/repo/b',
      filePath: 'src/b.ts',
      fileName: 'b.ts',
      staged: false,
      isUntracked: false,
      compareBranch: 'main'
    })
  })

  it('surfaces a member diff error without hiding the other members', async () => {
    gitApiMocks.getBranchDiffFiles.mockImplementation(async (path: string) =>
      path === '/repo/b'
        ? {
            success: false,
            error: "fatal: ambiguous argument 'main': unknown revision or path not in the working tree."
          }
        : { success: true, files: [file('src/a.ts')] }
    )
    useGitStore.setState({ selectedDiffBranch: new Map([['connection:conn-1', 'main']]) })
    render(<ConnectionBranchDiffView members={members} />)

    expect(await screen.findByText('Branch not found in this repo')).toBeInTheDocument()
    expect(await screen.findByText('src/a.ts')).toBeInTheDocument()
    expect(screen.getByText('1 file changed across 1 repo')).toBeInTheDocument()
  })

  it('marks a member with no differences and collapses it', async () => {
    gitApiMocks.getBranchDiffFiles.mockImplementation(async (path: string) => ({
      success: true,
      files: path === '/repo/a' ? [file('src/a.ts')] : []
    }))
    useGitStore.setState({ selectedDiffBranch: new Map([['connection:conn-1', 'main']]) })
    render(<ConnectionBranchDiffView members={members} />)

    const beta = await screen.findByTestId('branch-diff-member-/repo/b')
    expect(await within(beta).findByText('no diff')).toBeInTheDocument()
    expect(await screen.findByText('src/a.ts')).toBeInTheDocument()
  })

  it('collapses and expands a member section', async () => {
    useGitStore.setState({ selectedDiffBranch: new Map([['connection:conn-1', 'main']]) })
    render(<ConnectionBranchDiffView members={members} />)
    const alpha = await screen.findByTestId('branch-diff-member-/repo/a')
    expect(await within(alpha).findByText('src/a.ts')).toBeInTheDocument()

    fireEvent.click(within(alpha).getByText('alpha'))
    expect(within(alpha).queryByText('src/a.ts')).toBeNull()

    fireEvent.click(within(alpha).getByText('alpha'))
    expect(within(alpha).getByText('src/a.ts')).toBeInTheDocument()
  })

  it('reloads only the member whose git status changed', async () => {
    useGitStore.setState({ selectedDiffBranch: new Map([['connection:conn-1', 'main']]) })
    render(<ConnectionBranchDiffView members={members} />)
    await waitFor(() => expect(gitApiMocks.getBranchDiffFiles).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(statusListeners.length).toBeGreaterThan(0))

    gitApiMocks.getBranchDiffFiles.mockClear()
    gitApiMocks.getBranchDiffFiles.mockImplementation(async () => ({
      success: true,
      files: [file('src/b-new.ts')]
    }))
    await act(async () => {
      statusListeners.forEach((l) => l({ worktreePath: '/repo/b' }))
    })

    await waitFor(() => expect(gitApiMocks.getBranchDiffFiles).toHaveBeenCalledTimes(1))
    expect(gitApiMocks.getBranchDiffFiles).toHaveBeenCalledWith('/repo/b', 'main')
    expect(await screen.findByText('src/b-new.ts')).toBeInTheDocument()
    // An unrelated worktree does not trigger a reload.
    await act(async () => {
      statusListeners.forEach((l) => l({ worktreePath: '/repo/other' }))
    })
    expect(gitApiMocks.getBranchDiffFiles).toHaveBeenCalledTimes(1)
  })

  it('refreshes branches and every member diff', async () => {
    useGitStore.setState({ selectedDiffBranch: new Map([['connection:conn-1', 'main']]) })
    render(<ConnectionBranchDiffView members={members} />)
    await waitFor(() => expect(gitApiMocks.getBranchDiffFiles).toHaveBeenCalledTimes(2))
    await waitFor(() =>
      expect(screen.getByTestId('connection-branch-diff-refresh')).not.toBeDisabled()
    )
    gitApiMocks.listBranchesWithStatus.mockClear()
    gitApiMocks.getBranchDiffFiles.mockClear()

    fireEvent.click(screen.getByTestId('connection-branch-diff-refresh'))

    await waitFor(() => expect(gitApiMocks.listBranchesWithStatus).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(gitApiMocks.getBranchDiffFiles).toHaveBeenCalledTimes(2))
  })

  it('ignores a member whose branch listing failed and reports it in the picker', async () => {
    gitApiMocks.listBranchesWithStatus.mockImplementation(async (path: string) =>
      path === '/repo/b'
        ? { success: false, branches: [], error: 'not a git repository' }
        : { success: true, branches: [branch('main')] }
    )
    render(<ConnectionBranchDiffView members={members} />)
    await waitFor(() => expect(screen.getByTestId('branch-select-trigger')).not.toBeDisabled())
    fireEvent.click(screen.getByTestId('branch-select-trigger'))
    const menu = await screen.findByTestId('branch-select-menu')
    expect(within(menu).getByText('main')).toBeInTheDocument()
    expect(within(menu).getByTestId('branch-listing-errors')).toHaveTextContent(
      'beta: Not a git repository'
    )
  })

  it('tags a branch as current only when every member worktree is on it', async () => {
    gitApiMocks.listBranchesWithStatus.mockImplementation(async (path: string) => ({
      success: true,
      branches: [branch('main', { isCheckedOut: true, worktreePath: path }), branch('feat')]
    }))
    render(<ConnectionBranchDiffView members={members} />)
    await waitFor(() => expect(screen.getByTestId('branch-select-trigger')).not.toBeDisabled())
    fireEvent.click(screen.getByTestId('branch-select-trigger'))
    const menu = await screen.findByTestId('branch-select-menu')
    const mainRow = within(menu).getByText('main').closest('button') as HTMLElement
    expect(within(mainRow).getByText('current')).toBeInTheDocument()
    const featRow = within(menu).getByText('feat').closest('button') as HTMLElement
    expect(within(featRow).queryByText('current')).toBeNull()
  })

  it('drops a remembered branch that is no longer shared by every member', async () => {
    useGitStore.setState({ selectedDiffBranch: new Map([['connection:conn-1', 'develop']]) })
    render(<ConnectionBranchDiffView members={members} />)
    expect(
      await screen.findByText('"develop" is no longer shared by all repos. Select another branch.')
    ).toBeInTheDocument()
    expect(gitApiMocks.getBranchDiffFiles).not.toHaveBeenCalled()
    expect(screen.getByText('No branch selected')).toBeInTheDocument()
  })

  it('reloads the branch lists when a member switches branch', async () => {
    render(<ConnectionBranchDiffView members={members} />)
    await waitFor(() => expect(gitApiMocks.listBranchesWithStatus).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(branchListeners.length).toBeGreaterThan(0))
    gitApiMocks.listBranchesWithStatus.mockClear()

    await act(async () => {
      branchListeners.forEach((l) => l({ worktreePath: '/repo/a' }))
    })
    await waitFor(() => expect(gitApiMocks.listBranchesWithStatus).toHaveBeenCalledTimes(2))

    await act(async () => {
      branchListeners.forEach((l) => l({ worktreePath: '/repo/other' }))
    })
    expect(gitApiMocks.listBranchesWithStatus).toHaveBeenCalledTimes(2)
  })

  it('re-lists branches (debounced) after a member status change', async () => {
    render(<ConnectionBranchDiffView members={members} />)
    await waitFor(() => expect(gitApiMocks.listBranchesWithStatus).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(statusListeners.length).toBeGreaterThan(0))
    gitApiMocks.listBranchesWithStatus.mockClear()

    await act(async () => {
      statusListeners.forEach((l) => l({ worktreePath: '/repo/a' }))
      statusListeners.forEach((l) => l({ worktreePath: '/repo/b' }))
    })
    expect(gitApiMocks.listBranchesWithStatus).not.toHaveBeenCalled()
    await waitFor(
      () => expect(gitApiMocks.listBranchesWithStatus).toHaveBeenCalledTimes(2),
      { timeout: 3000 }
    )
  })

  it('keeps separate tabs for the same relative path in different members', async () => {
    gitApiMocks.getBranchDiffFiles.mockImplementation(async () => ({
      success: true,
      files: [file('package.json')]
    }))
    useGitStore.setState({ selectedDiffBranch: new Map([['connection:conn-1', 'main']]) })
    render(<ConnectionBranchDiffView members={members} />)
    const alpha = await screen.findByTestId('branch-diff-member-/repo/a')
    const beta = await screen.findByTestId('branch-diff-member-/repo/b')

    fireEvent.click(await within(alpha).findByText('package.json'))
    fireEvent.click(await within(beta).findByText('package.json'))

    const diffTabs = Array.from(useFileViewerStore.getState().openFiles.values()).filter(
      (t) => t.type === 'diff'
    )
    expect(diffTabs.map((t) => (t.type === 'diff' ? t.worktreePath : null))).toEqual([
      '/repo/a',
      '/repo/b'
    ])
    expect(useFileViewerStore.getState().activeDiff?.worktreePath).toBe('/repo/b')
  })

  it('renders a placeholder for a connection with no members', () => {
    render(<ConnectionBranchDiffView members={[]} />)
    expect(screen.getByText('No connection members')).toBeInTheDocument()
    expect(gitApiMocks.listBranchesWithStatus).not.toHaveBeenCalled()
  })
})
