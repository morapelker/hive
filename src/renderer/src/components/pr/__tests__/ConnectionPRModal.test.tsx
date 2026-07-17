import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'

import { resetRendererRpcClientForTests, setRendererRpcClient } from '../../../api/rpc-client'
import { usePRNotificationStore } from '@/stores/usePRNotificationStore'
import { useConnectionStore } from '@/stores/useConnectionStore'
import { useWorktreeStore } from '@/stores/useWorktreeStore'
import { useProjectStore } from '@/stores/useProjectStore'
import { useGitStore } from '@/stores/useGitStore'
import { ConnectionPRModal } from '../ConnectionPRModal'

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
      worktree_id: 'wt-a',
      project_id: 'proj-a',
      symlink_name: 'alpha',
      added_at: '',
      worktree_name: 'wt-a',
      worktree_branch: 'feat-a',
      worktree_path: '/repo/a',
      project_name: 'alpha'
    },
    {
      id: 'cm-2',
      connection_id: 'conn-1',
      worktree_id: 'wt-b',
      project_id: 'proj-b',
      symlink_name: 'beta',
      added_at: '',
      worktree_name: 'wt-b',
      worktree_branch: 'feat-b',
      worktree_path: '/repo/b',
      project_name: 'beta'
    }
  ]
}

let request: ReturnType<typeof vi.fn>

function mockResponses(spec: {
  hasUncommitted?: Record<string, boolean>
  commitCount?: Record<string, number>
  files?: Record<string, unknown[]>
}): void {
  request.mockImplementation((method: string, params: Record<string, unknown>) => {
    const path = params?.worktreePath as string
    switch (method) {
      case 'gitOps.getRemoteUrl':
        return Promise.resolve({ success: true, url: 'https://github.com/acme/x.git' })
      case 'gitOps.hasUncommittedChanges':
        return Promise.resolve(spec.hasUncommitted?.[path] ?? false)
      case 'gitOps.getRangeDiff':
        return Promise.resolve({
          commitSummary: '',
          diffSummary: '',
          diffPatch: '',
          commitCount: spec.commitCount?.[path] ?? 0
        })
      case 'gitOps.getBranchInfo':
        return Promise.resolve({
          success: true,
          branch: { name: 'feat', tracking: null, ahead: 0, behind: 0 }
        })
      case 'gitOps.getFileStatuses':
        return Promise.resolve({ success: true, files: spec.files?.[path] ?? [] })
      case 'gitOps.listBranchesWithStatus':
        return Promise.resolve({
          success: true,
          branches: [{ name: 'origin/main', isRemote: true }]
        })
      default:
        return Promise.resolve([])
    }
  })
}

describe('ConnectionPRModal', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    request = vi.fn().mockResolvedValue([])
    setRendererRpcClient({ request, subscribe: vi.fn() })
    useConnectionStore.setState({ connections: [connection] } as never)
    useWorktreeStore.setState({
      worktreesByProject: new Map([
        [
          'proj-a',
          [
            { id: 'wt-a-default', path: '/proj/a', branch_name: 'main', is_default: true },
            { id: 'wt-a', path: '/repo/a', branch_name: 'feat-a', is_default: false }
          ]
        ],
        [
          'proj-b',
          [
            { id: 'wt-b-default', path: '/proj/b', branch_name: 'main', is_default: true },
            { id: 'wt-b', path: '/repo/b', branch_name: 'feat-b', is_default: false }
          ]
        ]
      ])
    } as never)
    useProjectStore.setState({
      projects: [
        { id: 'proj-a', path: '/proj/a' },
        { id: 'proj-b', path: '/proj/b' }
      ]
    } as never)
    useGitStore.setState({
      fileStatusesByWorktree: new Map(),
      branchInfoByWorktree: new Map(),
      remoteInfo: new Map(),
      prTargetBranch: new Map(),
      attachedPR: new Map(),
      creatingPRByWorktreeId: new Map(),
      connectionPRModalOpen: true,
      connectionPRConnectionId: 'conn-1'
    })
    usePRNotificationStore.setState({ notifications: [] })
  })

  afterEach(() => {
    resetRendererRpcClientForTests()
  })

  it('shows a commit section only for members with changes', async () => {
    mockResponses({
      hasUncommitted: { '/repo/a': true },
      files: {
        '/repo/a': [
          { path: '/repo/a/src/x.ts', relativePath: 'src/x.ts', status: 'M', staged: false }
        ]
      }
    })

    render(<ConnectionPRModal connectionId="conn-1" />)

    await waitFor(() => {
      expect(screen.getByTestId('connection-pr-section-wt-a')).toBeInTheDocument()
    })
    expect(screen.queryByTestId('connection-pr-section-wt-b')).not.toBeInTheDocument()
    expect(screen.getByText('src/x.ts')).toBeInTheDocument()
  })

  it('shows the form phase directly when changes are already committed', async () => {
    mockResponses({ commitCount: { '/repo/a': 2 } })

    render(<ConnectionPRModal connectionId="conn-1" />)

    await waitFor(() => {
      expect(screen.getByTestId('connection-pr-row-wt-a')).toBeInTheDocument()
    })
    expect(screen.queryByTestId('connection-pr-row-wt-b')).not.toBeInTheDocument()
    expect(screen.getByText(/2 commits ahead/)).toBeInTheDocument()
  })

  it('closes with archive prompts when every member is clean', async () => {
    mockResponses({})

    render(<ConnectionPRModal connectionId="conn-1" />)

    await waitFor(() => {
      expect(screen.getByText(/nothing to PR/i)).toBeInTheDocument()
    })
    const prompts = usePRNotificationStore.getState().notifications
    expect(prompts).toHaveLength(2)
    expect(prompts.every((n) => n.showArchiveButton)).toBe(true)
  })
})
