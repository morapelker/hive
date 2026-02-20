import { useState, useEffect, useCallback, useMemo, memo } from 'react'
import {
  AlertTriangle,
  ChevronDown,
  ChevronRight,
  Plus,
  Minus,
  Undo2,
  RefreshCw,
  GitBranch,
  ArrowUp,
  ArrowDown,
  Trash2,
  EyeOff,
  FileDiff,
  Link
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
import { useFileViewerStore } from '@/stores/useFileViewerStore'
import { useConnectionStore } from '@/stores/useConnectionStore'
import { FileIcon } from './FileIcon'
import { GitStatusIndicator } from './GitStatusIndicator'
import { GitCommitForm } from '@/components/git/GitCommitForm'
import { GitPushPull } from '@/components/git/GitPushPull'

interface ConnectionMemberInfo {
  worktree_path: string
  project_name: string
  worktree_branch: string
}

interface ChangesViewProps {
  worktreePath: string | null
  isConnectionMode?: boolean
  connectionMembers?: ConnectionMemberInfo[]
  onFileClick?: (filePath: string) => void
}

export function ChangesView({
  worktreePath,
  isConnectionMode,
  connectionMembers,
  onFileClick
}: ChangesViewProps): React.JSX.Element {
  const {
    loadFileStatuses,
    loadBranchInfo,
    loadStatusesForPaths,
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

  // Load initial data (skip for connection folders — no git repo)
  useEffect(() => {
    if (worktreePath && !isConnectionMode) {
      loadFileStatuses(worktreePath)
      loadBranchInfo(worktreePath)
    }
  }, [worktreePath, isConnectionMode, loadFileStatuses, loadBranchInfo])

  const branchInfo = worktreePath ? branchInfoByWorktree.get(worktreePath) : undefined

  // Group files into conflicted, staged, unstaged (modified), and untracked
  const { conflictedFiles, stagedFiles, modifiedFiles, untrackedFiles, allFiles } = useMemo(() => {
    const files = worktreePath ? fileStatusesByWorktree.get(worktreePath) || [] : []
    const conflicted: GitFileStatus[] = []
    const staged: GitFileStatus[] = []
    const modified: GitFileStatus[] = []
    const untracked: GitFileStatus[] = []

    for (const file of files) {
      if (file.status === 'C') {
        conflicted.push(file)
      } else if (file.staged) {
        staged.push(file)
      } else if (file.status === '?') {
        untracked.push(file)
      } else if (file.status === 'M' || file.status === 'D' || file.status === 'A') {
        modified.push(file)
      }
    }

    return {
      conflictedFiles: conflicted,
      stagedFiles: staged,
      modifiedFiles: modified,
      untrackedFiles: untracked,
      allFiles: files
    }
  }, [worktreePath, fileStatusesByWorktree])

  const hasConflicts = conflictedFiles.length > 0
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

      onFileClick?.(file.relativePath)
    },
    [worktreePath, onFileClick]
  )

  // ── Connection mode: load statuses for all member worktrees ──
  useEffect(() => {
    if (isConnectionMode && connectionMembers && connectionMembers.length > 0) {
      const paths = connectionMembers.map((m) => m.worktree_path)
      loadStatusesForPaths(paths)
    }
  }, [isConnectionMode, connectionMembers, loadStatusesForPaths])

  // ── Connection mode: per-member change data ──
  const memberChangesData = useMemo(() => {
    if (!isConnectionMode || !connectionMembers) return []
    return connectionMembers.map((member) => {
      const files = fileStatusesByWorktree.get(member.worktree_path) || []
      const branchInfo_ = branchInfoByWorktree.get(member.worktree_path)
      const conflicted = files.filter((f) => f.status === 'C')
      const staged = files.filter((f) => f.staged && f.status !== 'C')
      const modified = files.filter((f) => !f.staged && f.status !== '?' && f.status !== 'C')
      const untracked = files.filter((f) => f.status === '?')
      return {
        ...member,
        branchInfo: branchInfo_,
        files,
        conflicted,
        staged,
        modified,
        untracked,
        totalChanges: files.length
      }
    })
  }, [isConnectionMode, connectionMembers, fileStatusesByWorktree, branchInfoByWorktree])

  const connectionSummary = useMemo(() => {
    if (!memberChangesData.length) return { totalFiles: 0, reposWithChanges: 0 }
    const totalFiles = memberChangesData.reduce((sum, m) => sum + m.totalChanges, 0)
    const reposWithChanges = memberChangesData.filter((m) => m.totalChanges > 0).length
    return { totalFiles, reposWithChanges }
  }, [memberChangesData])

  const [collapsedMembers, setCollapsedMembers] = useState<Set<string>>(new Set())

  const toggleMember = useCallback((path: string) => {
    setCollapsedMembers((prev) => {
      const next = new Set(prev)
      if (next.has(path)) {
        next.delete(path)
      } else {
        next.add(path)
      }
      return next
    })
  }, [])

  const handleConnectionRefresh = useCallback(async () => {
    if (!connectionMembers) return
    setIsRefreshing(true)
    try {
      const paths = connectionMembers.map((m) => m.worktree_path)
      await loadStatusesForPaths(paths)
    } finally {
      setIsRefreshing(false)
    }
  }, [connectionMembers, loadStatusesForPaths])

  const handleConnectionViewDiff = useCallback(
    (file: GitFileStatus, memberWorktreePath: string) => {
      if (!memberWorktreePath) return
      const isNewFile = file.status === '?' || file.status === 'A'
      if (isNewFile) {
        const fullPath = `${memberWorktreePath}/${file.relativePath}`
        const fileName = file.relativePath.split('/').pop() || file.relativePath
        const contextId = useConnectionStore.getState().selectedConnectionId
        if (contextId) {
          useFileViewerStore.getState().openFile(fullPath, fileName, contextId)
        }
      } else {
        useFileViewerStore.getState().setActiveDiff({
          worktreePath: memberWorktreePath,
          filePath: file.relativePath,
          fileName: file.relativePath.split('/').pop() || file.relativePath,
          staged: file.staged,
          isUntracked: file.status === '?',
          isNewFile: false
        })
      }
      onFileClick?.(file.relativePath)
    },
    [onFileClick]
  )

  if (!worktreePath) {
    return <div className="p-4 text-sm text-muted-foreground text-center">No worktree selected</div>
  }

  if (isConnectionMode) {
    return (
      <div className="flex flex-col h-full" data-testid="connection-changes-view">
        {/* Summary header */}
        <div className="flex items-center justify-between px-2 py-1.5 bg-muted/30 border-b border-border">
          <div className="flex items-center gap-1.5 text-xs">
            <Link className="h-3.5 w-3.5 text-muted-foreground" />
            <span className="font-medium">
              {connectionSummary.totalFiles === 0
                ? 'No changes'
                : `${connectionSummary.totalFiles} file${connectionSummary.totalFiles === 1 ? '' : 's'} across ${connectionSummary.reposWithChanges} repo${connectionSummary.reposWithChanges === 1 ? '' : 's'}`}
            </span>
          </div>
          <Button
            variant="ghost"
            size="icon"
            className={cn('h-5 w-5', isRefreshing && 'animate-spin')}
            onClick={handleConnectionRefresh}
            disabled={isRefreshing}
            title="Refresh all"
          >
            <RefreshCw className="h-3 w-3" />
          </Button>
        </div>

        {/* Per-member sections */}
        <div className="flex-1 overflow-y-auto">
          {memberChangesData.map((member) => {
            const isCollapsed = collapsedMembers.has(member.worktree_path)
            const hasNoChanges = member.totalChanges === 0

            return (
              <div key={member.worktree_path} className="border-b border-border last:border-b-0">
                {/* Member header */}
                <button
                  type="button"
                  className="flex items-center justify-between w-full px-2 py-1.5 text-xs hover:bg-accent/50"
                  onClick={() => toggleMember(member.worktree_path)}
                >
                  <span className="flex items-center gap-1.5 min-w-0">
                    {isCollapsed || hasNoChanges ? (
                      <ChevronRight className="h-3 w-3 shrink-0 text-muted-foreground" />
                    ) : (
                      <ChevronDown className="h-3 w-3 shrink-0 text-muted-foreground" />
                    )}
                    <span className="font-medium truncate">{member.project_name}</span>
                    <GitBranch className="h-3 w-3 shrink-0 text-muted-foreground" />
                    <span className="text-muted-foreground truncate">
                      {member.branchInfo?.name || member.worktree_branch || '...'}
                    </span>
                    {member.branchInfo?.ahead ? (
                      <span className="flex items-center gap-0.5 text-muted-foreground">
                        <ArrowUp className="h-3 w-3" />
                        {member.branchInfo.ahead}
                      </span>
                    ) : null}
                    {member.branchInfo?.behind ? (
                      <span className="flex items-center gap-0.5 text-muted-foreground">
                        <ArrowDown className="h-3 w-3" />
                        {member.branchInfo.behind}
                      </span>
                    ) : null}
                  </span>
                  <span className="flex items-center gap-1 shrink-0">
                    {hasNoChanges ? (
                      <span className="text-muted-foreground text-[10px]">clean</span>
                    ) : (
                      <span className="text-[10px] px-1 py-0.5 rounded bg-muted">
                        {member.totalChanges}
                      </span>
                    )}
                  </span>
                </button>

                {/* Member content (file groups) */}
                {!isCollapsed && !hasNoChanges && (
                  <MemberChanges
                    member={member}
                    onStageFile={(path, rel) => stageFile(path, rel)}
                    onUnstageFile={(path, rel) => unstageFile(path, rel)}
                    onStageAll={(path) => stageAll(path)}
                    onUnstageAll={(path) => unstageAll(path)}
                    onDiscardChanges={(path, rel) => discardChanges(path, rel)}
                    onViewDiff={handleConnectionViewDiff}
                  />
                )}
              </div>
            )
          })}
        </div>
      </div>
    )
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
          {/* Merge Conflicts */}
          {conflictedFiles.length > 0 && (
            <GroupHeader
              title="Merge Conflicts"
              count={conflictedFiles.length}
              isCollapsed={collapsed.has('conflicts')}
              onToggle={() => toggleGroup('conflicts')}
              icon={<AlertTriangle className="h-3 w-3 text-red-500" />}
              headerClassName="text-red-500"
              testId="changes-conflicts-section"
            >
              {conflictedFiles.map((file) => (
                <FileRow
                  key={`conflict-${file.relativePath}`}
                  file={file}
                  onViewDiff={handleViewDiff}
                  onStageToggle={handleStageFile}
                  contextMenu={
                    <ContextMenuContent>
                      <ContextMenuItem onClick={() => handleStageFile(file)}>
                        <Plus className="h-3.5 w-3.5 mr-2" />
                        Mark as Resolved
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
                  onStageToggle={handleUnstageFile}
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
                  onStageToggle={handleStageFile}
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
                  onStageToggle={handleStageFile}
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
      {hasStaged && <GitCommitForm worktreePath={worktreePath} hasConflicts={hasConflicts} />}

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
  icon?: React.ReactNode
  headerClassName?: string
  testId?: string
  children: React.ReactNode
}

const GroupHeader = memo(function GroupHeader({
  title,
  count,
  isCollapsed,
  onToggle,
  action,
  icon,
  headerClassName,
  testId,
  children
}: GroupHeaderProps): React.JSX.Element {
  return (
    <div className="border-b border-border last:border-b-0" data-testid={testId}>
      <button
        type="button"
        className={cn(
          'flex items-center justify-between w-full px-2 py-1.5 text-xs font-medium text-muted-foreground hover:bg-accent/50',
          headerClassName
        )}
        onClick={onToggle}
      >
        <span className="flex items-center gap-1">
          {icon ||
            (isCollapsed ? (
              <ChevronRight className="h-3 w-3" />
            ) : (
              <ChevronDown className="h-3 w-3" />
            ))}
          {title}
          <span className="text-[10px] px-1 py-0.5 rounded bg-muted">{count}</span>
        </span>
        {action && <span onClick={(e) => e.stopPropagation()}>{action}</span>}
      </button>
      {!isCollapsed && <div className="pb-1">{children}</div>}
    </div>
  )
})

interface FileRowProps {
  file: GitFileStatus
  onViewDiff: (file: GitFileStatus) => void
  contextMenu: React.ReactNode
  onStageToggle?: (file: GitFileStatus) => void
}

const FileRow = memo(function FileRow({
  file,
  onViewDiff,
  contextMenu,
  onStageToggle
}: FileRowProps): React.JSX.Element {
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
          {onStageToggle ? (
            <div className="relative h-3.5 w-3.5 flex-shrink-0">
              <FileIcon
                name={fileName}
                extension={ext}
                isDirectory={false}
                className="h-3.5 w-3.5 group-hover:invisible"
              />
              <button
                className="absolute inset-0 hidden group-hover:flex items-center justify-center text-muted-foreground hover:text-foreground"
                onClick={(e) => {
                  e.stopPropagation()
                  onStageToggle(file)
                }}
                title={file.staged ? 'Unstage' : 'Stage'}
              >
                {file.staged ? (
                  <Minus className="h-3.5 w-3.5" />
                ) : (
                  <Plus className="h-3.5 w-3.5" />
                )}
              </button>
            </div>
          ) : (
            <FileIcon
              name={fileName}
              extension={ext}
              isDirectory={false}
              className="h-3.5 w-3.5"
            />
          )}
          <span className="text-xs truncate flex-1" title={file.relativePath}>
            {file.relativePath}
          </span>
          <GitStatusIndicator status={file.status} staged={file.staged} className="mr-1" />
        </div>
      </ContextMenuTrigger>
      {contextMenu}
    </ContextMenu>
  )
})

/* ---- Connection mode sub-component ---- */

interface MemberChangesData {
  worktree_path: string
  project_name: string
  branchInfo?: { name: string; tracking: string | null; ahead: number; behind: number }
  conflicted: GitFileStatus[]
  staged: GitFileStatus[]
  modified: GitFileStatus[]
  untracked: GitFileStatus[]
}

interface MemberChangesProps {
  member: MemberChangesData
  onStageFile: (worktreePath: string, relativePath: string) => Promise<boolean>
  onUnstageFile: (worktreePath: string, relativePath: string) => Promise<boolean>
  onStageAll: (worktreePath: string) => Promise<boolean>
  onUnstageAll: (worktreePath: string) => Promise<boolean>
  onDiscardChanges: (worktreePath: string, relativePath: string) => Promise<boolean>
  onViewDiff: (file: GitFileStatus, worktreePath: string) => void
}

const MemberChanges = memo(function MemberChanges({
  member,
  onStageFile,
  onUnstageFile,
  onStageAll,
  onUnstageAll,
  onDiscardChanges,
  onViewDiff
}: MemberChangesProps): React.JSX.Element {
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())

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

  const handleViewDiff = useCallback(
    (file: GitFileStatus) => onViewDiff(file, member.worktree_path),
    [onViewDiff, member.worktree_path]
  )

  const wp = member.worktree_path

  const handleStageToggle = useCallback(
    (file: GitFileStatus) => {
      onStageFile(wp, file.relativePath)
    },
    [onStageFile, wp]
  )

  const handleUnstageToggle = useCallback(
    (file: GitFileStatus) => {
      onUnstageFile(wp, file.relativePath)
    },
    [onUnstageFile, wp]
  )

  return (
    <div className="pl-3 pb-1">
      {/* Staged */}
      {member.staged.length > 0 && (
        <GroupHeader
          title="Staged Changes"
          count={member.staged.length}
          isCollapsed={collapsed.has('staged')}
          onToggle={() => toggleGroup('staged')}
          action={
            <Button
              variant="ghost"
              size="sm"
              className="h-5 px-1.5 text-[10px]"
              onClick={() => onUnstageAll(wp)}
              title="Unstage all"
            >
              <Minus className="h-3 w-3 mr-0.5" />
              Unstage
            </Button>
          }
        >
          {member.staged.map((file) => (
            <FileRow
              key={`staged-${file.relativePath}`}
              file={file}
              onViewDiff={handleViewDiff}
              onStageToggle={handleUnstageToggle}
              contextMenu={
                <ContextMenuContent>
                  <ContextMenuItem onClick={() => onUnstageFile(wp, file.relativePath)}>
                    <Minus className="h-3.5 w-3.5 mr-2" />
                    Unstage
                  </ContextMenuItem>
                </ContextMenuContent>
              }
            />
          ))}
        </GroupHeader>
      )}

      {/* Modified */}
      {member.modified.length > 0 && (
        <GroupHeader
          title="Changes"
          count={member.modified.length}
          isCollapsed={collapsed.has('modified')}
          onToggle={() => toggleGroup('modified')}
          action={
            <Button
              variant="ghost"
              size="sm"
              className="h-5 px-1.5 text-[10px]"
              onClick={() => onStageAll(wp)}
              title="Stage all"
            >
              <Plus className="h-3 w-3 mr-0.5" />
              Stage
            </Button>
          }
        >
          {member.modified.map((file) => (
            <FileRow
              key={`modified-${file.relativePath}`}
              file={file}
              onViewDiff={handleViewDiff}
              onStageToggle={handleStageToggle}
              contextMenu={
                <ContextMenuContent>
                  <ContextMenuItem onClick={() => onStageFile(wp, file.relativePath)}>
                    <Plus className="h-3.5 w-3.5 mr-2" />
                    Stage
                  </ContextMenuItem>
                  <ContextMenuSeparator />
                  <ContextMenuItem
                    onClick={() => onDiscardChanges(wp, file.relativePath)}
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

      {/* Untracked */}
      {member.untracked.length > 0 && (
        <GroupHeader
          title="Untracked"
          count={member.untracked.length}
          isCollapsed={collapsed.has('untracked')}
          onToggle={() => toggleGroup('untracked')}
        >
          {member.untracked.map((file) => (
            <FileRow
              key={`untracked-${file.relativePath}`}
              file={file}
              onViewDiff={handleViewDiff}
              onStageToggle={handleStageToggle}
              contextMenu={
                <ContextMenuContent>
                  <ContextMenuItem onClick={() => onStageFile(wp, file.relativePath)}>
                    <Plus className="h-3.5 w-3.5 mr-2" />
                    Stage
                  </ContextMenuItem>
                </ContextMenuContent>
              }
            />
          ))}
        </GroupHeader>
      )}

      {/* Commit form when staged changes exist */}
      {member.staged.length > 0 && (
        <GitCommitForm worktreePath={wp} hasConflicts={member.conflicted.length > 0} />
      )}

      {/* Push/Pull controls */}
      <GitPushPull worktreePath={wp} />
    </div>
  )
})
