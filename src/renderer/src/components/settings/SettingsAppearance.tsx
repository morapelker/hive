import { Check } from 'lucide-react'
import { THEME_PRESETS, type ThemePreset } from '@/lib/themes'
import { useThemeStore } from '@/stores/useThemeStore'
import { cn } from '@/lib/utils'

function ThemeCard({
  preset,
  isActive
}: {
  preset: ThemePreset
  isActive: boolean
}): React.JSX.Element {
  const setTheme = useThemeStore((s) => s.setTheme)

  return (
    <button
      onClick={() => setTheme(preset.id)}
      className={cn(
        'group relative flex flex-col items-center gap-2 rounded-lg border p-3 transition-all',
        isActive
          ? 'border-primary ring-2 ring-primary/30'
          : 'border-border hover:border-muted-foreground/40'
      )}
      data-testid={`theme-card-${preset.id}`}
    >
      {/* Preview swatch */}
      <div
        className="w-full h-16 rounded-md overflow-hidden border border-border/50"
        style={{ backgroundColor: preset.colors.background }}
      >
        <div className="flex h-full">
          {/* Sidebar preview */}
          <div className="w-1/4 h-full" style={{ backgroundColor: preset.colors.sidebar }} />
          {/* Main area preview */}
          <div className="flex-1 flex flex-col items-center justify-center gap-1 px-2">
            <div
              className="w-full h-2 rounded-full"
              style={{ backgroundColor: preset.colors.primary }}
            />
            <div
              className="w-3/4 h-1.5 rounded-full opacity-50"
              style={{ backgroundColor: preset.colors['muted-foreground'] }}
            />
            <div
              className="w-1/2 h-1.5 rounded-full opacity-30"
              style={{ backgroundColor: preset.colors['muted-foreground'] }}
            />
          </div>
        </div>
      </div>

      {/* Theme name */}
      <span className="text-xs font-medium text-foreground">{preset.name}</span>

      {/* Active checkmark */}
      {isActive && (
        <div className="absolute top-1.5 right-1.5 h-4 w-4 rounded-full bg-primary flex items-center justify-center">
          <Check className="h-2.5 w-2.5 text-primary-foreground" />
        </div>
      )}
    </button>
  )
}

export function SettingsAppearance(): React.JSX.Element {
  const themeId = useThemeStore((s) => s.themeId)

  const darkThemes = THEME_PRESETS.filter((p) => p.type === 'dark')
  const lightThemes = THEME_PRESETS.filter((p) => p.type === 'light')

  return (
    <div className="space-y-6" data-testid="settings-appearance">
      <div>
        <h2 className="text-lg font-semibold mb-1">Appearance</h2>
        <p className="text-sm text-muted-foreground">Choose a theme for the application.</p>
      </div>

      {/* Dark Themes */}
      <div>
        <h3
          className="text-sm font-medium text-muted-foreground mb-3"
          data-testid="dark-themes-header"
        >
          Dark Themes
        </h3>
        <div className="grid grid-cols-3 gap-3" data-testid="dark-themes-grid">
          {darkThemes.map((preset) => (
            <ThemeCard key={preset.id} preset={preset} isActive={themeId === preset.id} />
          ))}
        </div>
      </div>

      {/* Light Themes */}
      <div>
        <h3
          className="text-sm font-medium text-muted-foreground mb-3"
          data-testid="light-themes-header"
        >
          Light Themes
        </h3>
        <div className="grid grid-cols-3 gap-3" data-testid="light-themes-grid">
          {lightThemes.map((preset) => (
            <ThemeCard key={preset.id} preset={preset} isActive={themeId === preset.id} />
          ))}
        </div>
      </div>
    </div>
  )
}
