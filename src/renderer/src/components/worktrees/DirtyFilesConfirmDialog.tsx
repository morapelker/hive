import {
  AlertTriangle,
  FileText,
  FilePlus,
  FileX,
  FileDiff,
  GitCommitHorizontal
} from 'lucide-react'
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
const MAX_COMMITS_SHOWN = 5

export interface DiffStatFile {
  path: string
  additions: number
  deletions: number
  binary: boolean
}

/** Commits the action would orphan, listed above the files. */
export interface UnreachableCommits {
  /** How many there are in all; `commits` may hold only the newest. */
  count: number
  commits: Array<{ hash: string; subject: string }>
}

interface DirtyFilesConfirmDialogProps {
  open: boolean
  worktreeName: string
  files: DiffStatFile[]
  /** Defaults to "Uncommitted Changes". */
  title?: string
  commits?: UnreachableCommits
  description: string
  confirmLabel: string
  confirmVariant?: 'default' | 'destructive' | 'outline' | 'secondary' | 'ghost' | 'link'
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
  return parts[parts.length - 1] || path
}

function fileDir(path: string): string {
  const parts = path.split('/')
  if (parts.length <= 1) return ''
  return parts.slice(0, -1).join('/') + '/'
}

export function DirtyFilesConfirmDialog({
  open,
  worktreeName,
  files,
  title = 'Uncommitted Changes',
  commits,
  description,
  confirmLabel,
  confirmVariant = 'destructive',
  onCancel,
  onConfirm
}: DirtyFilesConfirmDialogProps): React.JSX.Element {
  const shownFiles = files.slice(0, MAX_FILES_SHOWN)
  const remainingCount = files.length - shownFiles.length
  const shownCommits = commits?.commits.slice(0, MAX_COMMITS_SHOWN) ?? []
  const remainingCommits = (commits?.count ?? 0) - shownCommits.length

  return (
    <AlertDialog open={open} onOpenChange={(isOpen) => !isOpen && onCancel()}>
      <AlertDialogContent>
        <AlertDialogHeader className="min-w-0">
          <AlertDialogTitle className="flex min-w-0 items-center gap-2 text-left">
            <AlertTriangle className="h-5 w-5 shrink-0 text-destructive" />
            {title}
          </AlertDialogTitle>
          <AlertDialogDescription asChild>
            <div className="min-w-0 space-y-3">
              <p className="min-w-0 [overflow-wrap:anywhere]">
                <span className="font-medium text-foreground">{worktreeName}</span> {description}
              </p>

              {shownCommits.length > 0 && (
                <div
                  className="min-w-0 overflow-hidden rounded-md border bg-muted/50"
                  data-testid="unreachable-commits"
                >
                  <div className="divide-y divide-border">
                    {shownCommits.map((commit) => (
                      <div
                        key={commit.hash}
                        className="grid grid-cols-[auto_minmax(0,1fr)] items-start gap-2 px-3 py-1.5 text-xs font-mono"
                      >
                        <GitCommitHorizontal className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-400" />
                        <span
                          className="min-w-0 whitespace-normal leading-relaxed [overflow-wrap:anywhere]"
                          title={commit.subject}
                        >
                          <span className="text-muted-foreground">{commit.hash}</span>{' '}
                          <span className="text-foreground">{commit.subject}</span>
                        </span>
                      </div>
                    ))}
                  </div>
                  {remainingCommits > 0 && (
                    <div className="px-3 py-1.5 text-xs text-muted-foreground border-t bg-muted/30">
                      +{remainingCommits} more {remainingCommits === 1 ? 'commit' : 'commits'}
                    </div>
                  )}
                </div>
              )}

              {shownFiles.length > 0 && (
                <div className="min-w-0 max-h-[40vh] overflow-y-auto overflow-x-hidden rounded-md border bg-muted/50">
                  <div className="divide-y divide-border">
                    {shownFiles.map((file) => (
                      <div
                        key={file.path}
                        className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-start gap-2 px-3 py-1.5 text-xs font-mono"
                      >
                        {getFileIcon(file)}
                        <span
                          className="min-w-0 whitespace-normal leading-relaxed [overflow-wrap:anywhere]"
                          title={file.path}
                        >
                          <span className="text-muted-foreground">{fileDir(file.path)}</span>
                          <span className="text-foreground">{fileName(file.path)}</span>
                        </span>
                        <span className="mt-0.5 shrink-0 tabular-nums text-[11px]">
                          {formatStat(file)}
                        </span>
                      </div>
                    ))}
                  </div>
                  {remainingCount > 0 && (
                    <div className="px-3 py-1.5 text-xs text-muted-foreground border-t bg-muted/30">
                      +{remainingCount} more {remainingCount === 1 ? 'file' : 'files'}
                    </div>
                  )}
                </div>
              )}
            </div>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel onClick={onCancel}>Cancel</AlertDialogCancel>
          <AlertDialogAction variant={confirmVariant} onClick={onConfirm}>
            {confirmLabel}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
