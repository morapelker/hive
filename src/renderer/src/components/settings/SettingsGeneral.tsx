import { useThemeStore } from '@/stores/useThemeStore'
import { useSettingsStore } from '@/stores/useSettingsStore'
import { RotateCcw } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { useShortcutStore } from '@/stores/useShortcutStore'
import { DEFAULT_THEME_ID } from '@/lib/themes'
import { toast } from '@/lib/toast'
import { DEFAULT_LOCALE } from '@/i18n/messages'
import { useI18n } from '@/i18n/useI18n'

export function SettingsGeneral(): React.JSX.Element {
  const { setTheme } = useThemeStore()
  const {
    locale,
    autoStartSession,
    vimModeEnabled,
    breedType,
    showModelIcons,
    showModelProvider,
    showUsageIndicator,
    defaultAgentSdk,
    stripAtMentions,
    updateSetting,
    resetToDefaults
  } = useSettingsStore()
  const { resetToDefaults: resetShortcuts } = useShortcutStore()
  const { t } = useI18n()

  const handleResetAll = (): void => {
    resetToDefaults()
    resetShortcuts()
    setTheme(DEFAULT_THEME_ID)
    toast.success(t('settings.general.resetAll.success'))
  }

  return (
    <div className="space-y-6">
      <div>
        <h3 className="text-base font-medium mb-1">{t('settings.general.title')}</h3>
        <p className="text-sm text-muted-foreground">{t('settings.general.description')}</p>
      </div>

      {/* Language */}
      <div className="space-y-2">
        <label className="text-sm font-medium" htmlFor="settings-language">
          {t('settings.general.language.label')}
        </label>
        <p className="text-xs text-muted-foreground">
          {t('settings.general.language.description')}
        </p>
        <select
          id="settings-language"
          value={locale ?? DEFAULT_LOCALE}
          onChange={(event) => updateSetting('locale', event.target.value as 'en' | 'zh-CN')}
          className="h-9 min-w-[200px] rounded-md border border-input bg-background px-3 text-sm"
          data-testid="settings-language-select"
        >
          <option value="en">{t('settings.general.language.options.en')}</option>
          <option value="zh-CN">{t('settings.general.language.options.zhCN')}</option>
        </select>
      </div>

      {/* Auto-start session */}
      <div className="flex items-center justify-between">
        <div>
          <label className="text-sm font-medium">
            {t('settings.general.autoStartSession.label')}
          </label>
          <p className="text-xs text-muted-foreground">
            {t('settings.general.autoStartSession.description')}
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

      {/* Vim mode */}
      <div className="flex items-center justify-between">
        <div>
          <label className="text-sm font-medium">{t('settings.general.vimMode.label')}</label>
          <p className="text-xs text-muted-foreground">
            {t('settings.general.vimMode.description')}
          </p>
        </div>
        <button
          role="switch"
          aria-checked={vimModeEnabled}
          onClick={() => updateSetting('vimModeEnabled', !vimModeEnabled)}
          className={cn(
            'relative inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors',
            vimModeEnabled ? 'bg-primary' : 'bg-muted'
          )}
          data-testid="vim-mode-enabled-toggle"
        >
          <span
            className={cn(
              'pointer-events-none block h-4 w-4 rounded-full bg-background shadow-lg ring-0 transition-transform',
              vimModeEnabled ? 'translate-x-4' : 'translate-x-0'
            )}
          />
        </button>
      </div>

      {/* Model icons */}
      <div className="flex items-center justify-between">
        <div>
          <label className="text-sm font-medium">{t('settings.general.modelIcons.label')}</label>
          <p className="text-xs text-muted-foreground">
            {t('settings.general.modelIcons.description')}
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

      {/* Show model provider */}
      <div className="flex items-center justify-between">
        <div>
          <label className="text-sm font-medium">{t('settings.general.modelProvider.label')}</label>
          <p className="text-xs text-muted-foreground">
            {t('settings.general.modelProvider.description')}
          </p>
        </div>
        <button
          role="switch"
          aria-checked={showModelProvider}
          onClick={() => updateSetting('showModelProvider', !showModelProvider)}
          className={cn(
            'relative inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors',
            showModelProvider ? 'bg-primary' : 'bg-muted'
          )}
          data-testid="show-model-provider-toggle"
        >
          <span
            className={cn(
              'pointer-events-none block h-4 w-4 rounded-full bg-background shadow-lg ring-0 transition-transform',
              showModelProvider ? 'translate-x-4' : 'translate-x-0'
            )}
          />
        </button>
      </div>

      {/* Usage indicator */}
      <div className="flex items-center justify-between">
        <div>
          <label className="text-sm font-medium">
            {t('settings.general.usageIndicator.label')}
          </label>
          <p className="text-xs text-muted-foreground">
            {t('settings.general.usageIndicator.description')}
          </p>
        </div>
        <button
          role="switch"
          aria-checked={showUsageIndicator}
          onClick={() => updateSetting('showUsageIndicator', !showUsageIndicator)}
          className={cn(
            'relative inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors',
            showUsageIndicator ? 'bg-primary' : 'bg-muted'
          )}
          data-testid="show-usage-indicator-toggle"
        >
          <span
            className={cn(
              'pointer-events-none block h-4 w-4 rounded-full bg-background shadow-lg ring-0 transition-transform',
              showUsageIndicator ? 'translate-x-4' : 'translate-x-0'
            )}
          />
        </button>
      </div>

      {/* Default Agent SDK */}
      <div className="space-y-2">
        <label className="text-sm font-medium">{t('settings.general.aiProvider.label')}</label>
        <p className="text-xs text-muted-foreground">
          {t('settings.general.aiProvider.description')}
        </p>
        <div className="flex gap-2">
          <button
            onClick={() => updateSetting('defaultAgentSdk', 'opencode')}
            className={cn(
              'px-3 py-1.5 rounded-md text-sm border transition-colors',
              defaultAgentSdk === 'opencode'
                ? 'bg-primary text-primary-foreground border-primary'
                : 'bg-muted/50 text-muted-foreground border-border hover:bg-accent/50'
            )}
            data-testid="agent-sdk-opencode"
          >
            OpenCode
          </button>
          <button
            onClick={() => updateSetting('defaultAgentSdk', 'claude-code')}
            className={cn(
              'px-3 py-1.5 rounded-md text-sm border transition-colors',
              defaultAgentSdk === 'claude-code'
                ? 'bg-primary text-primary-foreground border-primary'
                : 'bg-muted/50 text-muted-foreground border-border hover:bg-accent/50'
            )}
            data-testid="agent-sdk-claude-code"
          >
            Claude Code
          </button>
          <button
            onClick={() => updateSetting('defaultAgentSdk', 'codex')}
            className={cn(
              'px-3 py-1.5 rounded-md text-sm border transition-colors',
              defaultAgentSdk === 'codex'
                ? 'bg-primary text-primary-foreground border-primary'
                : 'bg-muted/50 text-muted-foreground border-border hover:bg-accent/50'
            )}
            data-testid="agent-sdk-codex"
          >
            Codex
          </button>
          <button
            onClick={() => updateSetting('defaultAgentSdk', 'terminal')}
            className={cn(
              'px-3 py-1.5 rounded-md text-sm border transition-colors',
              defaultAgentSdk === 'terminal'
                ? 'bg-primary text-primary-foreground border-primary'
                : 'bg-muted/50 text-muted-foreground border-border hover:bg-accent/50'
            )}
            data-testid="agent-sdk-terminal"
          >
            Terminal
          </button>
        </div>
        {defaultAgentSdk === 'terminal' && (
          <p className="text-xs text-muted-foreground/70 italic">
            {t('settings.general.aiProvider.terminalHint')}
          </p>
        )}
      </div>

      {/* Strip @ from file mentions */}
      <div className="flex items-center justify-between">
        <div>
          <label className="text-sm font-medium">
            {t('settings.general.stripAtMentions.label')}
          </label>
          <p className="text-xs text-muted-foreground">
            {t('settings.general.stripAtMentions.description')}
          </p>
        </div>
        <button
          role="switch"
          aria-checked={stripAtMentions}
          onClick={() => updateSetting('stripAtMentions', !stripAtMentions)}
          className={cn(
            'relative inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors',
            stripAtMentions ? 'bg-primary' : 'bg-muted'
          )}
          data-testid="strip-at-mentions-toggle"
        >
          <span
            className={cn(
              'pointer-events-none block h-4 w-4 rounded-full bg-background shadow-lg ring-0 transition-transform',
              stripAtMentions ? 'translate-x-4' : 'translate-x-0'
            )}
          />
        </button>
      </div>

      {/* Branch naming */}
      <div className="space-y-2">
        <label className="text-sm font-medium">{t('settings.general.branchNaming.label')}</label>
        <p className="text-xs text-muted-foreground">
          {t('settings.general.branchNaming.description')}
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
            {t('settings.general.branchNaming.options.dogs')}
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
            {t('settings.general.branchNaming.options.cats')}
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
          {t('settings.general.resetAll.label')}
        </Button>
        <p className="text-xs text-muted-foreground mt-1">
          {t('settings.general.resetAll.description')}
        </p>
      </div>
    </div>
  )
}
