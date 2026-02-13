import { useEffect, useMemo } from 'react'
import { Header } from './Header'
import { LeftSidebar } from './LeftSidebar'
import { MainPane } from './MainPane'
import { RightSidebar } from './RightSidebar'
import { Toaster } from '@/components/ui/sonner'
import { SessionHistory } from '@/components/sessions/SessionHistory'
import { CommandPalette } from '@/components/command-palette'
import { SettingsModal } from '@/components/settings'
import { FileSearchDialog } from '@/components/file-search'
import { useKeyboardShortcuts } from '@/hooks/useKeyboardShortcuts'
import { useOpenCodeGlobalListener } from '@/hooks/useOpenCodeGlobalListener'
import { useNotificationNavigation } from '@/hooks/useNotificationNavigation'
import { useWindowFocusRefresh } from '@/hooks/useWindowFocusRefresh'
import { useAutoUpdate } from '@/hooks/useAutoUpdate'
import { ErrorBoundary, ErrorFallback } from '@/components/error'
import { ProjectSettingsDialog } from '@/components/projects/ProjectSettingsDialog'
import { useProjectStore } from '@/stores/useProjectStore'
import { useWorktreeStore } from '@/stores/useWorktreeStore'
import { useGitStore } from '@/stores/useGitStore'

function GlobalProjectSettings(): React.JSX.Element | null {
  const settingsProjectId = useProjectStore((s) => s.settingsProjectId)
  const closeProjectSettings = useProjectStore((s) => s.closeProjectSettings)
  const project = useProjectStore((s) => s.projects.find((p) => p.id === s.settingsProjectId))

  if (!project) return null

  return (
    <ProjectSettingsDialog
      project={project}
      open={!!settingsProjectId}
      onOpenChange={(open) => {
        if (!open) closeProjectSettings()
      }}
    />
  )
}

interface AppLayoutProps {
  children?: React.ReactNode
}

export function AppLayout({ children }: AppLayoutProps): React.JSX.Element {
  // Register all keyboard shortcuts centrally
  useKeyboardShortcuts()
  // Global listener for background session events (AI finishes while viewing another project)
  useOpenCodeGlobalListener()
  // Navigate to session when native notification is clicked
  useNotificationNavigation()
  // Refresh git statuses when window regains focus
  useWindowFocusRefresh()
  // Auto-update notifications
  useAutoUpdate()

  // Check remote info on worktree selection (for PR feature)
  const selectedWorktreeId = useWorktreeStore((s) => s.selectedWorktreeId)
  const worktreesByProject = useWorktreeStore((s) => s.worktreesByProject)
  const selectedWorktreePath = useMemo(() => {
    if (!selectedWorktreeId) return null
    for (const worktrees of worktreesByProject.values()) {
      const wt = worktrees.find((w) => w.id === selectedWorktreeId)
      if (wt) return wt.path
    }
    return null
  }, [selectedWorktreeId, worktreesByProject])

  useEffect(() => {
    if (!selectedWorktreeId || !selectedWorktreePath) return
    const info = useGitStore.getState().remoteInfo.get(selectedWorktreeId)
    if (!info) {
      useGitStore.getState().checkRemoteInfo(selectedWorktreeId, selectedWorktreePath)
    }
  }, [selectedWorktreeId, selectedWorktreePath])

  return (
    <div className="h-screen flex flex-col bg-background text-foreground" data-testid="app-layout">
      <ErrorBoundary componentName="Header" fallback={<div className="h-12 bg-muted" />}>
        <Header />
      </ErrorBoundary>
      <div className="flex-1 flex min-h-0" data-testid="layout-content">
        <ErrorBoundary
          componentName="LeftSidebar"
          fallback={
            <div className="w-60 border-r bg-muted/50 flex items-center justify-center">
              <ErrorFallback compact title="Sidebar Error" />
            </div>
          }
        >
          <LeftSidebar />
        </ErrorBoundary>
        <ErrorBoundary componentName="MainPane">
          <MainPane>{children}</MainPane>
        </ErrorBoundary>
        <ErrorBoundary
          componentName="RightSidebar"
          fallback={<div className="border-l bg-muted/50" />}
        >
          <RightSidebar />
        </ErrorBoundary>
      </div>
      <Toaster />
      <ErrorBoundary componentName="SessionHistory" fallback={null}>
        <SessionHistory />
      </ErrorBoundary>
      <ErrorBoundary componentName="CommandPalette" fallback={null}>
        <CommandPalette />
      </ErrorBoundary>
      <ErrorBoundary componentName="SettingsModal" fallback={null}>
        <SettingsModal />
      </ErrorBoundary>
      <ErrorBoundary componentName="FileSearchDialog" fallback={null}>
        <FileSearchDialog />
      </ErrorBoundary>
      <GlobalProjectSettings />
    </div>
  )
}
