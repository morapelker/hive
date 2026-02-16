import { useEffect } from 'react'
import { useLayoutStore } from '@/stores/useLayoutStore'
import { useSpaceStore } from '@/stores'
import { ResizeHandle } from './ResizeHandle'
import { FolderGit2 } from 'lucide-react'
import { ProjectList, AddProjectButton } from '@/components/projects'
import { ConnectionList } from '@/components/connections'
import { SpacesTabBar } from '@/components/spaces'

export function LeftSidebar(): React.JSX.Element {
  const { leftSidebarWidth, leftSidebarCollapsed, setLeftSidebarWidth } = useLayoutStore()
  const loadSpaces = useSpaceStore((s) => s.loadSpaces)

  useEffect(() => {
    loadSpaces()
  }, [loadSpaces])

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
        <div className="p-3 border-b flex items-center justify-between">
          <div className="flex items-center gap-2 text-sm font-medium">
            <FolderGit2 className="h-4 w-4" />
            <span>Projects</span>
          </div>
          <AddProjectButton />
        </div>
        <div className="flex-1 overflow-auto p-2">
          <ConnectionList />
          <ProjectList onAddProject={handleAddProject} />
        </div>
        <SpacesTabBar />
      </aside>
      <ResizeHandle onResize={handleResize} direction="left" />
    </div>
  )
}
