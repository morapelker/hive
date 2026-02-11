import { useState, useEffect, useCallback, useMemo } from 'react'
import {
  ChevronDown,
  ChevronRight,
  RefreshCw,
  GitBranch,
  ArrowUp,
  ArrowDown,
  Plus,
  Minus,
  FileDiff,
  FileSearch,
  Loader2,
  AlertTriangle
} from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { useGitStore, type GitFileStatus } from '@/stores/useGitStore'
import { useWorktreeStore } from '@/stores/useWorktreeStore'
import { useSessionStore } from '@/stores/useSessionStore'
import { useFileViewerStore } from '@/stores/useFileViewerStore'
import { GitCommitForm } from './GitCommitForm'
import { GitPushPull } from './GitPushPull'
import { cn } from '@/lib/utils'

interface GitStatusPanelProps {
  worktreePath: string | null
  className?: string
}

interface CollapsibleSectionProps {
  title: string
  count: number
  defaultOpen?: boolean
  children: React.ReactNode
  action?: React.ReactNode
  testId?: string
}

function CollapsibleSection({
  title,
  count,
  defaultOpen = true,
  children,
  action,
  testId
}: CollapsibleSectionProps): React.JSX.Element {
  const [isOpen, setIsOpen] = useState(defaultOpen)

  if (count === 0) return <></>

  return (
    <div className="border-b last:border-b-0" data-testid={testId}>
      <button
        type="button"
        className="flex items-center justify-between w-full px-2 py-1.5 text-xs font-medium text-muted-foreground hover:bg-accent/50"
        onClick={() => setIsOpen(!isOpen)}
      >
        <span className="flex items-center gap-1">
          {isOpen ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
          {title}
          <span className="text-[10px] px-1 py-0.5 rounded bg-muted">{count}</span>
        </span>
        {action && <span onClick={(e) => e.stopPropagation()}>{action}</span>}
      </button>
      {isOpen && <div className="pb-1">{children}</div>}
    </div>
  )
}

interface FileItemProps {
  file: GitFileStatus
  onToggle: (file: GitFileStatus) => void
  onViewDiff: (file: GitFileStatus) => void
  isStaged: boolean
}

function FileItem({ file, onToggle, onViewDiff, isStaged }: FileItemProps): React.JSX.Element {
  const statusColors: Record<string, string> = {
    M: 'text-yellow-500',
    A: 'text-green-500',
    D: 'text-red-500',
    '?': 'text-gray-400',
    C: 'text-red-600 font-bold'
  }

  return (
    <div
      className="flex items-center gap-2 px-2 py-0.5 hover:bg-accent/30 group"
      data-testid={`git-file-item-${file.relativePath}`}
    >
      <Checkbox
        checked={isStaged}
        onCheckedChange={() => onToggle(file)}
        className="h-3.5 w-3.5"
        aria-label={isStaged ? `Unstage ${file.relativePath}` : `Stage ${file.relativePath}`}
      />
      <span className={cn('text-[10px] font-mono w-3', statusColors[file.status])}>
        {file.status}
      </span>
      <button
        type="button"
        className="text-xs truncate flex-1 text-left hover:underline cursor-pointer"
        onClick={() => onViewDiff(file)}
        title={`View changes: ${file.relativePath}`}
      >
        {file.relativePath}
      </button>
      <Button
        variant="ghost"
        size="icon"
        className="h-5 w-5 opacity-0 group-hover:opacity-100 transition-opacity"
        onClick={() => onViewDiff(file)}
        title="View changes"
        data-testid={`view-diff-${file.relativePath}`}
      >
        <FileDiff className="h-3 w-3 text-muted-foreground" />
      </Button>
    </div>
  )
}

export function GitStatusPanel({
  worktreePath,
  className
}: GitStatusPanelProps): React.JSX.Element | null {
  const {
    loadFileStatuses,
    loadBranchInfo,
    stageFile,
    unstageFile,
    stageAll,
    unstageAll,
    isLoading
  } = useGitStore()

  // Subscribe directly to store state so we re-render when data changes
  const fileStatusesByWorktree = useGitStore((state) => state.fileStatusesByWorktree)
  const branchInfoByWorktree = useGitStore((state) => state.branchInfoByWorktree)

  const [isRefreshing, setIsRefreshing] = useState(false)
  const [isReviewing, setIsReviewing] = useState(false)
  const [isFixingConflicts, setIsFixingConflicts] = useState(false)

  // Load initial data
  useEffect(() => {
    if (worktreePath) {
      loadFileStatuses(worktreePath)
      loadBranchInfo(worktreePath)
    }
  }, [worktreePath, loadFileStatuses, loadBranchInfo])

  // Subscribe to git status changes
  useEffect(() => {
    if (!worktreePath) return

    const unsubscribe = window.gitOps.onStatusChanged((event) => {
      if (event.worktreePath === worktreePath) {
        loadFileStatuses(worktreePath)
        loadBranchInfo(worktreePath)
      }
    })

    return () => {
      unsubscribe()
    }
  }, [worktreePath, loadFileStatuses, loadBranchInfo])

  // Get branch info directly from store state
  const branchInfo = worktreePath ? branchInfoByWorktree.get(worktreePath) : undefined

  // Get and categorize files - memoized based on the Map and worktreePath
  const { fileStatuses, stagedFiles, modifiedFiles, untrackedFiles, conflictedFiles } =
    useMemo(() => {
      const files = worktreePath ? fileStatusesByWorktree.get(worktreePath) || [] : []
      const staged: GitFileStatus[] = []
      const modified: GitFileStatus[] = []
      const untracked: GitFileStatus[] = []
      const conflicted: GitFileStatus[] = []

      for (const file of files) {
        if (file.status === 'C') {
          conflicted.push(file)
        } else if (file.staged) {
          staged.push(file)
        } else if (file.status === '?') {
          untracked.push(file)
        } else if (file.status === 'M' || file.status === 'D') {
          modified.push(file)
        }
      }

      return {
        fileStatuses: files,
        stagedFiles: staged,
        modifiedFiles: modified,
        untrackedFiles: untracked,
        conflictedFiles: conflicted
      }
    }, [worktreePath, fileStatusesByWorktree])

  const handleRefresh = useCallback(async () => {
    if (!worktreePath) return
    setIsRefreshing(true)
    try {
      await Promise.all([loadFileStatuses(worktreePath), loadBranchInfo(worktreePath)])
    } finally {
      setIsRefreshing(false)
    }
  }, [worktreePath, loadFileStatuses, loadBranchInfo])

  const handleStageAll = useCallback(async () => {
    if (!worktreePath) return
    const success = await stageAll(worktreePath)
    if (success) {
      toast.success('All changes staged')
    } else {
      toast.error('Failed to stage changes')
    }
  }, [worktreePath, stageAll])

  const handleUnstageAll = useCallback(async () => {
    if (!worktreePath) return
    const success = await unstageAll(worktreePath)
    if (success) {
      toast.success('All changes unstaged')
    } else {
      toast.error('Failed to unstage changes')
    }
  }, [worktreePath, unstageAll])

  const handleToggleFile = useCallback(
    async (file: GitFileStatus) => {
      if (!worktreePath) return
      if (file.staged) {
        const success = await unstageFile(worktreePath, file.relativePath)
        if (!success) {
          toast.error(`Failed to unstage ${file.relativePath}`)
        }
      } else {
        const success = await stageFile(worktreePath, file.relativePath)
        if (!success) {
          toast.error(`Failed to stage ${file.relativePath}`)
        }
      }
    },
    [worktreePath, stageFile, unstageFile]
  )

  const handleViewDiff = useCallback(
    (file: GitFileStatus) => {
      if (!worktreePath) return
      useFileViewerStore.getState().setActiveDiff({
        worktreePath,
        filePath: file.relativePath,
        fileName: file.relativePath.split('/').pop() || file.relativePath,
        staged: file.staged,
        isUntracked: file.status === '?'
      })
    },
    [worktreePath]
  )

  const handleReview = useCallback(async () => {
    if (!worktreePath) return
    setIsReviewing(true)
    try {
      // 1. Get worktree and project info
      const worktreeStore = useWorktreeStore.getState()
      const selectedWorktreeId = worktreeStore.selectedWorktreeId
      if (!selectedWorktreeId) {
        toast.error('No worktree selected')
        return
      }

      let projectId = ''
      for (const [projId, worktrees] of worktreeStore.worktreesByProject) {
        if (worktrees.some((w) => w.id === selectedWorktreeId)) {
          projectId = projId
          break
        }
      }
      if (!projectId) {
        toast.error('Could not find project for worktree')
        return
      }

      // 2. Build file list from current git status
      const allFiles = [...stagedFiles, ...modifiedFiles, ...untrackedFiles]
      const fileList = allFiles.map((f) => `- ${f.status}  ${f.relativePath}`).join('\n')

      // 3. Get branch name for session name
      const branchName = branchInfo?.name || 'unknown'

      // 4. Build review prompt from app's prompts/review.md
      let reviewTemplate = ''
      try {
        const result = await window.fileOps.readPrompt('review.md')
        if (result.success && result.content) {
          reviewTemplate = result.content
        }
      } catch {
        // readPrompt failed
      }

      const prompt = reviewTemplate
        ? `${reviewTemplate}\n\n---\n\nChanged files:\n${fileList}`
        : `Please review the following uncommitted changes in this worktree (branch: ${branchName}):\n\nChanged files:\n${fileList}\n\nFocus on: bugs, logic errors, and code quality.`

      // 5. Create session
      const sessionStore = useSessionStore.getState()
      const result = await sessionStore.createSession(selectedWorktreeId, projectId)
      if (!result.success || !result.session) {
        toast.error('Failed to create review session')
        return
      }

      // 6. Update session name and set to plan mode
      await sessionStore.updateSessionName(result.session.id, `Code Review — ${branchName}`)
      await sessionStore.setSessionMode(result.session.id, 'plan')

      // 7. Store pending message for SessionView to pick up after connecting
      sessionStore.setPendingMessage(result.session.id, prompt)
    } catch (error) {
      console.error('Failed to start code review:', error)
      toast.error('Failed to start code review')
    } finally {
      setIsReviewing(false)
    }
  }, [worktreePath, stagedFiles, modifiedFiles, untrackedFiles, branchInfo])

  const hasConflicts = conflictedFiles.length > 0

  const handleFixConflicts = useCallback(async () => {
    if (!worktreePath) return
    setIsFixingConflicts(true)
    try {
      const worktreeStore = useWorktreeStore.getState()
      const selectedWorktreeId = worktreeStore.selectedWorktreeId
      if (!selectedWorktreeId) {
        toast.error('No worktree selected')
        return
      }

      let projectId = ''
      for (const [projId, worktrees] of worktreeStore.worktreesByProject) {
        if (worktrees.some((w) => w.id === selectedWorktreeId)) {
          projectId = projId
          break
        }
      }
      if (!projectId) {
        toast.error('Could not find project for worktree')
        return
      }

      const branchName = branchInfo?.name || 'unknown'

      const sessionStore = useSessionStore.getState()
      const result = await sessionStore.createSession(selectedWorktreeId, projectId)
      if (!result.success || !result.session) {
        toast.error('Failed to create session')
        return
      }

      await sessionStore.updateSessionName(result.session.id, `Merge Conflicts — ${branchName}`)

      sessionStore.setPendingMessage(result.session.id, 'Fix merge conflicts')
    } catch (error) {
      console.error('Failed to start conflict resolution:', error)
      toast.error('Failed to start conflict resolution')
    } finally {
      setIsFixingConflicts(false)
    }
  }, [worktreePath, branchInfo])

  if (!worktreePath) {
    return null
  }

  const hasChanges = fileStatuses.length > 0
  const hasUnstaged = modifiedFiles.length > 0 || untrackedFiles.length > 0
  const hasStaged = stagedFiles.length > 0

  return (
    <div
      className={cn('flex flex-col border-b', className)}
      data-testid="git-status-panel"
      role="region"
      aria-label="Git status"
    >
      {/* Header with branch info */}
      <div className="flex items-center justify-between px-2 py-1.5 bg-muted/30">
        <div className="flex items-center gap-1.5 text-xs">
          <GitBranch className="h-3.5 w-3.5 text-muted-foreground" />
          <span className="font-medium" data-testid="git-branch-name">
            {branchInfo?.name || 'Loading...'}
          </span>
          {branchInfo && branchInfo.tracking && (
            <span
              className="flex items-center gap-1 text-muted-foreground"
              data-testid="git-ahead-behind"
            >
              {branchInfo.ahead > 0 && (
                <span
                  className="flex items-center gap-0.5"
                  title={`${branchInfo.ahead} commit(s) ahead`}
                >
                  <ArrowUp className="h-3 w-3" />
                  {branchInfo.ahead}
                </span>
              )}
              {branchInfo.behind > 0 && (
                <span
                  className="flex items-center gap-0.5"
                  title={`${branchInfo.behind} commit(s) behind`}
                >
                  <ArrowDown className="h-3 w-3" />
                  {branchInfo.behind}
                </span>
              )}
            </span>
          )}
        </div>
        <div className="flex items-center gap-0.5">
          {hasConflicts && (
            <Button
              variant="ghost"
              size="sm"
              className="h-5 px-1.5 text-[10px] font-bold text-orange-500 hover:text-orange-400 hover:bg-orange-500/10"
              onClick={handleFixConflicts}
              disabled={isFixingConflicts}
              title={`${conflictedFiles.length} file(s) with merge conflicts — click to fix with AI`}
              data-testid="git-merge-conflicts-button"
            >
              {isFixingConflicts ? (
                <Loader2 className="h-3 w-3 animate-spin mr-0.5" />
              ) : (
                <AlertTriangle className="h-3 w-3 mr-0.5" />
              )}
              CONFLICTS
            </Button>
          )}
          <Button
            variant="ghost"
            size="icon"
            className="h-5 w-5"
            onClick={handleReview}
            disabled={!hasChanges || isReviewing}
            title="Review changes with AI"
            data-testid="git-review-button"
          >
            {isReviewing ? (
              <Loader2 className="h-3 w-3 animate-spin" />
            ) : (
              <FileSearch className="h-3 w-3" />
            )}
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className={cn('h-5 w-5', (isLoading || isRefreshing) && 'animate-spin')}
            onClick={handleRefresh}
            disabled={isLoading || isRefreshing}
            title="Refresh git status"
            data-testid="git-refresh-button"
          >
            <RefreshCw className="h-3 w-3" />
          </Button>
        </div>
      </div>

      {!hasChanges ? (
        <div className="px-2 py-3 text-xs text-muted-foreground text-center">No changes</div>
      ) : (
        <div className="max-h-[200px] overflow-y-auto">
          {/* Merge Conflicts */}
          <CollapsibleSection
            title="Conflicts"
            count={conflictedFiles.length}
            testId="git-conflicts-section"
          >
            {conflictedFiles.map((file) => (
              <FileItem
                key={file.relativePath}
                file={file}
                onToggle={handleToggleFile}
                onViewDiff={handleViewDiff}
                isStaged={false}
              />
            ))}
          </CollapsibleSection>

          {/* Staged Changes */}
          <CollapsibleSection
            title="Staged Changes"
            count={stagedFiles.length}
            testId="git-staged-section"
            action={
              hasStaged && (
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-5 px-1.5 text-[10px]"
                  onClick={handleUnstageAll}
                  title="Unstage all files"
                  data-testid="git-unstage-all"
                >
                  <Minus className="h-3 w-3 mr-0.5" />
                  Unstage All
                </Button>
              )
            }
          >
            {stagedFiles.map((file) => (
              <FileItem
                key={file.relativePath}
                file={file}
                onToggle={handleToggleFile}
                onViewDiff={handleViewDiff}
                isStaged={true}
              />
            ))}
          </CollapsibleSection>

          {/* Modified (Unstaged) */}
          <CollapsibleSection
            title="Changes"
            count={modifiedFiles.length}
            testId="git-modified-section"
            action={
              hasUnstaged && (
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-5 px-1.5 text-[10px]"
                  onClick={handleStageAll}
                  title="Stage all files"
                  data-testid="git-stage-all"
                >
                  <Plus className="h-3 w-3 mr-0.5" />
                  Stage All
                </Button>
              )
            }
          >
            {modifiedFiles.map((file) => (
              <FileItem
                key={file.relativePath}
                file={file}
                onToggle={handleToggleFile}
                onViewDiff={handleViewDiff}
                isStaged={false}
              />
            ))}
          </CollapsibleSection>

          {/* Untracked */}
          <CollapsibleSection
            title="Untracked"
            count={untrackedFiles.length}
            testId="git-untracked-section"
          >
            {untrackedFiles.map((file) => (
              <FileItem
                key={file.relativePath}
                file={file}
                onToggle={handleToggleFile}
                onViewDiff={handleViewDiff}
                isStaged={false}
              />
            ))}
          </CollapsibleSection>
        </div>
      )}

      {/* Commit Form - show when there are staged changes */}
      {hasStaged && <GitCommitForm worktreePath={worktreePath} />}

      {/* Push/Pull Controls */}
      <GitPushPull worktreePath={worktreePath} />
    </div>
  )
}
