import { Loader2 } from 'lucide-react'
import { SessionTabs, SessionView } from '@/components/sessions'
import { useWorktreeStore } from '@/stores/useWorktreeStore'
import { useSessionStore } from '@/stores/useSessionStore'

interface MainPaneProps {
  children?: React.ReactNode
}

export function MainPane({ children }: MainPaneProps): React.JSX.Element {
  const selectedWorktreeId = useWorktreeStore((state) => state.selectedWorktreeId)
  const activeSessionId = useSessionStore((state) => state.activeSessionId)
  const isLoading = useSessionStore((state) => state.isLoading)

  // Determine what to show in the main content area
  const renderContent = () => {
    if (children) {
      return children
    }

    // No worktree selected - show welcome message
    if (!selectedWorktreeId) {
      return (
        <div className="flex-1 flex items-center justify-center text-muted-foreground">
          <div className="text-center">
            <p className="text-lg font-medium">Welcome to Hive</p>
            <p className="text-sm mt-2">Select a project or worktree to get started.</p>
          </div>
        </div>
      )
    }

    // Loading sessions (including auto-start)
    if (isLoading) {
      return (
        <div className="flex-1 flex items-center justify-center" data-testid="session-loading">
          <div className="text-center">
            <Loader2 className="h-6 w-6 animate-spin text-muted-foreground mx-auto" />
            <p className="text-sm text-muted-foreground mt-2">Loading sessions...</p>
          </div>
        </div>
      )
    }

    // Worktree selected but no session - show create session prompt
    if (!activeSessionId) {
      return (
        <div className="flex-1 flex items-center justify-center text-muted-foreground">
          <div className="text-center">
            <p className="text-lg font-medium">No active session</p>
            <p className="text-sm mt-2">Click the + button above to create a new session.</p>
          </div>
        </div>
      )
    }

    // Session is active - render SessionView
    return <SessionView sessionId={activeSessionId} />
  }

  return (
    <main
      className="flex-1 flex flex-col min-w-0 bg-background overflow-hidden"
      data-testid="main-pane"
    >
      {selectedWorktreeId && <SessionTabs />}
      {renderContent()}
    </main>
  )
}
