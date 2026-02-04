import { Header } from './Header'
import { LeftSidebar } from './LeftSidebar'
import { MainPane } from './MainPane'
import { RightSidebar } from './RightSidebar'
import { Toaster } from '@/components/ui/sonner'

interface AppLayoutProps {
  children?: React.ReactNode
}

export function AppLayout({ children }: AppLayoutProps): React.JSX.Element {
  return (
    <div className="h-screen flex flex-col bg-background text-foreground" data-testid="app-layout">
      <Header />
      <div className="flex-1 flex min-h-0" data-testid="layout-content">
        <LeftSidebar />
        <MainPane>{children}</MainPane>
        <RightSidebar />
      </div>
      <Toaster />
    </div>
  )
}
