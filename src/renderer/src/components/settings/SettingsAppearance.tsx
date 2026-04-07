import { THEME_PRESETS, ThemePreset } from '@/lib/themes'
import { useThemeStore } from '@/stores/useThemeStore'
import { cn } from '@/lib/utils'
import { Check } from 'lucide-react'

interface ThemeCardProps {
  preset: ThemePreset
  isActive: boolean
  onSelect: (id: string) => void
  onMouseEnter: (id: string) => void
  onMouseLeave: () => void
}

function ThemeCard({
  preset,
  isActive,
  onSelect,
  onMouseEnter,
  onMouseLeave
}: ThemeCardProps): React.JSX.Element {
  const { background, sidebar, primary, 'muted-foreground': mutedFg } = preset.previewColors

  return (
    <button
      onClick={() => onSelect(preset.id)}
      onMouseEnter={() => onMouseEnter(preset.id)}
      onMouseLeave={onMouseLeave}
      className={cn(
        'group relative flex flex-col gap-2 rounded-lg border p-2 text-left transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        isActive
          ? 'border-primary ring-2 ring-primary/30 bg-primary/5'
          : 'border-border hover:border-muted-foreground/40'
      )}
      aria-pressed={isActive}
      data-testid={`theme-card-${preset.id}`}
    >
      {/* Preview swatch */}
      <div
        className="relative h-16 w-full overflow-hidden rounded-md"
        style={{ backgroundColor: background }}
      >
        {/* Sidebar stripe — left edge */}
        <div
          className="absolute inset-y-0 left-0 w-[22%]"
          style={{ backgroundColor: sidebar }}
        />

        {/* Simulated text lines in main area */}
        <div className="absolute inset-y-0 left-[26%] right-0 flex flex-col justify-center gap-[4px] pr-2">
          <div
            className="h-[5px] w-3/4 rounded-full opacity-40"
            style={{ backgroundColor: mutedFg }}
          />
          <div
            className="h-[5px] w-1/2 rounded-full opacity-25"
            style={{ backgroundColor: mutedFg }}
          />
        </div>

        {/* Primary accent dot — bottom-right of main area */}
        <div
          className="absolute bottom-2 right-2 h-[10px] w-[10px] rounded-full"
          style={{ backgroundColor: primary }}
        />

        {/* Active check badge */}
        {isActive && (
          <div className="absolute right-1.5 top-1.5 flex h-5 w-5 items-center justify-center rounded-full bg-primary text-primary-foreground shadow-sm">
            <Check className="h-3 w-3" />
          </div>
        )}
      </div>

      {/* Preset name */}
      <span
        className={cn(
          'truncate text-center text-xs font-medium leading-none',
          isActive ? 'text-primary' : 'text-muted-foreground group-hover:text-foreground'
        )}
      >
        {preset.name}
      </span>
    </button>
  )
}

export function SettingsAppearance(): React.JSX.Element {
  const themeId = useThemeStore((s) => s.themeId)
  const setTheme = useThemeStore((s) => s.setTheme)
  const previewTheme = useThemeStore((s) => s.previewTheme)
  const cancelPreview = useThemeStore((s) => s.cancelPreview)

  const darkPresets = THEME_PRESETS.filter((p) => p.type === 'dark')
  const lightPresets = THEME_PRESETS.filter((p) => p.type === 'light')

  return (
    <div className="space-y-6" data-testid="settings-appearance">
      <div>
        <h2 className="text-lg font-semibold mb-1">Appearance</h2>
        <p className="text-sm text-muted-foreground">
          Choose a theme preset. Hover to preview before selecting.
        </p>
      </div>

      {/* Dark themes */}
      <section className="space-y-2">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          Dark Themes
        </h3>
        <div className="grid grid-cols-3 gap-3" data-testid="dark-themes-grid">
          {darkPresets.map((preset) => (
            <ThemeCard
              key={preset.id}
              preset={preset}
              isActive={themeId === preset.id}
              onSelect={setTheme}
              onMouseEnter={previewTheme}
              onMouseLeave={cancelPreview}
            />
          ))}
        </div>
      </section>

      {/* Light themes */}
      <section className="space-y-2">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          Light Themes
        </h3>
        <div className="grid grid-cols-3 gap-3" data-testid="light-themes-grid">
          {lightPresets.map((preset) => (
            <ThemeCard
              key={preset.id}
              preset={preset}
              isActive={themeId === preset.id}
              onSelect={setTheme}
              onMouseEnter={previewTheme}
              onMouseLeave={cancelPreview}
            />
          ))}
        </div>
      </section>
    </div>
  )
}
