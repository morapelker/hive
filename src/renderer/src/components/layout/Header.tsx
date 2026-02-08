import { PanelRightClose, PanelRightOpen, History } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useLayoutStore } from '@/stores/useLayoutStore'
import { useSessionHistoryStore } from '@/stores/useSessionHistoryStore'

export function Header(): React.JSX.Element {
  const { rightSidebarCollapsed, toggleRightSidebar } = useLayoutStore()
  const { openPanel: openSessionHistory } = useSessionHistoryStore()

  return (
    <header
      className="h-12 border-b bg-background flex items-center justify-between px-4 flex-shrink-0 select-none"
      style={{ WebkitAppRegion: 'drag' } as React.CSSProperties}
      data-testid="header"
    >
      {/* Spacer for macOS traffic lights */}
      <div className="w-16 flex-shrink-0" />
      <div className="flex items-center gap-2 flex-1">
        <h1 className="text-lg font-semibold">Hive</h1>
      </div>
      <div
        className="flex items-center gap-2"
        style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
      >
        <Button
          variant="ghost"
          size="icon"
          onClick={openSessionHistory}
          title="Session History (⌘K)"
          data-testid="session-history-toggle"
        >
          <History className="h-4 w-4" />
        </Button>
        <Button
          onClick={toggleRightSidebar}
          variant="ghost"
          size="icon"
          title={rightSidebarCollapsed ? 'Show sidebar' : 'Hide sidebar'}
          data-testid="right-sidebar-toggle"
        >
          {rightSidebarCollapsed ? (
            <PanelRightOpen className="h-4 w-4" />
          ) : (
            <PanelRightClose className="h-4 w-4" />
          )}
        </Button>
      </div>
    </header>
  )
}
