import { DirtyFilesConfirmDialog } from './DirtyFilesConfirmDialog'
import type { DiffStatFile } from './DirtyFilesConfirmDialog'

interface MergeConfirmDialogProps {
  open: boolean
  worktreeName: string
  files: DiffStatFile[]
  onCancel: () => void
  onConfirm: () => void
}

export function MergeConfirmDialog(props: MergeConfirmDialogProps): React.JSX.Element {
  return (
    <DirtyFilesConfirmDialog
      {...props}
      description="has uncommitted changes that won't be included in the merge."
      confirmLabel="Merge Anyway"
      confirmVariant="destructive"
    />
  )
}
