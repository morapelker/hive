import { useState, useCallback, useEffect, useRef, useMemo } from 'react'
import { Loader2 } from 'lucide-react'
import { toast } from '@/lib/toast'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { useGitStore } from '@/stores/useGitStore'
import { useWorktreeStore } from '@/stores/useWorktreeStore'
import { cn } from '@/lib/utils'

interface GitCommitFormProps {
  worktreePath: string | null
  className?: string
}

const SUMMARY_WARN_LENGTH = 50
const SUMMARY_ERROR_LENGTH = 72

export function GitCommitForm({
  worktreePath,
  className
}: GitCommitFormProps): React.JSX.Element | null {
  const [summary, setSummary] = useState('')
  const [description, setDescription] = useState('')
  const summaryInputRef = useRef<HTMLInputElement>(null)

  const { commit, isCommitting } = useGitStore()

  // Look up worktree to get session_titles for pre-populating commit message
  const worktreesByProject = useWorktreeStore((state) => state.worktreesByProject)
  const sessionTitles: string[] = useMemo(() => {
    if (!worktreePath) return []
    for (const worktrees of worktreesByProject.values()) {
      const wt = worktrees.find((w) => w.path === worktreePath)
      if (wt?.session_titles) {
        try {
          return JSON.parse(wt.session_titles)
        } catch {
          return []
        }
      }
    }
    return []
  }, [worktreePath, worktreesByProject])

  // Pre-populate summary and description from session titles on mount
  const hasPrePopulated = useRef(false)
  useEffect(() => {
    if (hasPrePopulated.current) return
    if (sessionTitles.length > 0 && !summary) {
      hasPrePopulated.current = true
      setSummary(sessionTitles[0])
      if (sessionTitles.length > 1) {
        setDescription(sessionTitles.map((t) => `- ${t}`).join('\n'))
      }
    }
  }, [sessionTitles]) // eslint-disable-line react-hooks/exhaustive-deps

  // Subscribe to store state for staged files count
  const fileStatusesByWorktree = useGitStore((state) => state.fileStatusesByWorktree)

  // Calculate staged files count
  const stagedFilesCount = useMemo(() => {
    if (!worktreePath) return 0
    const files = fileStatusesByWorktree.get(worktreePath) || []
    return files.filter((f) => f.staged).length
  }, [worktreePath, fileStatusesByWorktree])

  const hasStaged = stagedFilesCount > 0
  const hasSummary = summary.trim().length > 0
  const canCommit = hasStaged && hasSummary && !isCommitting

  // Character count status for summary
  const summaryLength = summary.length
  const summaryStatus = useMemo(() => {
    if (summaryLength > SUMMARY_ERROR_LENGTH) return 'error'
    if (summaryLength > SUMMARY_WARN_LENGTH) return 'warn'
    return 'ok'
  }, [summaryLength])

  const handleCommit = useCallback(async () => {
    if (!worktreePath || !canCommit) return

    // Build commit message
    const message = description.trim()
      ? `${summary.trim()}\n\n${description.trim()}`
      : summary.trim()

    const result = await commit(worktreePath, message)

    if (result.success) {
      toast.success('Changes committed successfully', {
        description: result.commitHash ? `Commit: ${result.commitHash.slice(0, 7)}` : undefined
      })
      // Clear form
      setSummary('')
      setDescription('')
    } else {
      toast.error('Failed to commit', {
        description: result.error
      })
    }
  }, [worktreePath, canCommit, summary, description, commit])

  // Keyboard shortcut: Cmd/Ctrl+Enter to commit
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent): void => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
        // Only trigger if form is focused
        if (
          document.activeElement === summaryInputRef.current ||
          document.activeElement?.closest('[data-commit-form]')
        ) {
          e.preventDefault()
          if (canCommit) {
            handleCommit()
          }
        }
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [canCommit, handleCommit])

  if (!worktreePath) {
    return null
  }

  return (
    <div
      className={cn('flex flex-col gap-2 px-2 py-2', className)}
      data-testid="git-commit-form"
      data-commit-form
    >
      {/* Summary input */}
      <div className="relative">
        <Input
          ref={summaryInputRef}
          value={summary}
          onChange={(e) => setSummary(e.target.value)}
          placeholder="Commit summary"
          className={cn(
            'text-xs h-7 pr-12',
            summaryStatus === 'error' && 'border-red-500 focus-visible:ring-red-500',
            summaryStatus === 'warn' && 'border-yellow-500 focus-visible:ring-yellow-500'
          )}
          disabled={isCommitting}
          data-testid="commit-summary-input"
        />
        <span
          className={cn(
            'absolute right-2 top-1/2 -translate-y-1/2 text-[10px] font-mono',
            summaryStatus === 'error' && 'text-red-500',
            summaryStatus === 'warn' && 'text-yellow-500',
            summaryStatus === 'ok' && 'text-muted-foreground'
          )}
          data-testid="commit-char-count"
        >
          {summaryLength}/{SUMMARY_ERROR_LENGTH}
        </span>
      </div>

      {/* Description textarea (collapsible) */}
      <Textarea
        value={description}
        onChange={(e) => setDescription(e.target.value)}
        placeholder="Extended description (optional)"
        className="text-xs min-h-[40px] resize-none"
        rows={2}
        disabled={isCommitting}
        data-testid="commit-description-input"
      />

      {/* Commit button */}
      <Button
        onClick={handleCommit}
        disabled={!canCommit}
        size="sm"
        className="w-full h-7 text-xs"
        data-testid="commit-button"
      >
        {isCommitting ? (
          <>
            <Loader2 className="h-3 w-3 mr-1 animate-spin" />
            Committing...
          </>
        ) : (
          <>
            Commit
            {hasStaged && (
              <span className="ml-1 text-[10px] opacity-75">
                ({stagedFilesCount} file{stagedFilesCount !== 1 ? 's' : ''})
              </span>
            )}
          </>
        )}
      </Button>

      {/* Help text */}
      <div className="text-[10px] text-muted-foreground text-center">
        {navigator.platform.includes('Mac') ? 'Cmd' : 'Ctrl'}+Enter to commit
      </div>
    </div>
  )
}
