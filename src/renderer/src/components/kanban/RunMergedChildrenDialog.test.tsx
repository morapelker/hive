/**
 * The dialog the "Move merged tickets to Done…" item of a run ticket's menu opens: it shows
 * what the check of the run's merged branches found, lets the user leave tickets out and keep
 * the worktrees, and hands the rest to the move.
 */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { makeDetail } from '@/components/document-flow/test-fixtures'
import type { MergedChildrenPlan } from '@/lib/document-flow/run-merged-children'
import { useDocumentFlowStore } from '@/stores/useDocumentFlowStore'
import { useRunMergedChildrenStore } from '@/stores/useRunMergedChildrenStore'
import { RunMergedChildrenDialog } from './RunMergedChildrenDialog'

const lib = vi.hoisted(() => ({
  loadMergedChildrenPlan: vi.fn(),
  moveMergedChildrenToDone: vi.fn()
}))
const toastMocks = vi.hoisted(() => ({
  success: vi.fn(),
  error: vi.fn(),
  warning: vi.fn(),
  info: vi.fn()
}))

vi.mock('@/lib/document-flow/run-merged-children', () => lib)
vi.mock('@/lib/toast', () => ({ toast: toastMocks }))

const target = { runId: 'run-1', ticketId: 'run-ticket', projectId: 'proj' }

const worktree = (key: string): MergedChildrenPlan['children'][number]['worktrees'][number] => ({
  worktreeId: `wt-${key}`,
  worktreePath: `/wt/${key}`,
  branch: `${key}-branch`,
  projectPath: '/repo',
  compareBranch: 'doc-run'
})

const PLAN: MergedChildrenPlan = {
  children: [
    { itemId: 'item-A1', label: 'A1 · Alpha', ticketIds: ['t-a'], worktrees: [worktree('a1')], worktreeKept: null },
    { itemId: 'item-A2', label: 'A2 · Beta', ticketIds: ['t-b'], worktrees: [], worktreeKept: 'it has uncommitted changes' },
    { itemId: 'item-A3', label: 'A3 · Gamma', ticketIds: [], worktrees: [worktree('a3')], worktreeKept: null }
  ],
  held: [{ itemId: 'item-A4', label: 'A4 · Delta', reason: 'its session is updating the document' }]
}

function open(): void {
  render(<RunMergedChildrenDialog />)
  act(() => useRunMergedChildrenStore.getState().open(target))
}

const row = (itemId: string): HTMLElement => screen.getByTestId(`run-merged-child-${itemId}`)
const confirm = (): HTMLElement => screen.getByTestId('run-merged-children-confirm')

beforeEach(() => {
  vi.clearAllMocks()
  lib.loadMergedChildrenPlan.mockResolvedValue(PLAN)
  lib.moveMergedChildrenToDone.mockResolvedValue({
    moved: 2,
    skipped: [],
    archiving: 2,
    archive: Promise.resolve()
  })
  useDocumentFlowStore.setState({
    runsById: {
      'run-1': makeDetail({ id: 'run-1', title: 'Checkout', status: 'running', integration_branch: 'doc-run' }, [])
    }
  })
})

afterEach(() => {
  cleanup()
  useRunMergedChildrenStore.setState({ target: null })
})

