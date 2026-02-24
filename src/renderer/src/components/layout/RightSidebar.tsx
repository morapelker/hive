import { useMemo } from 'react'
import { useLayoutStore } from '@/stores/useLayoutStore'
import { useWorktreeStore } from '@/stores/useWorktreeStore'
import { useConnectionStore } from '@/stores/useConnectionStore'
import { useFileViewerStore } from '@/stores/useFileViewerStore'
import { ResizeHandle } from './ResizeHandle'
import { FileSidebar } from '@/components/file-tree'
import { BottomPanel } from './BottomPanel'
import { TerminalManager } from '@/components/terminal/TerminalManager'
import { ErrorBoundary, ErrorFallback } from '@/components/error'

export function RightSidebar(): React.JSX.Element {
  const { rightSidebarWidth, rightSidebarCollapsed, setRightSidebarWidth, toggleRightSidebar } =
    useLayoutStore()
  const bottomPanelTab = useLayoutStore((s) => s.bottomPanelTab)

  const { selectedWorktreeId, worktreesByProject } = useWorktreeStore()
  const selectedConnectionId = useConnectionStore((s) => s.selectedConnectionId)
  const selectedConnection = useConnectionStore((s) =>
    s.selectedConnectionId ? s.connections.find((c) => c.id === s.selectedConnectionId) : null
  )
  const isConnectionMode = !!selectedConnectionId && !selectedWorktreeId

  // Get the selected worktree path by searching all projects' worktrees
  const selectedWorktreePath = useMemo(() => {
    // In connection mode, use the connection's folder path
    if (isConnectionMode && selectedConnection?.path) {
      return selectedConnection.path
    }

    if (!selectedWorktreeId) return null

    // Search through all projects' worktrees to find the selected one
    for (const [, worktrees] of worktreesByProject) {
      const worktree = worktrees.find((w) => w.id === selectedWorktreeId)
      if (worktree) {
        return worktree.path
      }
    }
    return null
  }, [selectedWorktreeId, worktreesByProject, isConnectionMode, selectedConnection?.path])

  const handleResize = (delta: number): void => {
    setRightSidebarWidth(rightSidebarWidth + delta)
  }

  const handleFileClick = (node: { path: string; name: string; isDirectory: boolean }): void => {
    // Open file in the file viewer tab
    const contextId = selectedWorktreeId || selectedConnectionId
    if (!node.isDirectory && contextId) {
      useFileViewerStore.getState().openFile(node.path, node.name, contextId)
    }
  }

  // TerminalManager is always rendered (even when sidebar is collapsed) to preserve
  // PTY state across sidebar collapse/expand and worktree switches.
  const terminalManager = (
    <TerminalManager
      selectedWorktreeId={selectedWorktreeId}
      worktreePath={selectedWorktreePath}
      isVisible={!rightSidebarCollapsed && bottomPanelTab === 'terminal'}
    />
  )

  if (rightSidebarCollapsed) {
    return (
      <div data-testid="right-sidebar-collapsed">
        {/* Keep TerminalManager alive when sidebar is collapsed so PTYs persist */}
        <div className="hidden">{terminalManager}</div>
      </div>
    )
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
        aria-label="File sidebar"
      >
        {/* Top half: Tabbed sidebar (Changes / Files) */}
        <div className="flex flex-col flex-1 min-h-0" data-testid="right-sidebar-top">
          <ErrorBoundary
            componentName="FileSidebar"
            fallback={
              <div className="flex-1 p-2">
                <ErrorFallback compact title="File sidebar error" />
              </div>
            }
          >
            <FileSidebar
              worktreePath={selectedWorktreePath}
              isConnectionMode={isConnectionMode}
              connectionMembers={selectedConnection?.members}
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
          <BottomPanel terminalSlot={terminalManager} />
        </div>
      </aside>
    </div>
  )
}
