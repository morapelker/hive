import { useCallback } from 'react'
import { ChevronRight } from 'lucide-react'
import { cn } from '@/lib/utils'
import { FileIcon } from './FileIcon'

// File tree node structure
interface FileTreeNode {
  name: string
  path: string
  relativePath: string
  isDirectory: boolean
  extension: string | null
  children?: FileTreeNode[]
}

interface FileTreeNodeProps {
  node: FileTreeNode
  depth: number
  isExpanded: boolean
  isFiltered: boolean
  onToggle: (path: string) => void
  onFileClick?: (node: FileTreeNode) => void
  expandedPaths: Set<string>
  filter: string
}

// Helper to check if a node matches the filter
function matchesFilter(node: FileTreeNode, filter: string): boolean {
  const lowerFilter = filter.toLowerCase()
  if (node.name.toLowerCase().includes(lowerFilter)) {
    return true
  }
  return false
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

export function FileTreeNodeComponent({
  node,
  depth,
  isExpanded,
  isFiltered,
  onToggle,
  onFileClick,
  expandedPaths,
  filter
}: FileTreeNodeProps): React.JSX.Element | null {
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

  // If filtering and this node doesn't match and has no matching descendants, hide it
  if (
    isFiltered &&
    !matchesFilter(node, filter) &&
    !(node.isDirectory && hasMatchingDescendant(node, filter))
  ) {
    return null
  }

  // Should show children if expanded or if filtering and has matching descendants
  const showChildren =
    node.isDirectory &&
    node.children &&
    (isExpanded || (isFiltered && hasMatchingDescendant(node, filter)))

  return (
    <div data-testid={`file-tree-node-${node.relativePath}`}>
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
      >
        {/* Expand/collapse chevron for directories */}
        {node.isDirectory ? (
          <ChevronRight
            className={cn(
              'h-3.5 w-3.5 flex-shrink-0 mr-1 text-muted-foreground transition-transform',
              isExpanded && 'rotate-90'
            )}
          />
        ) : (
          <span className="w-3.5 mr-1 flex-shrink-0" />
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
            'text-xs truncate',
            isFiltered && matchesFilter(node, filter) && 'font-medium text-primary'
          )}
          title={node.relativePath}
        >
          {node.name}
        </span>
      </div>

      {/* Children */}
      {showChildren && (
        <div role="group">
          {node.children!.map((child) => (
            <FileTreeNodeComponent
              key={child.path}
              node={child}
              depth={depth + 1}
              isExpanded={expandedPaths.has(child.path)}
              isFiltered={isFiltered}
              onToggle={onToggle}
              onFileClick={onFileClick}
              expandedPaths={expandedPaths}
              filter={filter}
            />
          ))}
        </div>
      )}
    </div>
  )
}
