import { useState, useEffect } from 'react'
import { Loader2, FileText, FilePlus, FileX, FileDiff } from 'lucide-react'
import { toast } from '@/lib/toast'
import { cn } from '@/lib/utils'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { useGitStore } from '@/stores/useGitStore'

const MAX_FILES_SHOWN = 15

interface DiffStatFile {
  path: string
  additions: number
  deletions: number
  binary: boolean
}

interface CreatePRModalProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  worktreePath: string
  worktreeId: string
  branchName: string
  defaultTargetBranch: string
  remoteBranches: Array<{ name: string; isRemote: boolean }>
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

export function CreatePRModal({
  open,
  onOpenChange,
  worktreePath,
  worktreeId,
  branchName,
  defaultTargetBranch,
  remoteBranches
}: CreatePRModalProps): React.JSX.Element {
  const [title, setTitle] = useState('')
  const [body, setBody] = useState('')
  const [targetBranch, setTargetBranch] = useState(defaultTargetBranch)
  const [files, setFiles] = useState<DiffStatFile[]>([])
  const [isLoading, setIsLoading] = useState(false)
  const [isCreating, setIsCreating] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Reset form state when modal opens
  useEffect(() => {
    if (open) {
      setTitle('')
      setBody('')
      setError(null)
      setTargetBranch(defaultTargetBranch)
    }
  }, [open, defaultTargetBranch])

  // Fetch diff stat when open or target branch changes
  useEffect(() => {
    if (!open || !targetBranch) return

    setIsLoading(true)
    setError(null)
    window.gitOps
      .getBranchDiffStat(worktreePath, targetBranch)
      .then((result) => {
        if (result.success && result.files) {
          setFiles(result.files)
        } else {
          setFiles([])
          setError(result.error || 'Failed to load diff')
        }
      })
      .catch((err) => {
        setFiles([])
        setError(err instanceof Error ? err.message : 'Failed to load diff')
      })
      .finally(() => {
        setIsLoading(false)
      })
  }, [open, targetBranch, worktreePath])

  const handleCreate = async (): Promise<void> => {
    setIsCreating(true)
    setError(null)

    try {
      const result = await window.gitOps.prCreate({
        worktreePath,
        worktreeId,
        title,
        body,
        baseBranch: targetBranch
      })

      if (result.success) {
        useGitStore.getState().setPrState(worktreeId, {
          state: 'created',
          prNumber: result.prNumber,
          prUrl: result.prUrl,
          targetBranch
        })
        toast.success('Pull request created', {
          description: result.prUrl
        })
        onOpenChange(false)
      } else {
        setError(result.error || 'Failed to create pull request')
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create pull request')
    } finally {
      setIsCreating(false)
    }
  }

  const shownFiles = files.slice(0, MAX_FILES_SHOWN)
  const remainingCount = files.length - shownFiles.length

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Create Pull Request</DialogTitle>
          <DialogDescription>
            {branchName} &rarr; {targetBranch}
          </DialogDescription>
        </DialogHeader>

        {/* Target Branch Selector */}
        <div className="space-y-1.5">
          <label className="text-sm font-medium" htmlFor="target-branch">
            Target branch
          </label>
          <select
            id="target-branch"
            value={targetBranch}
            onChange={(e) => setTargetBranch(e.target.value)}
            disabled={isCreating}
            className={cn(
              'flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1',
              'text-sm shadow-sm transition-colors',
              'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring',
              'disabled:cursor-not-allowed disabled:opacity-50'
            )}
          >
            {remoteBranches.map((branch) => (
              <option key={branch.name} value={branch.name}>
                {branch.name.replace(/^origin\//, '')}
              </option>
            ))}
          </select>
        </div>

        {/* File List */}
        {isLoading ? (
          <div className="flex items-center justify-center py-6">
            <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
            <span className="ml-2 text-sm text-muted-foreground">Loading changes...</span>
          </div>
        ) : files.length > 0 ? (
          <div className="rounded-md border bg-muted/50 overflow-hidden max-h-48 overflow-y-auto">
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
        ) : (
          !error && (
            <div className="text-sm text-muted-foreground text-center py-4">
              No changes between branches
            </div>
          )
        )}

        {/* Title Input */}
        <Input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="PR title (leave empty to auto-generate)"
          disabled={isCreating}
        />

        {/* Body Textarea */}
        <Textarea
          value={body}
          onChange={(e) => setBody(e.target.value)}
          placeholder="Description (leave empty to auto-generate)"
          rows={6}
          disabled={isCreating}
        />

        {/* Hint */}
        <p className="text-xs text-muted-foreground">
          Leave title and description empty to auto-generate using AI
        </p>

        {/* Error */}
        {error && (
          <p className="text-sm text-destructive">{error}</p>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={isCreating}>
            Cancel
          </Button>
          <Button
            onClick={handleCreate}
            disabled={isCreating || isLoading || files.length === 0}
          >
            {isCreating && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
            Create PR
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
