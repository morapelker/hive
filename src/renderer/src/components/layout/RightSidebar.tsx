import { useLayoutStore, LAYOUT_CONSTRAINTS } from '@/stores/useLayoutStore'
import { ResizeHandle } from './ResizeHandle'
import { FolderTree, X } from 'lucide-react'
import { Button } from '@/components/ui/button'

export function RightSidebar(): React.JSX.Element {
  const { rightSidebarWidth, rightSidebarCollapsed, setRightSidebarWidth, toggleRightSidebar } =
    useLayoutStore()

  const handleResize = (delta: number): void => {
    setRightSidebarWidth(rightSidebarWidth + delta)
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
        <div className="p-3 border-b flex items-center justify-between">
          <div className="flex items-center gap-2 text-sm font-medium">
            <FolderTree className="h-4 w-4" />
            <span>File Tree</span>
          </div>
          <Button
            variant="ghost"
            size="icon"
            className="h-6 w-6"
            onClick={toggleRightSidebar}
            title="Close sidebar"
          >
            <X className="h-4 w-4" />
          </Button>
        </div>
        <div className="flex-1 flex items-center justify-center p-4">
          <div className="text-center text-muted-foreground">
            <FolderTree className="h-12 w-12 mx-auto mb-4 opacity-50" />
            <p className="text-sm font-medium">File Tree</p>
            <p className="text-xs mt-1">Coming Soon</p>
          </div>
        </div>
        <div className="p-2 border-t text-xs text-muted-foreground">
          Width: {rightSidebarWidth}px
          <br />
          Min: {LAYOUT_CONSTRAINTS.rightSidebar.min}px
        </div>
      </aside>
    </div>
  )
}
