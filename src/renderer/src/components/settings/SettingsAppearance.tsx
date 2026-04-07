import { useThemeStore } from '@/stores/useThemeStore'
import { Moon, Sun } from 'lucide-react'
import { cn } from '@/lib/utils'

export function SettingsAppearance(): React.JSX.Element {
  const mode = useThemeStore((s) => s.mode)
  const setMode = useThemeStore((s) => s.setMode)

  return (
    <div className="space-y-6" data-testid="settings-appearance">
      <div>
        <h2 className="text-lg font-semibold mb-1">Appearance</h2>
        <p className="text-sm text-muted-foreground">Choose between dark and light mode.</p>
      </div>

      <div className="flex gap-3" data-testid="theme-mode-toggle">
        <button
          onClick={() => setMode('dark')}
          className={cn(
            'flex items-center gap-2 rounded-lg border px-4 py-3 transition-all',
            mode === 'dark'
              ? 'border-primary ring-2 ring-primary/30 bg-primary/5'
              : 'border-border hover:border-muted-foreground/40'
          )}
          data-testid="theme-mode-dark"
        >
          <Moon className="h-4 w-4" />
          <span className="text-sm font-medium">Dark</span>
        </button>
        <button
          onClick={() => setMode('light')}
          className={cn(
            'flex items-center gap-2 rounded-lg border px-4 py-3 transition-all',
            mode === 'light'
              ? 'border-primary ring-2 ring-primary/30 bg-primary/5'
              : 'border-border hover:border-muted-foreground/40'
          )}
          data-testid="theme-mode-light"
        >
          <Sun className="h-4 w-4" />
          <span className="text-sm font-medium">Light</span>
        </button>
      </div>
    </div>
  )
}
