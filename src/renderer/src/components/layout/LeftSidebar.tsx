import { useEffect } from 'react'
import { useLayoutStore } from '@/stores/useLayoutStore'
import { useSpaceStore, useProjectStore, useConnectionStore } from '@/stores'
import { ResizeHandle } from './ResizeHandle'
import { FolderGit2, Link, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { ProjectList, AddProjectButton, SortProjectsButton } from '@/components/projects'
import { ConnectionList } from '@/components/connections'
import { SpacesTabBar } from '@/components/spaces'

export function LeftSidebar(): React.JSX.Element {
  const { leftSidebarWidth, leftSidebarCollapsed, setLeftSidebarWidth } = useLayoutStore()
  const loadSpaces = useSpaceStore((s) => s.loadSpaces)
  const expandAllProjects = useProjectStore((s) => s.expandAllProjects)

  // Connection mode state
  const connectionModeActive = useConnectionStore((s) => s.connectionModeActive)
  const connectionModeSelectedIds = useConnectionStore((s) => s.connectionModeSelectedIds)
  const connectionModeSubmitting = useConnectionStore((s) => s.connectionModeSubmitting)
  const exitConnectionMode = useConnectionStore((s) => s.exitConnectionMode)
  const finalizeConnection = useConnectionStore((s) => s.finalizeConnection)

  const canFinalize = connectionModeSelectedIds.size >= 2

  useEffect(() => {
    loadSpaces()
  }, [loadSpaces])

  // Expand all projects when entering connection mode
  useEffect(() => {
    if (connectionModeActive) {
      expandAllProjects()
    }
  }, [connectionModeActive, expandAllProjects])

  // Escape key exits connection mode
  useEffect(() => {
    if (!connectionModeActive) return

    const handleEscape = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault()
        exitConnectionMode()
      }
    }

    document.addEventListener('keydown', handleEscape, true)
    return () => document.removeEventListener('keydown', handleEscape, true)
  }, [connectionModeActive, exitConnectionMode])

  // Exit connection mode if sidebar collapses
  useEffect(() => {
    if (leftSidebarCollapsed && connectionModeActive) {
      exitConnectionMode()
    }
  }, [leftSidebarCollapsed, connectionModeActive, exitConnectionMode])

  const handleResize = (delta: number): void => {
    setLeftSidebarWidth(leftSidebarWidth + delta)
  }

  const handleAddProject = async (): Promise<void> => {
    // Trigger the add project flow
    const addButton = document.querySelector(
      '[data-testid="add-project-button"]'
    ) as HTMLButtonElement
    if (addButton) {
      addButton.click()
    }
  }

  if (leftSidebarCollapsed) {
    return <div data-testid="left-sidebar-collapsed" />
  }

  return (
    <div className="flex flex-shrink-0" data-testid="left-sidebar-container">
      <aside
        className="bg-sidebar text-sidebar-foreground border-r flex flex-col overflow-hidden"
        style={{ width: leftSidebarWidth }}
        data-testid="left-sidebar"
        data-width={leftSidebarWidth}
        role="navigation"
        aria-label="Projects and worktrees"
      >
        {connectionModeActive ? (
          <div className="p-3 border-b flex items-center justify-between bg-muted/50">
            <div className="flex items-center gap-2 text-sm font-medium min-w-0">
              <Link className="h-4 w-4 text-primary shrink-0" />
              <span className="truncate">Select worktrees</span>
              <span className="text-xs text-muted-foreground shrink-0">
                ({connectionModeSelectedIds.size})
              </span>
            </div>
            <div className="flex items-center gap-1 shrink-0">
              <Button
                variant="ghost"
                size="sm"
                className="h-7 text-xs"
                onClick={exitConnectionMode}
                disabled={connectionModeSubmitting}
              >
                Cancel
              </Button>
              <Button
                size="sm"
                className="h-7 text-xs"
                onClick={finalizeConnection}
                disabled={!canFinalize || connectionModeSubmitting}
              >
                {connectionModeSubmitting ? (
                  <>
                    <Loader2 className="h-3 w-3 mr-1 animate-spin" />
                    Connecting...
                  </>
                ) : (
                  'Connect'
                )}
              </Button>
            </div>
          </div>
        ) : (
          <div className="p-3 border-b flex items-center justify-between">
            <div className="flex items-center gap-2 text-sm font-medium">
              <FolderGit2 className="h-4 w-4" />
              <span>Projects</span>
            </div>
            <div className="flex items-center gap-1">
              <SortProjectsButton />
              <AddProjectButton />
            </div>
          </div>
        )}
        <div className="flex-1 overflow-auto p-2">
          <ConnectionList />
          <ProjectList onAddProject={handleAddProject} />
        </div>
        {!connectionModeActive && <SpacesTabBar />}
      </aside>
      <ResizeHandle onResize={handleResize} direction="left" />
    </div>
  )
}
