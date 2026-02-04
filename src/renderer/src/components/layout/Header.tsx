import { Moon, Sun, Monitor, PanelRightClose, PanelRightOpen } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useThemeStore } from '@/stores/useThemeStore'
import { useLayoutStore } from '@/stores/useLayoutStore'
import { toast } from 'sonner'

export function Header(): React.JSX.Element {
  const { theme, cycleTheme } = useThemeStore()
  const { rightSidebarCollapsed, toggleRightSidebar } = useLayoutStore()

  const getThemeIcon = (): React.JSX.Element => {
    switch (theme) {
      case 'dark':
        return <Moon className="h-4 w-4" />
      case 'light':
        return <Sun className="h-4 w-4" />
      case 'system':
        return <Monitor className="h-4 w-4" />
    }
  }

  const handleThemeToggle = (): void => {
    cycleTheme()
    const themes = ['dark', 'light', 'system']
    const currentIndex = themes.indexOf(theme)
    const nextTheme = themes[(currentIndex + 1) % themes.length]
    toast.success(`Theme changed to ${nextTheme}`)
  }

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
          onClick={handleThemeToggle}
          variant="ghost"
          size="icon"
          title={`Current theme: ${theme}`}
          data-testid="theme-toggle"
        >
          {getThemeIcon()}
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
