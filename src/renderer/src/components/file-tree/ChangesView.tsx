import { useState, useEffect, useCallback, useMemo } from 'react'
import {
  ChevronDown,
  ChevronRight,
  Plus,
  Minus,
  Undo2,
  RefreshCw,
  GitBranch,
  ArrowUp,
  ArrowDown,
  FileSearch,
  Loader2,
  Trash2,
  EyeOff,
  FileDiff
} from 'lucide-react'
import { toast } from '@/lib/toast'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger
} from '@/components/ui/context-menu'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { useGitStore, type GitFileStatus } from '@/stores/useGitStore'
import { useWorktreeStore } from '@/stores/useWorktreeStore'
import { useSessionStore } from '@/stores/useSessionStore'
import { useFileViewerStore } from '@/stores/useFileViewerStore'
import { FileIcon } from './FileIcon'
import { GitStatusIndicator } from './GitStatusIndicator'
import { GitCommitForm } from '@/components/git/GitCommitForm'
import { GitPushPull } from '@/components/git/GitPushPull'

interface ChangesViewProps {
  worktreePath: string | null
  onFileClick?: (filePath: string) => void
}

export function ChangesView({ worktreePath, onFileClick }: ChangesViewProps): React.JSX.Element {
  const {
    loadFileStatuses,
    loadBranchInfo,
    stageFile,
    unstageFile,
    stageAll,
    unstageAll,
    discardChanges,
    isLoading
  } = useGitStore()

  const fileStatusesByWorktree = useGitStore((state) => state.fileStatusesByWorktree)
  const branchInfoByWorktree = useGitStore((state) => state.branchInfoByWorktree)

  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  const [isRefreshing, setIsRefreshing] = useState(false)
  const [isReviewing, setIsReviewing] = useState(false)

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

  const branchInfo = worktreePath ? branchInfoByWorktree.get(worktreePath) : undefined

  // Group files into staged, unstaged (modified), and untracked
  const { stagedFiles, modifiedFiles, untrackedFiles, allFiles } = useMemo(() => {
    const files = worktreePath ? fileStatusesByWorktree.get(worktreePath) || [] : []
    const staged: GitFileStatus[] = []
    const modified: GitFileStatus[] = []
    const untracked: GitFileStatus[] = []

    for (const file of files) {
      if (file.staged) {
        staged.push(file)
      } else if (file.status === '?') {
        untracked.push(file)
      } else if (file.status === 'M' || file.status === 'D' || file.status === 'A') {
        modified.push(file)
      }
    }

    return {
      stagedFiles: staged,
      modifiedFiles: modified,
      untrackedFiles: untracked,
      allFiles: files
    }
  }, [worktreePath, fileStatusesByWorktree])

  const hasChanges = allFiles.length > 0
  const hasStaged = stagedFiles.length > 0
  const hasUnstaged = modifiedFiles.length > 0 || untrackedFiles.length > 0

  const toggleGroup = useCallback((group: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev)
      if (next.has(group)) {
        next.delete(group)
      } else {
        next.add(group)
      }
      return next
    })
  }, [])

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

  const handleDiscardAll = useCallback(async () => {
    if (!worktreePath) return
    const filesToDiscard = [...modifiedFiles]
    if (filesToDiscard.length === 0) return

    let successCount = 0
    for (const file of filesToDiscard) {
      const success = await discardChanges(worktreePath, file.relativePath)
      if (success) successCount++
    }

    if (successCount === filesToDiscard.length) {
      toast.success(`Discarded ${successCount} change(s)`)
    } else if (successCount > 0) {
      toast.warning(`Discarded ${successCount}/${filesToDiscard.length} changes`)
    } else {
      toast.error('Failed to discard changes')
    }
  }, [worktreePath, modifiedFiles, discardChanges])

  const handleStageFile = useCallback(
    async (file: GitFileStatus) => {
      if (!worktreePath) return
      const success = await stageFile(worktreePath, file.relativePath)
      if (!success) {
        toast.error(`Failed to stage ${file.relativePath}`)
      }
    },
    [worktreePath, stageFile]
  )

  const handleUnstageFile = useCallback(
    async (file: GitFileStatus) => {
      if (!worktreePath) return
      const success = await unstageFile(worktreePath, file.relativePath)
      if (!success) {
        toast.error(`Failed to unstage ${file.relativePath}`)
      }
    },
    [worktreePath, unstageFile]
  )

  const handleDiscardFile = useCallback(
    async (file: GitFileStatus) => {
      if (!worktreePath) return
      const success = await discardChanges(worktreePath, file.relativePath)
      if (success) {
        toast.success(`Discarded changes to ${file.relativePath}`)
      } else {
        toast.error(`Failed to discard ${file.relativePath}`)
      }
    },
    [worktreePath, discardChanges]
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
      onFileClick?.(file.relativePath)
    },
    [worktreePath, onFileClick]
  )

  const handleReview = useCallback(async () => {
    if (!worktreePath) return
    setIsReviewing(true)
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

      const allChangedFiles = [...stagedFiles, ...modifiedFiles, ...untrackedFiles]
      const fileList = allChangedFiles.map((f) => `- ${f.status}  ${f.relativePath}`).join('\n')
      const branchName = branchInfo?.name || 'unknown'

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

      const sessionStore = useSessionStore.getState()
      const result = await sessionStore.createSession(selectedWorktreeId, projectId)
      if (!result.success || !result.session) {
        toast.error('Failed to create review session')
        return
      }

      await sessionStore.updateSessionName(result.session.id, `Code Review — ${branchName}`)
      await sessionStore.setSessionMode(result.session.id, 'plan')
      sessionStore.setPendingMessage(result.session.id, prompt)
    } catch (error) {
      console.error('Failed to start code review:', error)
      toast.error('Failed to start code review')
    } finally {
      setIsReviewing(false)
    }
  }, [worktreePath, stagedFiles, modifiedFiles, untrackedFiles, branchInfo])

  if (!worktreePath) {
    return <div className="p-4 text-sm text-muted-foreground text-center">No worktree selected</div>
  }

  return (
    <div className="flex flex-col h-full" data-testid="changes-view">
      {/* Branch header */}
      <div className="flex items-center justify-between px-2 py-1.5 bg-muted/30 border-b border-border">
        <div className="flex items-center gap-1.5 text-xs">
          <GitBranch className="h-3.5 w-3.5 text-muted-foreground" />
          <span className="font-medium" data-testid="changes-branch-name">
            {branchInfo?.name || 'Loading...'}
          </span>
          {branchInfo?.tracking && (
            <span className="flex items-center gap-1 text-muted-foreground">
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
          <Button
            variant="ghost"
            size="icon"
            className="h-5 w-5"
            onClick={handleReview}
            disabled={!hasChanges || isReviewing}
            title="Review changes with AI"
            data-testid="changes-review-button"
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
            data-testid="changes-refresh-button"
          >
            <RefreshCw className="h-3 w-3" />
          </Button>
        </div>
      </div>

      {/* File list */}
      {!hasChanges ? (
        <div
          className="flex-1 flex items-center justify-center text-xs text-muted-foreground"
          data-testid="changes-empty"
        >
          No changes
        </div>
      ) : (
        <div className="flex-1 overflow-y-auto">
          {/* Staged Changes */}
          {stagedFiles.length > 0 && (
            <GroupHeader
              title="Staged Changes"
              count={stagedFiles.length}
              isCollapsed={collapsed.has('staged')}
              onToggle={() => toggleGroup('staged')}
              action={
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-5 px-1.5 text-[10px]"
                  onClick={handleUnstageAll}
                  title="Unstage all files"
                  data-testid="changes-unstage-all"
                >
                  <Minus className="h-3 w-3 mr-0.5" />
                  Unstage All
                </Button>
              }
              testId="changes-staged-section"
            >
              {stagedFiles.map((file) => (
                <FileRow
                  key={`staged-${file.relativePath}`}
                  file={file}
                  onViewDiff={handleViewDiff}
                  contextMenu={
                    <ContextMenuContent>
                      <ContextMenuItem onClick={() => handleUnstageFile(file)}>
                        <Minus className="h-3.5 w-3.5 mr-2" />
                        Unstage
                      </ContextMenuItem>
                      <ContextMenuItem onClick={() => handleViewDiff(file)}>
                        <FileDiff className="h-3.5 w-3.5 mr-2" />
                        Open Diff
                      </ContextMenuItem>
                    </ContextMenuContent>
                  }
                />
              ))}
            </GroupHeader>
          )}

          {/* Unstaged Changes */}
          {modifiedFiles.length > 0 && (
            <GroupHeader
              title="Changes"
              count={modifiedFiles.length}
              isCollapsed={collapsed.has('unstaged')}
              onToggle={() => toggleGroup('unstaged')}
              action={
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-5 px-1.5 text-[10px]"
                  onClick={handleStageAll}
                  title="Stage all files"
                  data-testid="changes-stage-all"
                >
                  <Plus className="h-3 w-3 mr-0.5" />
                  Stage All
                </Button>
              }
              testId="changes-modified-section"
            >
              {modifiedFiles.map((file) => (
                <FileRow
                  key={`modified-${file.relativePath}`}
                  file={file}
                  onViewDiff={handleViewDiff}
                  contextMenu={
                    <ContextMenuContent>
                      <ContextMenuItem onClick={() => handleStageFile(file)}>
                        <Plus className="h-3.5 w-3.5 mr-2" />
                        Stage
                      </ContextMenuItem>
                      <ContextMenuItem onClick={() => handleViewDiff(file)}>
                        <FileDiff className="h-3.5 w-3.5 mr-2" />
                        Open Diff
                      </ContextMenuItem>
                      <ContextMenuSeparator />
                      <ContextMenuItem
                        onClick={() => handleDiscardFile(file)}
                        className="text-destructive focus:text-destructive"
                      >
                        <Undo2 className="h-3.5 w-3.5 mr-2" />
                        Discard Changes
                      </ContextMenuItem>
                    </ContextMenuContent>
                  }
                />
              ))}
            </GroupHeader>
          )}

          {/* Untracked Files */}
          {untrackedFiles.length > 0 && (
            <GroupHeader
              title="Untracked"
              count={untrackedFiles.length}
              isCollapsed={collapsed.has('untracked')}
              onToggle={() => toggleGroup('untracked')}
              testId="changes-untracked-section"
            >
              {untrackedFiles.map((file) => (
                <FileRow
                  key={`untracked-${file.relativePath}`}
                  file={file}
                  onViewDiff={handleViewDiff}
                  contextMenu={
                    <ContextMenuContent>
                      <ContextMenuItem onClick={() => handleStageFile(file)}>
                        <Plus className="h-3.5 w-3.5 mr-2" />
                        Stage
                      </ContextMenuItem>
                      <ContextMenuSeparator />
                      <ContextMenuItem
                        onClick={() => handleDiscardFile(file)}
                        className="text-destructive focus:text-destructive"
                      >
                        <Trash2 className="h-3.5 w-3.5 mr-2" />
                        Delete
                      </ContextMenuItem>
                      <ContextMenuItem
                        onClick={async () => {
                          if (!worktreePath) return
                          const success = await useGitStore
                            .getState()
                            .addToGitignore(worktreePath, file.relativePath)
                          if (success) {
                            toast.success(`Added ${file.relativePath} to .gitignore`)
                          } else {
                            toast.error('Failed to add to .gitignore')
                          }
                        }}
                      >
                        <EyeOff className="h-3.5 w-3.5 mr-2" />
                        Add to .gitignore
                      </ContextMenuItem>
                    </ContextMenuContent>
                  }
                />
              ))}
            </GroupHeader>
          )}
        </div>
      )}

      {/* Bulk actions bar */}
      {hasChanges && (
        <div className="flex items-center gap-2 px-3 py-2 border-t border-border">
          {hasUnstaged && (
            <button
              onClick={handleStageAll}
              className="text-xs text-muted-foreground hover:text-foreground flex items-center gap-1"
              title="Stage All"
            >
              <Plus className="h-3 w-3" /> Stage All
            </button>
          )}
          {hasStaged && (
            <button
              onClick={handleUnstageAll}
              className="text-xs text-muted-foreground hover:text-foreground flex items-center gap-1"
              title="Unstage All"
            >
              <Minus className="h-3 w-3" /> Unstage All
            </button>
          )}
          {modifiedFiles.length > 0 && (
            <button
              onClick={handleDiscardAll}
              className="text-xs text-destructive/70 hover:text-destructive flex items-center gap-1"
              title="Discard All Changes"
            >
              <Undo2 className="h-3 w-3" /> Discard
            </button>
          )}
        </div>
      )}

      {/* Commit form when staged changes exist */}
      {hasStaged && <GitCommitForm worktreePath={worktreePath} />}

      {/* Push/Pull controls */}
      <GitPushPull worktreePath={worktreePath} />
    </div>
  )
}

/* ---- Sub-components ---- */

interface GroupHeaderProps {
  title: string
  count: number
  isCollapsed: boolean
  onToggle: () => void
  action?: React.ReactNode
  testId?: string
  children: React.ReactNode
}

function GroupHeader({
  title,
  count,
  isCollapsed,
  onToggle,
  action,
  testId,
  children
}: GroupHeaderProps): React.JSX.Element {
  return (
    <div className="border-b border-border last:border-b-0" data-testid={testId}>
      <button
        type="button"
        className="flex items-center justify-between w-full px-2 py-1.5 text-xs font-medium text-muted-foreground hover:bg-accent/50"
        onClick={onToggle}
      >
        <span className="flex items-center gap-1">
          {isCollapsed ? <ChevronRight className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
          {title}
          <span className="text-[10px] px-1 py-0.5 rounded bg-muted">{count}</span>
        </span>
        {action && <span onClick={(e) => e.stopPropagation()}>{action}</span>}
      </button>
      {!isCollapsed && <div className="pb-1">{children}</div>}
    </div>
  )
}

interface FileRowProps {
  file: GitFileStatus
  onViewDiff: (file: GitFileStatus) => void
  contextMenu: React.ReactNode
}

function FileRow({ file, onViewDiff, contextMenu }: FileRowProps): React.JSX.Element {
  const fileName = file.relativePath.split('/').pop() || file.relativePath
  const ext = fileName.includes('.') ? '.' + fileName.split('.').pop() : null

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div
          className="flex items-center gap-1.5 px-2 py-0.5 hover:bg-accent/30 group cursor-pointer"
          onClick={() => onViewDiff(file)}
          data-testid={`changes-file-${file.relativePath}`}
        >
          <FileIcon name={fileName} extension={ext} isDirectory={false} className="h-3.5 w-3.5" />
          <span className="text-xs truncate flex-1" title={file.relativePath}>
            {file.relativePath}
          </span>
          <GitStatusIndicator status={file.status} staged={file.staged} className="mr-1" />
        </div>
      </ContextMenuTrigger>
      {contextMenu}
    </ContextMenu>
  )
}
