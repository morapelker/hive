import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, test, vi } from 'vitest'
import { DirtyFilesConfirmDialog } from '../../src/renderer/src/components/worktrees/DirtyFilesConfirmDialog'
import { RemoveWorktreeConfirmDialog } from '../../src/renderer/src/components/worktrees/RemoveWorktreeConfirmDialog'

const longPath =
  'docs/superpowers/plans/2026-04-23-replace-ad-library-api-with-play-mode-and-extra-long-file-name-that-would-previously-push-actions-outside-the-dialog.md'

describe('DirtyFilesConfirmDialog', () => {
  test('wraps long file paths without losing access to action buttons', async () => {
    const user = userEvent.setup()
    const onCancel = vi.fn()
    const onConfirm = vi.fn()

    render(
      <DirtyFilesConfirmDialog
        open
        worktreeName="replace-ad-library-api-with-play-mode-and-a-very-long-worktree-name"
        files={[
          {
            path: longPath,
            additions: 12,
            deletions: 3,
            binary: false
          }
        ]}
        description="has uncommitted changes that won't be included in the merge."
        confirmLabel="Merge Anyway"
        confirmVariant="destructive"
        onCancel={onCancel}
        onConfirm={onConfirm}
      />
    )

    const dialog = document.querySelector('[data-slot="alert-dialog-content"]')
    expect(dialog).toHaveClass('grid-cols-[minmax(0,1fr)]')

    const path = screen.getByTitle(longPath)
    expect(path).toHaveClass('whitespace-normal')
    expect(path).toHaveClass('[overflow-wrap:anywhere]')
    expect(path).not.toHaveClass('truncate')

    const cancel = screen.getByRole('button', { name: 'Cancel' })
    const confirm = screen.getByRole('button', { name: 'Merge Anyway' })

    expect(cancel).toBeVisible()
    expect(confirm).toBeVisible()

    await user.click(confirm)
    expect(onConfirm).toHaveBeenCalledTimes(1)
  })
})

describe('RemoveWorktreeConfirmDialog', () => {
  const commits = Array.from({ length: 6 }, (_, index) => ({
    hash: `abc000${index}`,
    subject: `stray commit ${index}`
  }))
  const file = { path: 'src/App.tsx', additions: 3, deletions: 1, binary: false }

  test('stays closed while there is nothing to confirm', () => {
    render(
      <RemoveWorktreeConfirmDialog
        worktreeName="my-app-deploy"
        risk={null}
        onCancel={vi.fn()}
        onConfirm={vi.fn()}
      />
    )

    expect(screen.queryByRole('alertdialog')).toBeNull()
  })

  test('lists the commits and files a detached worktree would take with it', async () => {
    const user = userEvent.setup()
    const onConfirm = vi.fn()

    render(
      <RemoveWorktreeConfirmDialog
        worktreeName="my-app-deploy"
        risk={{ files: [file], commitCount: 8, commits }}
        onCancel={vi.fn()}
        onConfirm={onConfirm}
      />
    )

    expect(screen.getByRole('alertdialog')).toHaveTextContent('Remove Worktree?')
    expect(screen.getByRole('alertdialog')).toHaveTextContent(
      'my-app-deploy has 8 commits that are not on any branch and uncommitted changes.'
    )
    // The newest five are listed; the rest of the eight are counted.
    expect(screen.getByText('stray commit 0')).toBeVisible()
    expect(screen.getByText('stray commit 4')).toBeVisible()
    expect(screen.queryByText('stray commit 5')).toBeNull()
    expect(screen.getByTestId('unreachable-commits')).toHaveTextContent('+3 more commits')
    expect(screen.getByTitle('src/App.tsx')).toBeVisible()

    await user.click(screen.getByRole('button', { name: 'Remove Anyway' }))
    expect(onConfirm).toHaveBeenCalledTimes(1)
  })

  test('words a single stray commit and a dirty-only worktree on their own', () => {
    const { rerender } = render(
      <RemoveWorktreeConfirmDialog
        worktreeName="my-app-deploy"
        risk={{ files: [], commitCount: 1, commits: commits.slice(0, 1) }}
        onCancel={vi.fn()}
        onConfirm={vi.fn()}
      />
    )

    expect(screen.getByRole('alertdialog')).toHaveTextContent(
      'my-app-deploy has 1 commit that is not on any branch. Removing the worktree loses it for good.'
    )
    expect(screen.queryByTitle('src/App.tsx')).toBeNull()

    rerender(
      <RemoveWorktreeConfirmDialog
        worktreeName="my-app-deploy"
        risk={{ files: [file], commitCount: 0, commits: [] }}
        onCancel={vi.fn()}
        onConfirm={vi.fn()}
      />
    )

    expect(screen.getByRole('alertdialog')).toHaveTextContent(
      'my-app-deploy has uncommitted changes that will be permanently lost.'
    )
    expect(screen.queryByTestId('unreachable-commits')).toBeNull()
  })
})
