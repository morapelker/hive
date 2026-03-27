import { useCallback, useEffect, useMemo } from 'react'
import { Header } from './Header'
import { LeftSidebar } from './LeftSidebar'
import { MainPane } from './MainPane'
import { RightSidebar } from './RightSidebar'
import { Toaster } from '@/components/ui/sonner'
import { SessionHistory } from '@/components/sessions/SessionHistory'
import { CommandPalette } from '@/components/command-palette'
import { SettingsModal } from '@/components/settings'
import { AgentSetupGuard } from '@/components/setup'
import { HelpOverlay } from '@/components/ui/HelpOverlay'
import { FileSearchDialog } from '@/components/file-search'
import { useKeyboardShortcuts } from '@/hooks/useKeyboardShortcuts'
import { useVimNavigation } from '@/hooks/useVimNavigation'
import { useOpenCodeGlobalListener } from '@/hooks/useOpenCodeGlobalListener'
import { useNotificationNavigation } from '@/hooks/useNotificationNavigation'
import { useWindowFocusRefresh } from '@/hooks/useWindowFocusRefresh'
import { useWorktreeWatcher } from '@/hooks/useWorktreeWatcher'
import { useConnectionWatcher } from '@/hooks/useConnectionWatcher'
import { useAutoUpdate } from '@/hooks/useAutoUpdate'
import { ErrorBoundary, ErrorFallback } from '@/components/error'
import { ProjectSettingsDialog } from '@/components/projects/ProjectSettingsDialog'
import { useProjectStore } from '@/stores/useProjectStore'
import { useWorktreeStore } from '@/stores/useWorktreeStore'
import { useGitStore } from '@/stores/useGitStore'
import { useSessionStore } from '@/stores/useSessionStore'
import { useDropZone } from '@/hooks/useDropZone'
import { DropOverlay } from './DropOverlay'
import { toast } from '@/lib/toast'
import { useDropAttachmentStore } from '@/stores'
import { MAX_ATTACHMENTS, isImageMime } from '@/lib/file-attachment-utils'
import type { Attachment } from '@/components/sessions/AttachmentPreview'

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
  // Vim-style modal navigation (hjkl, panel shortcuts, file tab cycling)
  useVimNavigation()
  // Global listener for background session events (AI finishes while viewing another project)
  useOpenCodeGlobalListener()
  // Navigate to session when native notification is clicked
  useNotificationNavigation()
  // Refresh git statuses when window regains focus
  useWindowFocusRefresh()
  // Watch active worktree for filesystem + .git changes (main-process watcher)
  useWorktreeWatcher()
  // Watch connection member worktrees for filesystem + .git changes
  useConnectionWatcher()
  // Auto-update notifications
  useAutoUpdate()

  // Drag-and-drop from Finder
  const activeSessionId = useSessionStore((s) => s.activeSessionId)

  const handleFileDrop = useCallback((files: FileList) => {
    const sessionId = useSessionStore.getState().activeSessionId
    if (!sessionId) {
      toast.warning('Open a session to attach files')
      return
    }

    const allFiles = Array.from(files)

    // Filter out directories (in Electron, directories have type '' and size 0)
    const validFiles = allFiles.filter((f) => {
      if (f.type === '' && f.size === 0) {
        return false
      }
      return true
    })

    if (validFiles.length < allFiles.length) {
      toast.warning('Folders cannot be attached. Drop individual files instead.')
    }

    if (validFiles.length === 0) return

    // Truncate to max
    const filesToProcess =
      validFiles.length > MAX_ATTACHMENTS
        ? (toast.warning(`Maximum ${MAX_ATTACHMENTS} files per drop`),
          validFiles.slice(0, MAX_ATTACHMENTS))
        : validFiles

    // Process files
    const promises = filesToProcess.map((file) => {
      if (isImageMime(file.type)) {
        return new Promise<Omit<Attachment, 'id'>>((resolve, reject) => {
          const reader = new FileReader()
          reader.onload = () => {
            resolve({
              kind: 'data' as const,
              name: file.name,
              mime: file.type,
              dataUrl: reader.result as string
            })
          }
          reader.onerror = () => {
            reject(new Error(`Failed to read file: ${file.name}`))
          }
          reader.readAsDataURL(file)
        })
      }
      return Promise.resolve({
        kind: 'path' as const,
        name: file.name,
        mime: file.type || 'application/octet-stream',
        filePath: window.fileOps.getPathForFile(file)
      } as Omit<Attachment, 'id'>)
    })

    Promise.all(promises)
      .then((items) => {
        useDropAttachmentStore.getState().push(items)
      })
      .catch((err) => {
        console.error('Failed to process dropped files:', err)
        toast.error('Failed to read one or more dropped files')
      })
  }, [])

  const { isDragging } = useDropZone({ onDrop: handleFileDrop })

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
      {isDragging && <DropOverlay variant={activeSessionId ? 'normal' : 'warning'} />}
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
      <AgentSetupGuard />
      <HelpOverlay />
    </div>
  )
}
