import { useThemeStore } from '@/stores/useThemeStore'
import { useSettingsStore } from '@/stores/useSettingsStore'
import { RotateCcw } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { useShortcutStore } from '@/stores/useShortcutStore'
import { DEFAULT_THEME_ID } from '@/lib/themes'
import { toast } from '@/lib/toast'

export function SettingsGeneral(): React.JSX.Element {
  const { setTheme } = useThemeStore()
  const { autoStartSession, breedType, showModelIcons, updateSetting, resetToDefaults } =
    useSettingsStore()
  const { resetToDefaults: resetShortcuts } = useShortcutStore()

  const handleResetAll = (): void => {
    resetToDefaults()
    resetShortcuts()
    setTheme(DEFAULT_THEME_ID)
    toast.success('All settings reset to defaults')
  }

  return (
    <div className="space-y-6">
      <div>
        <h3 className="text-base font-medium mb-1">General</h3>
        <p className="text-sm text-muted-foreground">Basic application settings</p>
      </div>

      {/* Auto-start session */}
      <div className="flex items-center justify-between">
        <div>
          <label className="text-sm font-medium">Auto-start session</label>
          <p className="text-xs text-muted-foreground">
            Automatically create a session when selecting a worktree with none
          </p>
        </div>
        <button
          role="switch"
          aria-checked={autoStartSession}
          onClick={() => updateSetting('autoStartSession', !autoStartSession)}
          className={cn(
            'relative inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors',
            autoStartSession ? 'bg-primary' : 'bg-muted'
          )}
          data-testid="auto-start-session-toggle"
        >
          <span
            className={cn(
              'pointer-events-none block h-4 w-4 rounded-full bg-background shadow-lg ring-0 transition-transform',
              autoStartSession ? 'translate-x-4' : 'translate-x-0'
            )}
          />
        </button>
      </div>

      {/* Model icons */}
      <div className="flex items-center justify-between">
        <div>
          <label className="text-sm font-medium">Model icons</label>
          <p className="text-xs text-muted-foreground">
            Show the model icon (Claude, OpenAI) next to the worktree status
          </p>
        </div>
        <button
          role="switch"
          aria-checked={showModelIcons}
          onClick={() => updateSetting('showModelIcons', !showModelIcons)}
          className={cn(
            'relative inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors',
            showModelIcons ? 'bg-primary' : 'bg-muted'
          )}
          data-testid="show-model-icons-toggle"
        >
          <span
            className={cn(
              'pointer-events-none block h-4 w-4 rounded-full bg-background shadow-lg ring-0 transition-transform',
              showModelIcons ? 'translate-x-4' : 'translate-x-0'
            )}
          />
        </button>
      </div>

      {/* Branch naming */}
      <div className="space-y-2">
        <label className="text-sm font-medium">Branch Naming</label>
        <p className="text-xs text-muted-foreground">
          Choose the naming theme for auto-generated worktree branches
        </p>
        <div className="flex gap-2">
          <button
            onClick={() => updateSetting('breedType', 'dogs')}
            className={cn(
              'px-3 py-1.5 rounded-md text-sm border transition-colors',
              breedType === 'dogs'
                ? 'bg-primary text-primary-foreground border-primary'
                : 'bg-muted/50 text-muted-foreground border-border hover:bg-accent/50'
            )}
            data-testid="breed-type-dogs"
          >
            Dogs
          </button>
          <button
            onClick={() => updateSetting('breedType', 'cats')}
            className={cn(
              'px-3 py-1.5 rounded-md text-sm border transition-colors',
              breedType === 'cats'
                ? 'bg-primary text-primary-foreground border-primary'
                : 'bg-muted/50 text-muted-foreground border-border hover:bg-accent/50'
            )}
            data-testid="breed-type-cats"
          >
            Cats
          </button>
        </div>
      </div>

      {/* Reset to defaults */}
      <div className="pt-4 border-t">
        <Button
          variant="outline"
          size="sm"
          onClick={handleResetAll}
          className="text-destructive hover:text-destructive"
          data-testid="reset-all-settings"
        >
          <RotateCcw className="h-3.5 w-3.5 mr-1.5" />
          Reset All to Defaults
        </Button>
        <p className="text-xs text-muted-foreground mt-1">
          This will reset all settings, theme, and keyboard shortcuts to their defaults.
        </p>
      </div>
    </div>
  )
}
