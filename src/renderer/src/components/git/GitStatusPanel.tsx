import { useState, useEffect, useCallback, useMemo, useRef, memo } from 'react'
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
  Loader2,
  AlertTriangle
} from 'lucide-react'
import { useVirtualizer } from '@tanstack/react-virtual'
import { toast } from '@/lib/toast'
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

type FlatStatusItem =
  | {
      type: 'header'
      key: string
      groupId: string
      title: string
      count: number
      action?: React.ReactNode
      testId?: string
    }
  | { type: 'file'; key: string; file: GitFileStatus; isStaged: boolean }

const ROW_HEIGHT = 24
const HEADER_HEIGHT = 28

const statusColors: Record<string, string> = {
  M: 'text-yellow-500',
  A: 'text-green-500',
  D: 'text-red-500',
  '?': 'text-gray-400',
  C: 'text-red-600 font-bold'
}

interface FileItemProps {
  file: GitFileStatus
  onToggle: (file: GitFileStatus) => void
  onViewDiff: (file: GitFileStatus) => void
  isStaged: boolean
}

const FileItem = memo(function FileItem({
  file,
  onToggle,
  onViewDiff,
  isStaged
}: FileItemProps): React.JSX.Element {
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
})

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
  const [isFixingConflicts, setIsFixingConflicts] = useState(false)
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())

  // Load initial data
  useEffect(() => {
    if (worktreePath) {
      loadFileStatuses(worktreePath)
      loadBranchInfo(worktreePath)
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
      const isNewFile = file.status === '?' || file.status === 'A'

      if (isNewFile) {
        const fullPath = `${worktreePath}/${file.relativePath}`
        const fileName = file.relativePath.split('/').pop() || file.relativePath
        const worktreeId = useWorktreeStore.getState().selectedWorktreeId
        if (worktreeId) {
          useFileViewerStore.getState().openFile(fullPath, fileName, worktreeId)
        }
      } else {
        useFileViewerStore.getState().setActiveDiff({
          worktreePath,
          filePath: file.relativePath,
          fileName: file.relativePath.split('/').pop() || file.relativePath,
          staged: file.staged,
          isUntracked: file.status === '?',
          isNewFile: false
        })
      }
    },
    [worktreePath]
  )

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

  const hasConflicts = conflictedFiles.length > 0
  const hasStaged = stagedFiles.length > 0
  const hasUnstaged = modifiedFiles.length > 0 || untrackedFiles.length > 0

  // ── Virtualized flat list for the file changes ──
  const scrollRef = useRef<HTMLDivElement>(null)

  const flatItems = useMemo(() => {
    const items: FlatStatusItem[] = []

    if (conflictedFiles.length > 0) {
      items.push({
        type: 'header',
        key: 'h-conflicts',
        groupId: 'conflicts',
        title: 'Conflicts',
        count: conflictedFiles.length,
        testId: 'git-conflicts-section'
      })
      if (!collapsed.has('conflicts')) {
        for (const file of conflictedFiles) {
          items.push({
            type: 'file',
            key: `conflict-${file.relativePath}`,
            file,
            isStaged: false
          })
        }
      }
    }

    if (stagedFiles.length > 0) {
      items.push({
        type: 'header',
        key: 'h-staged',
        groupId: 'staged',
        title: 'Staged Changes',
        count: stagedFiles.length,
        action: hasStaged ? (
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
        ) : undefined,
        testId: 'git-staged-section'
      })
      if (!collapsed.has('staged')) {
        for (const file of stagedFiles) {
          items.push({
            type: 'file',
            key: `staged-${file.relativePath}`,
            file,
            isStaged: true
          })
        }
      }
    }

    if (modifiedFiles.length > 0) {
      items.push({
        type: 'header',
        key: 'h-changes',
        groupId: 'changes',
        title: 'Changes',
        count: modifiedFiles.length,
        action: hasUnstaged ? (
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
        ) : undefined,
        testId: 'git-modified-section'
      })
      if (!collapsed.has('changes')) {
        for (const file of modifiedFiles) {
          items.push({
            type: 'file',
            key: `modified-${file.relativePath}`,
            file,
            isStaged: false
          })
        }
      }
    }

    if (untrackedFiles.length > 0) {
      items.push({
        type: 'header',
        key: 'h-untracked',
        groupId: 'untracked',
        title: 'Untracked',
        count: untrackedFiles.length,
        testId: 'git-untracked-section'
      })
      if (!collapsed.has('untracked')) {
        for (const file of untrackedFiles) {
          items.push({
            type: 'file',
            key: `untracked-${file.relativePath}`,
            file,
            isStaged: false
          })
        }
      }
    }

    return items
  }, [
    conflictedFiles,
    stagedFiles,
    modifiedFiles,
    untrackedFiles,
    collapsed,
    hasStaged,
    hasUnstaged,
    handleUnstageAll,
    handleStageAll
  ])

  const virtualizer = useVirtualizer({
    count: flatItems.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: (index) => (flatItems[index].type === 'header' ? HEADER_HEIGHT : ROW_HEIGHT),
    overscan: 10
  })

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
        <div ref={scrollRef} className="max-h-[200px] overflow-y-auto">
          <div
            style={{
              height: `${virtualizer.getTotalSize()}px`,
              width: '100%',
              position: 'relative'
            }}
          >
            {virtualizer.getVirtualItems().map((virtualRow) => {
              const item = flatItems[virtualRow.index]
              return (
                <div
                  key={item.key}
                  style={{
                    position: 'absolute',
                    top: 0,
                    left: 0,
                    width: '100%',
                    height: `${virtualRow.size}px`,
                    transform: `translateY(${virtualRow.start}px)`
                  }}
                >
                  {item.type === 'header' ? (
                    <button
                      type="button"
                      className={cn(
                        'flex items-center justify-between w-full px-2 h-full',
                        'text-xs font-medium text-muted-foreground hover:bg-accent/50',
                        virtualRow.index > 0 && 'border-t border-border'
                      )}
                      onClick={() => toggleGroup(item.groupId)}
                      data-testid={item.testId}
                    >
                      <span className="flex items-center gap-1">
                        {collapsed.has(item.groupId) ? (
                          <ChevronRight className="h-3 w-3" />
                        ) : (
                          <ChevronDown className="h-3 w-3" />
                        )}
                        {item.title}
                        <span className="text-[10px] px-1 py-0.5 rounded bg-muted">
                          {item.count}
                        </span>
                      </span>
                      {item.action && (
                        <span onClick={(e) => e.stopPropagation()}>{item.action}</span>
                      )}
                    </button>
                  ) : (
                    <FileItem
                      file={item.file}
                      onToggle={handleToggleFile}
                      onViewDiff={handleViewDiff}
                      isStaged={item.isStaged}
                    />
                  )}
                </div>
              )
            })}
          </div>
        </div>
      )}

      {/* Commit Form - show when there are staged changes */}
      {hasStaged && <GitCommitForm worktreePath={worktreePath} />}

      {/* Push/Pull Controls */}
      <GitPushPull worktreePath={worktreePath} />
    </div>
  )
}
