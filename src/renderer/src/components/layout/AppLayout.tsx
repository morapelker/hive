import { Header } from './Header'
import { LeftSidebar } from './LeftSidebar'
import { MainPane } from './MainPane'
import { RightSidebar } from './RightSidebar'
import { Toaster } from '@/components/ui/sonner'
import { SessionHistory } from '@/components/sessions/SessionHistory'
import { useSessionHistoryStore } from '@/stores/useSessionHistoryStore'
import { useCommandK } from '@/hooks'
import { ErrorBoundary, ErrorFallback } from '@/components/error'

interface AppLayoutProps {
  children?: React.ReactNode
}

export function AppLayout({ children }: AppLayoutProps): React.JSX.Element {
  const { togglePanel } = useSessionHistoryStore()

  // Register Cmd/Ctrl+K keyboard shortcut for session history
  useCommandK(togglePanel)

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
    </div>
  )
}
