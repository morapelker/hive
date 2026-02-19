import { useCallback } from 'react'
import { Loader2 } from 'lucide-react'
import { SessionTabs, SessionView } from '@/components/sessions'
import { FileViewer } from '@/components/file-viewer'
import { InlineDiffViewer } from '@/components/diff'
import { useWorktreeStore } from '@/stores/useWorktreeStore'
import { useSessionStore } from '@/stores/useSessionStore'
import { useConnectionStore } from '@/stores/useConnectionStore'
import { useFileViewerStore } from '@/stores/useFileViewerStore'

interface MainPaneProps {
  children?: React.ReactNode
}

export function MainPane({ children }: MainPaneProps): React.JSX.Element {
  const selectedWorktreeId = useWorktreeStore((state) => state.selectedWorktreeId)
  const selectedConnectionId = useConnectionStore((state) => state.selectedConnectionId)
  const activeSessionId = useSessionStore((state) => state.activeSessionId)
  const isLoading = useSessionStore((state) => state.isLoading)
  const inlineConnectionSessionId = useSessionStore((state) => state.inlineConnectionSessionId)
  const activeFilePath = useFileViewerStore((state) => state.activeFilePath)
  const activeDiff = useFileViewerStore((state) => state.activeDiff)

  const handleCloseDiff = useCallback(() => {
    const filePath = useFileViewerStore.getState().activeFilePath
    if (filePath?.startsWith('diff:')) {
      useFileViewerStore.getState().closeDiffTab(filePath)
    } else {
      useFileViewerStore.getState().clearActiveDiff()
    }
  }, [])

  // Determine what to show in the main content area
  const renderContent = () => {
    if (children) {
      return children
    }

    // No worktree or connection selected - show welcome message
    if (!selectedWorktreeId && !selectedConnectionId) {
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

    // Inline diff viewer is active
    if (activeDiff) {
      return (
        <InlineDiffViewer
          worktreePath={activeDiff.worktreePath}
          filePath={activeDiff.filePath}
          fileName={activeDiff.fileName}
          staged={activeDiff.staged}
          isUntracked={activeDiff.isUntracked}
          isNewFile={activeDiff.isNewFile}
          onClose={handleCloseDiff}
        />
      )
    }

    // File viewer tab is active - render FileViewer (skip diff tab keys)
    if (activeFilePath && !activeFilePath.startsWith('diff:')) {
      return <FileViewer filePath={activeFilePath} />
    }

    // Inline connection session view (sticky tab clicked in worktree mode)
    if (inlineConnectionSessionId) {
      return <SessionView key={inlineConnectionSessionId} sessionId={inlineConnectionSessionId} />
    }

    // Worktree or connection selected but no session - show create session prompt
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
    return <SessionView key={activeSessionId} sessionId={activeSessionId} />
  }

  return (
    <main
      className="flex-1 flex flex-col min-w-0 bg-background overflow-hidden"
      data-testid="main-pane"
    >
      {(selectedWorktreeId || selectedConnectionId) && <SessionTabs />}
      {renderContent()}
    </main>
  )
}
