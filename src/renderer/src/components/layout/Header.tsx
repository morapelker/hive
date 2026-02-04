import { Moon, Sun, Monitor, PanelRightClose, PanelRightOpen, Check } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { useThemeStore, type Theme } from '@/stores/useThemeStore'
import { useLayoutStore } from '@/stores/useLayoutStore'
import { toast } from 'sonner'

const themeOptions: { value: Theme; label: string; icon: typeof Moon }[] = [
  { value: 'light', label: 'Light', icon: Sun },
  { value: 'dark', label: 'Dark', icon: Moon },
  { value: 'system', label: 'System', icon: Monitor }
]

export function Header(): React.JSX.Element {
  const { theme, setTheme } = useThemeStore()
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

  const handleThemeChange = (newTheme: Theme): void => {
    setTheme(newTheme)
    toast.success(`Theme changed to ${newTheme}`)
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
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              title={`Current theme: ${theme}`}
              data-testid="theme-toggle"
            >
              {getThemeIcon()}
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" data-testid="theme-dropdown">
            {themeOptions.map((option) => (
              <DropdownMenuItem
                key={option.value}
                onClick={() => handleThemeChange(option.value)}
                className="flex items-center gap-2"
                data-testid={`theme-option-${option.value}`}
              >
                <option.icon className="h-4 w-4" />
                <span>{option.label}</span>
                {theme === option.value && <Check className="h-4 w-4 ml-auto" />}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
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
