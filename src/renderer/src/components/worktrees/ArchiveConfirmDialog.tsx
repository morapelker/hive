import { AlertTriangle, FileText, FilePlus, FileX, FileDiff } from 'lucide-react'
import { cn } from '@/lib/utils'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle
} from '@/components/ui/alert-dialog'

const MAX_FILES_SHOWN = 5

interface DiffStatFile {
  path: string
  additions: number
  deletions: number
  binary: boolean
}

interface ArchiveConfirmDialogProps {
  open: boolean
  worktreeName: string
  files: DiffStatFile[]
  onCancel: () => void
  onConfirm: () => void
}

function getFileIcon(file: DiffStatFile): React.JSX.Element {
  const cls = 'h-3.5 w-3.5 shrink-0'
  if (file.deletions > 0 && file.additions === 0) {
    return <FileX className={cn(cls, 'text-red-400')} />
  }
  if (file.additions > 0 && file.deletions === 0) {
    return <FilePlus className={cn(cls, 'text-green-400')} />
  }
  if (file.additions > 0 || file.deletions > 0) {
    return <FileDiff className={cn(cls, 'text-amber-400')} />
  }
  return <FileText className={cn(cls, 'text-muted-foreground')} />
}

function formatStat(file: DiffStatFile): React.JSX.Element {
  if (file.binary) {
    return <span className="text-muted-foreground">binary</span>
  }
  return (
    <span className="flex items-center gap-1.5">
      {file.additions > 0 && <span className="text-green-400">+{file.additions}</span>}
      {file.deletions > 0 && <span className="text-red-400">-{file.deletions}</span>}
      {file.additions === 0 && file.deletions === 0 && (
        <span className="text-muted-foreground">no changes</span>
      )}
    </span>
  )
}

function fileName(path: string): string {
  const parts = path.split('/')
  return parts[parts.length - 1]
}

function fileDir(path: string): string {
  const parts = path.split('/')
  if (parts.length <= 1) return ''
  return parts.slice(0, -1).join('/') + '/'
}

export function ArchiveConfirmDialog({
  open,
  worktreeName,
  files,
  onCancel,
  onConfirm
}: ArchiveConfirmDialogProps): React.JSX.Element {
  const shownFiles = files.slice(0, MAX_FILES_SHOWN)
  const remainingCount = files.length - shownFiles.length

  return (
    <AlertDialog open={open} onOpenChange={(isOpen) => !isOpen && onCancel()}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle className="flex items-center gap-2">
            <AlertTriangle className="h-5 w-5 text-destructive" />
            Uncommitted Changes
          </AlertDialogTitle>
          <AlertDialogDescription asChild>
            <div className="space-y-3">
              <p>
                <span className="font-medium text-foreground">{worktreeName}</span> has uncommitted
                changes that will be permanently lost.
              </p>

              <div className="rounded-md border bg-muted/50 overflow-hidden">
                <div className="divide-y divide-border">
                  {shownFiles.map((file) => (
                    <div
                      key={file.path}
                      className="flex items-center gap-2 px-3 py-1.5 text-xs font-mono"
                    >
                      {getFileIcon(file)}
                      <span className="truncate flex-1" title={file.path}>
                        <span className="text-muted-foreground">{fileDir(file.path)}</span>
                        <span className="text-foreground">{fileName(file.path)}</span>
                      </span>
                      <span className="shrink-0 tabular-nums text-[11px]">{formatStat(file)}</span>
                    </div>
                  ))}
                </div>
                {remainingCount > 0 && (
                  <div className="px-3 py-1.5 text-xs text-muted-foreground border-t bg-muted/30">
                    +{remainingCount} more {remainingCount === 1 ? 'file' : 'files'}
                  </div>
                )}
              </div>
            </div>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel onClick={onCancel}>Cancel</AlertDialogCancel>
          <AlertDialogAction variant="destructive" onClick={onConfirm}>
            Archive Anyway
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