describe('RunMergedChildrenDialog', () => {
  it('renders nothing until a run ticket opens it', () => {
    render(<RunMergedChildrenDialog />)

    expect(screen.queryByTestId('run-merged-children-dialog')).toBeNull()
    expect(lib.loadMergedChildrenPlan).not.toHaveBeenCalled()
  })

  it('lists the merged tickets with what becomes of each worktree, and the ones held back', async () => {
    // The branches are checked with git first: the dialog says so until that is over
    let checked: (plan: MergedChildrenPlan) => void = () => {}
    lib.loadMergedChildrenPlan.mockReturnValue(
      new Promise<MergedChildrenPlan>((resolve) => {
        checked = resolve
      })
    )
    open()

    expect(screen.getByTestId('run-merged-children-loading')).toBeInTheDocument()
    expect(lib.loadMergedChildrenPlan).toHaveBeenCalledWith(target)
    await act(async () => checked(PLAN))
    await screen.findByTestId('run-merged-children-list')
    expect(screen.queryByTestId('run-merged-children-loading')).toBeNull()

    expect(row('item-A1')).toHaveTextContent('A1 · Alpha')
    expect(row('item-A1')).toHaveTextContent('Archives a1-branch')
    expect(row('item-A2')).toHaveTextContent('Worktree kept: it has uncommitted changes')
    expect(row('item-A3')).toHaveTextContent('Already in Done · Archives a3-branch')
    expect(screen.getByTestId('run-merged-children-held')).toHaveTextContent(
      'A4 · Delta (its session is updating the document)'
    )
    // The run's branch is named as what stays
    expect(screen.getByTestId('run-merged-children-dialog')).toHaveTextContent(
      'own ticket and doc-run stay as they are'
    )
    // Two tickets move (the third is in Done already), two worktrees go
    expect(confirm()).toHaveTextContent('Move 2 to Done')
    expect(screen.getByTestId('run-merged-children-dialog')).toHaveTextContent(
      'Archive their worktrees (2)'
    )
  })

  it('moves every listed ticket and archives the worktrees by default', async () => {
    open()
    await screen.findByTestId('run-merged-children-list')

    fireEvent.click(confirm())

    await waitFor(() => expect(useRunMergedChildrenStore.getState().target).toBeNull())
    expect(lib.moveMergedChildrenToDone).toHaveBeenCalledWith(target, PLAN.children, {
      archiveWorktrees: true
    })
  })

  it('leaves out a ticket the user unchecks', async () => {
    open()
    await screen.findByTestId('run-merged-children-list')

    fireEvent.click(within(row('item-A1')).getByRole('checkbox'))
    expect(confirm()).toHaveTextContent('Move 1 to Done')
    fireEvent.click(confirm())

    await waitFor(() => expect(lib.moveMergedChildrenToDone).toHaveBeenCalled())
    expect(lib.moveMergedChildrenToDone).toHaveBeenCalledWith(
      target,
      [PLAN.children[1], PLAN.children[2]],
      { archiveWorktrees: true }
    )
  })

  it('keeps the worktrees when asked to, and then has nothing to do for a ticket already in Done', async () => {
    open()
    await screen.findByTestId('run-merged-children-list')

    fireEvent.click(screen.getByTestId('run-merged-children-archive'))
    expect(row('item-A1')).toHaveTextContent('Keeps a1-branch')
    fireEvent.click(confirm())

    await waitFor(() => expect(lib.moveMergedChildrenToDone).toHaveBeenCalled())
    expect(lib.moveMergedChildrenToDone).toHaveBeenCalledWith(
      target,
      [PLAN.children[0], PLAN.children[1]],
      { archiveWorktrees: false }
    )
  })

  it('offers to archive the worktrees alone when every ticket left is in Done already', async () => {
    open()
    await screen.findByTestId('run-merged-children-list')

    fireEvent.click(within(row('item-A1')).getByRole('checkbox'))
    fireEvent.click(within(row('item-A2')).getByRole('checkbox'))

    expect(confirm()).toHaveTextContent('Archive 1 worktree')
    fireEvent.click(screen.getByTestId('run-merged-children-archive'))
    expect(confirm()).toBeDisabled()
  })

  it('says so when no merged ticket is waiting, and still names the ones held back', async () => {
    lib.loadMergedChildrenPlan.mockResolvedValue({ children: [], held: PLAN.held })
    open()

    expect(await screen.findByTestId('run-merged-children-empty')).toHaveTextContent(
      'No merged ticket of this document run is waiting to be moved.'
    )
    expect(screen.getByTestId('run-merged-children-held')).toBeInTheDocument()
    expect(screen.queryByTestId('run-merged-children-confirm')).toBeNull()
  })

  it('stays open and says why when the move fails', async () => {
    lib.moveMergedChildrenToDone.mockRejectedValue(new Error('The run no longer exists.'))
    open()
    await screen.findByTestId('run-merged-children-list')

    fireEvent.click(confirm())

    await waitFor(() =>
      expect(toastMocks.error).toHaveBeenCalledWith(
        'Could not move the tickets: The run no longer exists.'
      )
    )
    expect(useRunMergedChildrenStore.getState().target).toEqual(target)
    expect(confirm()).not.toBeDisabled()
  })

  it('shows a check that failed instead of an empty list', async () => {
    lib.loadMergedChildrenPlan.mockRejectedValue(new Error('server is down'))
    open()

    expect(await screen.findByTestId('run-merged-children-error')).toHaveTextContent(
      'Could not check the branches: server is down'
    )
  })
})
