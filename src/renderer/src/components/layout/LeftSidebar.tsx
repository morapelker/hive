import { useLayoutStore, LAYOUT_CONSTRAINTS } from '@/stores/useLayoutStore'
import { ResizeHandle } from './ResizeHandle'
import { FolderGit2, Plus } from 'lucide-react'
import { Button } from '@/components/ui/button'

export function LeftSidebar(): React.JSX.Element {
  const { leftSidebarWidth, setLeftSidebarWidth } = useLayoutStore()

  const handleResize = (delta: number): void => {
    setLeftSidebarWidth(leftSidebarWidth + delta)
  }

  return (
    <div className="flex flex-shrink-0" data-testid="left-sidebar-container">
      <aside
        className="bg-sidebar text-sidebar-foreground border-r flex flex-col overflow-hidden"
        style={{ width: leftSidebarWidth }}
        data-testid="left-sidebar"
        data-width={leftSidebarWidth}
      >
        <div className="p-3 border-b flex items-center justify-between">
          <div className="flex items-center gap-2 text-sm font-medium">
            <FolderGit2 className="h-4 w-4" />
            <span>Projects</span>
          </div>
          <Button variant="ghost" size="icon" className="h-6 w-6" title="Add Project">
            <Plus className="h-4 w-4" />
          </Button>
        </div>
        <div className="flex-1 overflow-auto p-2">
          <div className="text-sm text-muted-foreground text-center py-8">
            No projects added yet.
            <br />
            <span className="text-xs">Click + to add a project.</span>
          </div>
        </div>
        <div className="p-2 border-t text-xs text-muted-foreground">
          Width: {leftSidebarWidth}px
          <br />
          Min: {LAYOUT_CONSTRAINTS.leftSidebar.min}px | Max: {LAYOUT_CONSTRAINTS.leftSidebar.max}px
        </div>
      </aside>
      <ResizeHandle onResize={handleResize} direction="left" />
    </div>
  )
}
