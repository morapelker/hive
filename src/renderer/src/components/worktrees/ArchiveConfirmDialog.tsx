import { DirtyFilesConfirmDialog } from './DirtyFilesConfirmDialog'
import type { DiffStatFile } from './DirtyFilesConfirmDialog'

interface ArchiveConfirmDialogProps {
  open: boolean
  worktreeName: string
  files: DiffStatFile[]
  onCancel: () => void
  onConfirm: () => void
}

export function ArchiveConfirmDialog(props: ArchiveConfirmDialogProps): React.JSX.Element {
  return (
    <DirtyFilesConfirmDialog
      {...props}
      description="has uncommitted changes that will be permanently lost."
      confirmLabel="Archive Anyway"
      confirmVariant="destructive"
    />
  )
}
