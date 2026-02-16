import { useEffect, useCallback, useRef, useMemo } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import { FolderOpen } from 'lucide-react'
import { useFileTreeStore } from '@/stores/useFileTreeStore'
import { useGitStore } from '@/stores/useGitStore'
import { FileTreeHeader } from './FileTreeHeader'
import { FileTreeFilter } from './FileTreeFilter'
import { VirtualFileTreeNode } from './FileTreeNode'
import { cn } from '@/lib/utils'

// File tree node structure
interface FileTreeNode {
  name: string
  path: string
  relativePath: string
  isDirectory: boolean
  isSymlink?: boolean
  extension: string | null
  children?: FileTreeNode[]
}

// Git file status
interface GitFileStatus {
  path: string
  relativePath: string
  status: 'M' | 'A' | 'D' | '?' | 'C' | ''
  staged: boolean
}

interface FlatNode {
  node: FileTreeNode
  depth: number
  isExpanded: boolean
}

interface FileTreeProps {
  worktreePath: string | null
  onClose?: () => void
  onFileClick?: (node: FileTreeNode) => void
  className?: string
  hideHeader?: boolean
  hideGitIndicators?: boolean
  hideGitContextActions?: boolean
}

// Helper to check if a node matches the filter
function matchesFilter(node: FileTreeNode, filter: string): boolean {
  return node.name.toLowerCase().includes(filter.toLowerCase())
}

// Helper to check if any descendant matches the filter
function hasMatchingDescendant(node: FileTreeNode, filter: string): boolean {
  if (!node.children) return false
  for (const child of node.children) {
    if (matchesFilter(child, filter)) return true
    if (child.isDirectory && hasMatchingDescendant(child, filter)) return true
  }
  return false
}

// Flatten tree into a list for virtual scrolling
function flattenTree(
  nodes: FileTreeNode[],
  expandedPaths: Set<string>,
  filter: string,
  depth: number = 0
): FlatNode[] {
  const result: FlatNode[] = []
  const isFiltered = filter.length > 0

  for (const node of nodes) {
    // Filter check
    if (
      isFiltered &&
      !matchesFilter(node, filter) &&
      !(node.isDirectory && hasMatchingDescendant(node, filter))
    ) {
      continue
    }

    const isExpanded = expandedPaths.has(node.path)
    result.push({ node, depth, isExpanded })

    // Include children if expanded or filtered with matching descendants
    const showChildren =
      node.isDirectory &&
      node.children &&
      (isExpanded || (isFiltered && hasMatchingDescendant(node, filter)))

    if (showChildren && node.children) {
      result.push(...flattenTree(node.children, expandedPaths, filter, depth + 1))
    }
  }

  return result
}

const ROW_HEIGHT = 24

export function FileTree({
  worktreePath,
  onClose,
  onFileClick,
  className,
  hideHeader,
  hideGitIndicators,
  hideGitContextActions
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

  const { getFileStatuses, loadFileStatuses } = useGitStore()

  const unsubscribeRef = useRef<(() => void) | null>(null)
  const gitUnsubscribeRef = useRef<(() => void) | null>(null)
  const currentWorktreeRef = useRef<string | null>(null)
  const parentRef = useRef<HTMLDivElement>(null)

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

    // Subscribe to file change events (file tree refresh only;
    // git status refresh is handled by the main-process worktree watcher)
    unsubscribeRef.current = window.fileTreeOps.onChange((event) => {
      if (event.worktreePath === worktreePath) {
        handleFileChange(worktreePath, event.eventType, event.changedPath, event.relativePath)
      }
    })

    // Subscribe to git status change events (to re-render git indicators on file tree nodes)
    gitUnsubscribeRef.current = window.gitOps.onStatusChanged((event) => {
      if (event.worktreePath === worktreePath) {
        loadFileStatuses(worktreePath)
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
  }, [worktreePath, loadFileTree, loadFileStatuses, startWatching, stopWatching, handleFileChange])

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

  // Build a Map for fast git status lookup
  const gitStatusMap = useMemo(() => {
    const map = new Map<string, GitFileStatus>()
    for (const status of gitStatuses) {
      map.set(status.relativePath, status)
    }
    return map
  }, [gitStatuses])

  // Flatten tree for virtual scrolling
  const flatNodes = useMemo(
    () => flattenTree(tree, expandedPaths, filter),
    [tree, expandedPaths, filter]
  )

  // Virtual scrolling
  const virtualizer = useVirtualizer({
    count: flatNodes.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 10
  })

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

  const headerElement = !hideHeader ? (
    <FileTreeHeader
      filter={filter}
      isLoading={isLoading}
      onFilterChange={handleFilterChange}
      onRefresh={handleRefresh}
      onCollapseAll={handleCollapseAll}
      onClose={onClose}
    />
  ) : (
    <div className="p-2 border-b">
      <FileTreeFilter value={filter} onChange={handleFilterChange} />
    </div>
  )

  // No worktree selected
  if (!worktreePath) {
    return (
      <div className={cn('flex flex-col h-full', className)}>
        {!hideHeader ? (
          <FileTreeHeader
            filter=""
            isLoading={false}
            onFilterChange={() => {}}
            onRefresh={() => {}}
            onCollapseAll={() => {}}
            onClose={onClose}
          />
        ) : (
          <div className="p-2 border-b">
            <FileTreeFilter value="" onChange={() => {}} />
          </div>
        )}
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
        {headerElement}
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
        {headerElement}
        <div className="flex-1 flex items-center justify-center p-4">
          <div className="text-center text-muted-foreground">
            <div
              className="h-6 w-6 mx-auto mb-3 border-2 border-current border-t-transparent rounded-full animate-spin"
              aria-label="Loading files"
            />
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
        {headerElement}
        <div className="flex-1 flex items-center justify-center p-4">
          <div className="text-center text-muted-foreground">
            <FolderOpen className="h-10 w-10 mx-auto mb-3 opacity-50" />
            <p className="text-sm">No files found</p>
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
            <div
              className="h-6 w-6 mx-auto mb-3 border-2 border-current border-t-transparent rounded-full animate-spin"
              aria-label="Loading files"
            />
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
      {headerElement}
      <div
        ref={parentRef}
        className="flex-1 overflow-auto py-1"
        role="tree"
        aria-label="File tree"
        data-testid="file-tree-content"
      >
        <div
          style={{
            height: `${virtualizer.getTotalSize()}px`,
            width: '100%',
            position: 'relative'
          }}
        >
          {virtualizer.getVirtualItems().map((virtualRow) => {
            const { node, depth, isExpanded } = flatNodes[virtualRow.index]
            return (
              <div
                key={node.path}
                style={{
                  position: 'absolute',
                  top: 0,
                  left: 0,
                  width: '100%',
                  height: `${virtualRow.size}px`,
                  transform: `translateY(${virtualRow.start}px)`
                }}
              >
                <VirtualFileTreeNode
                  node={node}
                  depth={depth}
                  isExpanded={isExpanded}
                  isFiltered={isFiltered}
                  filter={filter}
                  onToggle={handleToggle}
                  onFileClick={onFileClick}
                  worktreePath={worktreePath}
                  gitStatusMap={gitStatusMap}
                  hideGitIndicators={hideGitIndicators}
                  hideGitContextActions={hideGitContextActions}
                />
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}
