import { useCallback, lazy, Suspense } from 'react'
import { Loader2 } from 'lucide-react'
import { SessionTabs, SessionView } from '@/components/sessions'
import { SessionTerminalView } from '@/components/sessions/SessionTerminalView'
import { FileViewer } from '@/components/file-viewer'
import { InlineDiffViewer } from '@/components/diff'
import { useWorktreeStore } from '@/stores/useWorktreeStore'
import { useSessionStore } from '@/stores/useSessionStore'
import { useConnectionStore } from '@/stores/useConnectionStore'
import { useFileViewerStore } from '@/stores/useFileViewerStore'

const MonacoDiffView = lazy(() => import('@/components/diff/MonacoDiffView'))

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

  // Look up the agent_sdk for a given session ID
  const getAgentSdk = useCallback(
    (sid: string | null): string | null => {
      if (!sid) return null
      const state = useSessionStore.getState()
      for (const sessions of state.sessionsByWorktree.values()) {
        const found = sessions.find((s) => s.id === sid)
        if (found) return found.agent_sdk
      }
      for (const sessions of state.sessionsByConnection.values()) {
        const found = sessions.find((s) => s.id === sid)
        if (found) return found.agent_sdk
      }
      return null
    },
    []
  )

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

    // Diff viewer is active
    if (activeDiff) {
      // New/untracked files use the syntax highlighter view
      if (activeDiff.isNewFile || activeDiff.isUntracked) {
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
      // Tracked files use Monaco DiffEditor with per-hunk actions
      return (
        <Suspense
          fallback={
            <div className="flex-1 flex items-center justify-center">
              <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
            </div>
          }
        >
          <MonacoDiffView
            worktreePath={activeDiff.worktreePath}
            filePath={activeDiff.filePath}
            fileName={activeDiff.fileName}
            staged={activeDiff.staged}
            isUntracked={activeDiff.isUntracked}
            isNewFile={activeDiff.isNewFile}
            onClose={handleCloseDiff}
          />
        </Suspense>
      )
    }

    // File viewer tab is active - render FileViewer (skip diff tab keys)
    if (activeFilePath && !activeFilePath.startsWith('diff:')) {
      return <FileViewer filePath={activeFilePath} />
    }

    // Inline connection session view (sticky tab clicked in worktree mode)
    if (inlineConnectionSessionId) {
      if (getAgentSdk(inlineConnectionSessionId) === 'terminal') {
        return <SessionTerminalView key={inlineConnectionSessionId} sessionId={inlineConnectionSessionId} />
      }
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

    // Session is active - dispatch based on agent SDK
    if (getAgentSdk(activeSessionId) === 'terminal') {
      return <SessionTerminalView key={activeSessionId} sessionId={activeSessionId} />
    }
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
