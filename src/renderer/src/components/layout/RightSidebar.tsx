import { useMemo } from 'react'
import { useLayoutStore } from '@/stores/useLayoutStore'
import { useWorktreeStore } from '@/stores/useWorktreeStore'
import { ResizeHandle } from './ResizeHandle'
import { FileTree } from '@/components/file-tree'

export function RightSidebar(): React.JSX.Element {
  const { rightSidebarWidth, rightSidebarCollapsed, setRightSidebarWidth, toggleRightSidebar } =
    useLayoutStore()

  const { selectedWorktreeId, worktreesByProject } = useWorktreeStore()

  // Get the selected worktree path by searching all projects' worktrees
  const selectedWorktreePath = useMemo(() => {
    if (!selectedWorktreeId) return null

    // Search through all projects' worktrees to find the selected one
    for (const [, worktrees] of worktreesByProject) {
      const worktree = worktrees.find((w) => w.id === selectedWorktreeId)
      if (worktree) {
        return worktree.path
      }
    }
    return null
  }, [selectedWorktreeId, worktreesByProject])

  const handleResize = (delta: number): void => {
    setRightSidebarWidth(rightSidebarWidth + delta)
  }

  const handleFileClick = (node: { path: string; isDirectory: boolean }): void => {
    // Open file in default editor
    if (!node.isDirectory) {
      window.worktreeOps.openInEditor(node.path)
    }
  }

  if (rightSidebarCollapsed) {
    return <div data-testid="right-sidebar-collapsed" />
  }

  return (
    <div className="flex flex-shrink-0" data-testid="right-sidebar-container">
      <ResizeHandle onResize={handleResize} direction="right" />
      <aside
        className="bg-sidebar text-sidebar-foreground border-l flex flex-col overflow-hidden"
        style={{ width: rightSidebarWidth }}
        data-testid="right-sidebar"
        data-width={rightSidebarWidth}
      >
        <FileTree
          worktreePath={selectedWorktreePath}
          onClose={toggleRightSidebar}
          onFileClick={handleFileClick}
          className="h-full"
        />
      </aside>
    </div>
  )
}
