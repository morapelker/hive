import { useState } from 'react'
import type { DetachedRemovalRisk } from '@/lib/detached-worktree'
import { DirtyFilesConfirmDialog } from './DirtyFilesConfirmDialog'

interface RemoveWorktreeConfirmDialogProps {
  worktreeName: string
  /** What the removal would destroy; null keeps the dialog closed. */
  risk: DetachedRemovalRisk | null
  onCancel: () => void
  onConfirm: () => void
}

function describeRisk(risk: DetachedRemovalRisk): string {
  const commits =
    risk.commitCount === 1
      ? '1 commit that is not on any branch'
      : `${risk.commitCount} commits that are not on any branch`
  if (risk.commitCount > 0 && risk.files.length > 0) {
    return `has ${commits} and uncommitted changes. Removing the worktree loses both for good.`
  }
  if (risk.commitCount > 0) {
    return `has ${commits}. Removing the worktree loses ${risk.commitCount === 1 ? 'it' : 'them'} for good.`
  }
  return 'has uncommitted changes that will be permanently lost.'
}

/**
 * Asks before removing a detached-HEAD worktree that holds work found nowhere else: unlike a
 * worktree on a branch, its commits have no ref to survive the removal.
 */
export function RemoveWorktreeConfirmDialog({
  worktreeName,
  risk,
  onCancel,
  onConfirm
}: RemoveWorktreeConfirmDialogProps): React.JSX.Element {
  // Keep the last risk on screen while the dialog animates shut, instead of blanking it.
  const [shown, setShown] = useState(risk)
  if (risk && risk !== shown) setShown(risk)

  return (
    <DirtyFilesConfirmDialog
      open={risk !== null}
      worktreeName={worktreeName}
      title="Remove Worktree?"
      files={shown?.files ?? []}
      commits={shown ? { count: shown.commitCount, commits: shown.commits } : undefined}
      description={shown ? describeRisk(shown) : ''}
      confirmLabel="Remove Anyway"
      confirmVariant="destructive"
      onCancel={onCancel}
      onConfirm={onConfirm}
    />
  )
}
