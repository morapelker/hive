import { useEffect, useCallback, useRef } from 'react'
import { FolderOpen } from 'lucide-react'
import { useFileTreeStore } from '@/stores/useFileTreeStore'
import { useGitStore } from '@/stores/useGitStore'
import { FileTreeHeader } from './FileTreeHeader'
import { FileTreeNodeComponent } from './FileTreeNode'
import { cn } from '@/lib/utils'

// File tree node structure
interface FileTreeNode {
  name: string
  path: string
  relativePath: string
  isDirectory: boolean
  extension: string | null
  children?: FileTreeNode[]
}

interface FileTreeProps {
  worktreePath: string | null
  onClose?: () => void
  onFileClick?: (node: FileTreeNode) => void
  className?: string
}

export function FileTree({
  worktreePath,
  onClose,
  onFileClick,
  className
}: FileTreeProps): React.JSX.Element {
  const {
    isLoading,
    error,
    getFileTree,
    getExpandedPaths,
    getFilter,
    loadFileTree,
    toggleExpanded,
    collapseAll,
    setFilter,
    startWatching,
    stopWatching,
    handleFileChange
  } = useFileTreeStore()

  const {
    getFileStatuses,
    loadFileStatuses,
    refreshStatuses
  } = useGitStore()

  const unsubscribeRef = useRef<(() => void) | null>(null)
  const gitUnsubscribeRef = useRef<(() => void) | null>(null)
  const currentWorktreeRef = useRef<string | null>(null)

  // Load file tree, git statuses, and start watching when worktree changes
  useEffect(() => {
    if (!worktreePath) return

    // If switching worktrees, stop watching the previous one
    if (currentWorktreeRef.current && currentWorktreeRef.current !== worktreePath) {
      stopWatching(currentWorktreeRef.current)
      if (unsubscribeRef.current) {
        unsubscribeRef.current()
        unsubscribeRef.current = null
      }
      if (gitUnsubscribeRef.current) {
        gitUnsubscribeRef.current()
        gitUnsubscribeRef.current = null
      }
    }

    currentWorktreeRef.current = worktreePath

    // Load file tree
    loadFileTree(worktreePath)

    // Load git statuses
    loadFileStatuses(worktreePath)

    // Start watching
    startWatching(worktreePath)

    // Subscribe to file change events
    unsubscribeRef.current = window.fileTreeOps.onChange((event) => {
      if (event.worktreePath === worktreePath) {
        handleFileChange(worktreePath, event.eventType, event.changedPath, event.relativePath)
        // Also refresh git statuses on file changes
        refreshStatuses(worktreePath)
      }
    })

    // Subscribe to git status change events
    gitUnsubscribeRef.current = window.gitOps.onStatusChanged((event) => {
      if (event.worktreePath === worktreePath) {
        refreshStatuses(worktreePath)
      }
    })

    return () => {
      // Cleanup on unmount or worktree change
      if (unsubscribeRef.current) {
        unsubscribeRef.current()
        unsubscribeRef.current = null
      }
      if (gitUnsubscribeRef.current) {
        gitUnsubscribeRef.current()
        gitUnsubscribeRef.current = null
      }
    }
  }, [worktreePath, loadFileTree, loadFileStatuses, refreshStatuses, startWatching, stopWatching, handleFileChange])

  // Cleanup watching on unmount
  useEffect(() => {
    return () => {
      if (currentWorktreeRef.current) {
        stopWatching(currentWorktreeRef.current)
      }
    }
  }, [stopWatching])

  const tree = worktreePath ? getFileTree(worktreePath) : []
  const expandedPaths = worktreePath ? getExpandedPaths(worktreePath) : new Set<string>()
  const filter = worktreePath ? getFilter(worktreePath) : ''
  const gitStatuses = worktreePath ? getFileStatuses(worktreePath) : []

  const handleToggle = useCallback(
    (path: string) => {
      if (worktreePath) {
        toggleExpanded(worktreePath, path)
      }
    },
    [worktreePath, toggleExpanded]
  )

  const handleCollapseAll = useCallback(() => {
    if (worktreePath) {
      collapseAll(worktreePath)
    }
  }, [worktreePath, collapseAll])

  const handleFilterChange = useCallback(
    (value: string) => {
      if (worktreePath) {
        setFilter(worktreePath, value)
      }
    },
    [worktreePath, setFilter]
  )

  const handleRefresh = useCallback(() => {
    if (worktreePath) {
      loadFileTree(worktreePath)
      loadFileStatuses(worktreePath)
    }
  }, [worktreePath, loadFileTree, loadFileStatuses])

  // No worktree selected
  if (!worktreePath) {
    return (
      <div className={cn('flex flex-col h-full', className)}>
        <FileTreeHeader
          filter=""
          isLoading={false}
          onFilterChange={() => {}}
          onRefresh={() => {}}
          onCollapseAll={() => {}}
          onClose={onClose}
        />
        <div className="flex-1 flex items-center justify-center p-4">
          <div className="text-center text-muted-foreground">
            <FolderOpen className="h-10 w-10 mx-auto mb-3 opacity-50" />
            <p className="text-sm">Select a worktree</p>
            <p className="text-xs mt-1 opacity-75">to view its files</p>
          </div>
        </div>
      </div>
    )
  }

  // Error state
  if (error) {
    return (
      <div className={cn('flex flex-col h-full', className)}>
        <FileTreeHeader
          filter={filter}
          isLoading={isLoading}
          onFilterChange={handleFilterChange}
          onRefresh={handleRefresh}
          onCollapseAll={handleCollapseAll}
          onClose={onClose}
        />
        <div className="flex-1 flex items-center justify-center p-4">
          <div className="text-center text-destructive">
            <p className="text-sm font-medium">Error loading files</p>
            <p className="text-xs mt-1 opacity-75">{error}</p>
          </div>
        </div>
      </div>
    )
  }

  // Loading state
  if (isLoading && tree.length === 0) {
    return (
      <div className={cn('flex flex-col h-full', className)}>
        <FileTreeHeader
          filter={filter}
          isLoading={isLoading}
          onFilterChange={handleFilterChange}
          onRefresh={handleRefresh}
          onCollapseAll={handleCollapseAll}
          onClose={onClose}
        />
        <div className="flex-1 flex items-center justify-center p-4">
          <div className="text-center text-muted-foreground">
            <div className="h-6 w-6 mx-auto mb-3 border-2 border-current border-t-transparent rounded-full animate-spin" />
            <p className="text-sm">Loading files...</p>
          </div>
        </div>
      </div>
    )
  }

  // Empty state
  if (tree.length === 0) {
    return (
      <div className={cn('flex flex-col h-full', className)}>
        <FileTreeHeader
          filter={filter}
          isLoading={isLoading}
          onFilterChange={handleFilterChange}
          onRefresh={handleRefresh}
          onCollapseAll={handleCollapseAll}
          onClose={onClose}
        />
        <div className="flex-1 flex items-center justify-center p-4">
          <div className="text-center text-muted-foreground">
            <FolderOpen className="h-10 w-10 mx-auto mb-3 opacity-50" />
            <p className="text-sm">No files found</p>
          </div>
        </div>
      </div>
    )
  }

  const isFiltered = filter.length > 0

  return (
    <div className={cn('flex flex-col h-full', className)} data-testid="file-tree">
      <FileTreeHeader
        filter={filter}
        isLoading={isLoading}
        onFilterChange={handleFilterChange}
        onRefresh={handleRefresh}
        onCollapseAll={handleCollapseAll}
        onClose={onClose}
      />
      <div
        className="flex-1 overflow-auto py-1"
        role="tree"
        aria-label="File tree"
        data-testid="file-tree-content"
      >
        {tree.map((node) => (
          <FileTreeNodeComponent
            key={node.path}
            node={node}
            depth={0}
            isExpanded={expandedPaths.has(node.path)}
            isFiltered={isFiltered}
            onToggle={handleToggle}
            onFileClick={onFileClick}
            expandedPaths={expandedPaths}
            filter={filter}
            worktreePath={worktreePath}
            gitStatuses={gitStatuses}
          />
        ))}
      </div>
    </div>
  )
}
