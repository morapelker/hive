import { useState, useEffect } from 'react'
import { useSettingsStore } from '@/stores/useSettingsStore'
import { cn } from '@/lib/utils'
import { useI18n } from '@/i18n/useI18n'

export function SettingsPrivacy(): React.JSX.Element {
  const updateSetting = useSettingsStore((s) => s.updateSetting)
  const [enabled, setEnabled] = useState(true)
  const [loaded, setLoaded] = useState(false)
  const { t } = useI18n()

  useEffect(() => {
    window.analyticsOps
      .isEnabled()
      .then((val) => {
        setEnabled(val)
        setLoaded(true)
      })
      .catch(() => {
        setLoaded(true) // Fall back to default (enabled=true)
      })
  }, [])

  const handleToggle = () => {
    const newValue = !enabled
    setEnabled(newValue)
    updateSetting('telemetryEnabled', newValue)
    window.analyticsOps.setEnabled(newValue)
  }

  if (!loaded) return <div />

  return (
    <div className="space-y-6">
      {/* Section header */}
      <div>
        <h3 className="text-base font-medium mb-1">{t('settings.privacy.title')}</h3>
        <p className="text-sm text-muted-foreground">{t('settings.privacy.description')}</p>
      </div>

      {/* Toggle */}
      <div className="flex items-center justify-between">
        <div>
          <label className="text-sm font-medium">{t('settings.privacy.analytics.label')}</label>
          <p className="text-xs text-muted-foreground mt-0.5">
            {t('settings.privacy.analytics.description')}
          </p>
        </div>
        <button
          role="switch"
          aria-checked={enabled}
          onClick={handleToggle}
          className={cn(
            'relative inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors',
            enabled ? 'bg-primary' : 'bg-muted'
          )}
        >
          <span
            className={cn(
              'pointer-events-none block h-4 w-4 rounded-full bg-background shadow-lg ring-0 transition-transform',
              enabled ? 'translate-x-4' : 'translate-x-0'
            )}
          />
        </button>
      </div>

      {/* Info box */}
      <div className="rounded-md border border-border bg-muted/30 p-3">
        <p className="text-xs text-muted-foreground">
          <span className="font-medium text-foreground">{t('settings.privacy.collect.title')}</span>{' '}
          {t('settings.privacy.collect.description')}
        </p>
        <p className="text-xs text-muted-foreground mt-2">
          <span className="font-medium text-foreground">
            {t('settings.privacy.neverCollect.title')}
          </span>{' '}
          {t('settings.privacy.neverCollect.description')}
        </p>
      </div>
    </div>
  )
}
