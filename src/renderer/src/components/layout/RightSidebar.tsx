import { useMemo } from 'react'
import { useLayoutStore } from '@/stores/useLayoutStore'
import { useWorktreeStore } from '@/stores/useWorktreeStore'
import { ResizeHandle } from './ResizeHandle'
import { FileTree } from '@/components/file-tree'
import { GitStatusPanel } from '@/components/git'
import { BottomPanel } from './BottomPanel'
import { ErrorBoundary, ErrorFallback } from '@/components/error'

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
        role="complementary"
        aria-label="Git status and file tree"
      >
        {/* Top half: Git status + File tree */}
        <div className="flex flex-col flex-1 min-h-0" data-testid="right-sidebar-top">
          <ErrorBoundary
            componentName="GitStatusPanel"
            fallback={
              <div className="border-b p-2">
                <ErrorFallback compact title="Git panel error" />
              </div>
            }
          >
            <GitStatusPanel worktreePath={selectedWorktreePath} />
          </ErrorBoundary>
          <ErrorBoundary
            componentName="FileTree"
            fallback={
              <div className="flex-1 p-2">
                <ErrorFallback compact title="File tree error" />
              </div>
            }
          >
            <FileTree
              worktreePath={selectedWorktreePath}
              onClose={toggleRightSidebar}
              onFileClick={handleFileClick}
              className="flex-1 min-h-0"
            />
          </ErrorBoundary>
        </div>

        {/* Divider */}
        <div className="border-t border-border" data-testid="right-sidebar-divider" />

        {/* Bottom half: Tab panel */}
        <div className="flex flex-col flex-1 min-h-0" data-testid="right-sidebar-bottom">
          <BottomPanel />
        </div>
      </aside>
    </div>
  )
}
