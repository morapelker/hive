// A detached-HEAD worktree in the sidebar: named by its directory with a "detached" badge
// (it used to read "HEAD"), and "Remove Worktree" asks first when the checkout holds work
// that exists nowhere else.
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest'

const gitApiMocks = vi.hoisted(() => ({
  getDiffStat: vi.fn(),
  getUnreachableCommits: vi.fn()
}))

vi.mock('../../src/renderer/src/api/git-api', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../src/renderer/src/api/git-api')>()
  return { ...original, gitApi: { ...original.gitApi, ...gitApiMocks } }
})

import { WorktreeItem } from '../../src/renderer/src/components/worktrees/WorktreeItem'
import { useConnectionStore } from '../../src/renderer/src/stores/useConnectionStore'
import { useGitStore } from '../../src/renderer/src/stores/useGitStore'
import { useHintStore } from '../../src/renderer/src/stores/useHintStore'
import { useProjectStore } from '../../src/renderer/src/stores/useProjectStore'
import { useSettingsStore } from '../../src/renderer/src/stores/useSettingsStore'
import { useVimModeStore } from '../../src/renderer/src/stores/useVimModeStore'
import { useWorktreeStore } from '../../src/renderer/src/stores/useWorktreeStore'

const project = {
  id: 'project-1',
  name: 'my-app',
  path: '/dev/my-app',
  description: null,
  tags: null,
  language: 'typescript',
  custom_icon: null,
  detected_icon: null,
  setup_script: null,
  run_script: null,
  archive_script: null,
  auto_assign_port: false,
  sort_order: 0,
  created_at: '2026-01-01T00:00:00Z',
  last_accessed_at: '2026-01-01T00:00:00Z'
}

const detachedWorktree = {
  id: 'worktree-detached',
  project_id: project.id,
  name: 'my-app-deploy',
  branch_name: '',
  path: '/dev/my-app-deploy',
  status: 'active' as const,
  is_default: false,
  created_at: '2026-01-01T00:00:00Z',
  last_accessed_at: '2026-01-01T00:00:00Z',
  attachments: '[]'
}

const branchInfo = (name: string) => ({ name, tracking: null, ahead: 0, behind: 0 })

// See test/custom-commands/menu-integration.test.tsx: jsdom overflows on these two probes.
const TOP_LAYER_PROBES = new Set([':popover-open', ':modal'])
const originalMatches = Element.prototype.matches

beforeAll(() => {
  Element.prototype.matches = function (this: Element, selectors: string): boolean {
    return TOP_LAYER_PROBES.has(selectors) ? false : originalMatches.call(this, selectors)
  }
})

afterAll(() => {
  Element.prototype.matches = originalMatches
})

describe('WorktreeItem with a detached HEAD', () => {
  const unbranchWorktree = vi.fn()

  beforeEach(() => {
    unbranchWorktree.mockReset().mockResolvedValue({ success: true })
    gitApiMocks.getDiffStat.mockReset().mockResolvedValue({ success: true, files: [] })
    gitApiMocks.getUnreachableCommits
      .mockReset()
      .mockResolvedValue({ success: true, count: 0, commits: [] })

    useProjectStore.setState({ projects: [project] } as never)
    useWorktreeStore.setState({ unbranchWorktree, selectedWorktreeId: null } as never)
    useConnectionStore.setState({ connectionModeActive: false } as never)
    useHintStore.setState({
      hintMap: new Map(),
      mode: 'default',
      pendingChar: null,
      actionMode: null,
      filterActive: false,
      inputFocused: false
    } as never)
    useVimModeStore.setState({ mode: 'insert' } as never)
    useSettingsStore.setState({ vimModeEnabled: false, customProjectCommands: [] } as never)
    useGitStore.setState({
      branchInfoByWorktree: new Map([[detachedWorktree.path, branchInfo('HEAD')]])
    } as never)
  })

  const renderItem = (): HTMLElement => {
    render(<WorktreeItem worktree={detachedWorktree} projectPath={project.path} />)
    return screen.getByTestId(`worktree-item-${detachedWorktree.id}`)
  }

  const clickRemove = async (user: ReturnType<typeof userEvent.setup>, item: HTMLElement) => {
    await user.click(item.querySelector('button[aria-haspopup="menu"]') as HTMLElement)
    await user.click(await screen.findByText('Remove Worktree'))
  }

  test('reads as its directory name with a detached badge, not as "HEAD"', () => {
    const item = renderItem()

    expect(item).toHaveTextContent('my-app-deploy')
    expect(item).not.toHaveTextContent('HEAD')
    expect(item.querySelector('[data-worktree-detached-badge]')).toHaveTextContent('detached')
  })

  test('shows no badge once the worktree is on a branch', () => {
    useGitStore.setState({
      branchInfoByWorktree: new Map([[detachedWorktree.path, branchInfo('hotfix')]])
    } as never)

    const item = renderItem()

    expect(item).toHaveTextContent('hotfix')
    expect(item.querySelector('[data-worktree-detached-badge]')).toBeNull()
  })

  test('removes a clean detached worktree straight away, with its empty branch name', async () => {
    const user = userEvent.setup()

    await clickRemove(user, renderItem())

    await waitFor(() => expect(unbranchWorktree).toHaveBeenCalledTimes(1))
    expect(unbranchWorktree).toHaveBeenCalledWith(
      detachedWorktree.id,
      detachedWorktree.path,
      '',
      project.path
    )
    expect(screen.queryByRole('alertdialog')).toBeNull()
  })

  test('asks before removing one whose commits are on no branch', async () => {
    const user = userEvent.setup()
    gitApiMocks.getUnreachableCommits.mockResolvedValue({
      success: true,
      count: 1,
      commits: [{ hash: 'abc1234', subject: 'stray commit' }]
    })

    await clickRemove(user, renderItem())

    const dialog = await screen.findByRole('alertdialog')
    expect(dialog).toHaveTextContent('my-app-deploy has 1 commit that is not on any branch.')
    expect(dialog).toHaveTextContent('stray commit')
    expect(unbranchWorktree).not.toHaveBeenCalled()

    await user.click(screen.getByRole('button', { name: 'Remove Anyway' }))

    await waitFor(() => expect(unbranchWorktree).toHaveBeenCalledTimes(1))
  })

  test('keeps the worktree when the removal is cancelled', async () => {
    const user = userEvent.setup()
    gitApiMocks.getDiffStat.mockResolvedValue({
      success: true,
      files: [{ path: 'src/App.tsx', additions: 3, deletions: 1, binary: false }]
    })

    await clickRemove(user, renderItem())
    await user.click(await screen.findByRole('button', { name: 'Cancel' }))

    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull())
    expect(unbranchWorktree).not.toHaveBeenCalled()
  })
})
