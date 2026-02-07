import { useCallback, memo, useMemo } from 'react'
import { ChevronRight } from 'lucide-react'
import { cn } from '@/lib/utils'
import { FileIcon } from './FileIcon'
import { GitStatusIndicator, type GitStatusCode } from './GitStatusIndicator'
import { FileContextMenu } from './FileContextMenu'
import { ContextMenuTrigger } from '@/components/ui/context-menu'

// File tree node structure
interface FileTreeNode {
  name: string
  path: string
  relativePath: string
  isDirectory: boolean
  extension: string | null
  children?: FileTreeNode[]
}

// Git file status
interface GitFileStatus {
  path: string
  relativePath: string
  status: GitStatusCode
  staged: boolean
}

// Helper to check if a node matches the filter
function matchesFilter(node: FileTreeNode, filter: string): boolean {
  return node.name.toLowerCase().includes(filter.toLowerCase())
}

// Helper to get git status for a node using the Map for O(1) lookup
function getNodeGitStatus(
  node: FileTreeNode,
  gitStatusMap: Map<string, GitFileStatus>
): GitFileStatus | undefined {
  // For files, return direct status
  if (!node.isDirectory) {
    return gitStatusMap.get(node.relativePath)
  }

  // For directories, check if any child has changes
  const prefix = node.relativePath + '/'
  const priorities: GitStatusCode[] = ['C', 'D', 'M', 'A', '?']
  let hasAnyChild = false
  let hasStaged = false

  for (const [relPath, status] of gitStatusMap) {
    if (relPath.startsWith(prefix)) {
      hasAnyChild = true
      if (status.staged) hasStaged = true
    }
  }

  if (!hasAnyChild) return undefined

  // Return the most "severe" status
  for (const statusCode of priorities) {
    for (const [relPath, status] of gitStatusMap) {
      if (relPath.startsWith(prefix) && status.status === statusCode) {
        return {
          path: node.path,
          relativePath: node.relativePath,
          status: statusCode,
          staged: hasStaged
        }
      }
    }
  }

  return undefined
}

interface VirtualFileTreeNodeProps {
  node: FileTreeNode
  depth: number
  isExpanded: boolean
  isFiltered: boolean
  filter: string
  onToggle: (path: string) => void
  onFileClick?: (node: FileTreeNode) => void
  worktreePath: string
  gitStatusMap: Map<string, GitFileStatus>
}

export const VirtualFileTreeNode = memo(function VirtualFileTreeNode({
  node,
  depth,
  isExpanded,
  isFiltered,
  filter,
  onToggle,
  onFileClick,
  worktreePath,
  gitStatusMap
}: VirtualFileTreeNodeProps) {
  const handleClick = useCallback(() => {
    if (node.isDirectory) {
      onToggle(node.path)
    } else {
      onFileClick?.(node)
    }
  }, [node, onToggle, onFileClick])

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault()
        handleClick()
      }
    },
    [handleClick]
  )

  // Get git status for this node
  const gitStatus = useMemo(
    () => getNodeGitStatus(node, gitStatusMap),
    [node, gitStatusMap]
  )

  const nodeContent = (
    <div
      className={cn(
        'flex items-center py-0.5 px-1 rounded-sm cursor-pointer',
        'hover:bg-accent/50 transition-colors',
        'focus:outline-none focus:bg-accent/50'
      )}
      style={{ paddingLeft: `${depth * 12 + 4}px` }}
      onClick={handleClick}
      onKeyDown={handleKeyDown}
      tabIndex={0}
      role="treeitem"
      aria-expanded={node.isDirectory ? isExpanded : undefined}
      aria-selected={false}
      aria-label={`${node.isDirectory ? 'Folder' : 'File'}: ${node.name}${gitStatus ? `, ${gitStatus.staged ? 'staged' : 'modified'}` : ''}`}
    >
      {/* Expand/collapse chevron for directories */}
      {node.isDirectory ? (
        <ChevronRight
          className={cn(
            'h-3.5 w-3.5 flex-shrink-0 mr-1 text-muted-foreground transition-transform duration-150',
            isExpanded && 'rotate-90'
          )}
          aria-hidden="true"
        />
      ) : (
        <span className="w-3.5 mr-1 flex-shrink-0" aria-hidden="true" />
      )}

      {/* File/folder icon */}
      <FileIcon
        name={node.name}
        extension={node.extension}
        isDirectory={node.isDirectory}
        isExpanded={isExpanded}
        className="mr-1.5"
      />

      {/* File/folder name */}
      <span
        className={cn(
          'text-xs truncate flex-1',
          isFiltered && matchesFilter(node, filter) && 'font-medium text-primary'
        )}
        title={node.relativePath}
      >
        {node.name}
      </span>

      {/* Git status indicator */}
      {gitStatus && (
        <GitStatusIndicator
          status={gitStatus.status}
          staged={gitStatus.staged}
          className="ml-1"
        />
      )}
    </div>
  )

  return (
    <FileContextMenu
      node={node}
      worktreePath={worktreePath}
      gitStatus={gitStatus?.status}
      staged={gitStatus?.staged}
    >
      <ContextMenuTrigger asChild>{nodeContent}</ContextMenuTrigger>
    </FileContextMenu>
  )
})

// Keep the old export name for backward compatibility (used in tests)
export { VirtualFileTreeNode as FileTreeNodeComponent }
