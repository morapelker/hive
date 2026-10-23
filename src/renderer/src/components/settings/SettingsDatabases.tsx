// Settings › Databases: defaults for new database connections (data projects). Stored under the
// dedicated `data_projects_defaults` setting, not the app_settings blob (paired phones can write
// that blob, and these values decide how strictly new connections guard writes). The add wizard
// reads them; existing connections keep their own settings.

import { useEffect, useState } from 'react'
import { Loader2 } from 'lucide-react'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { cn } from '@/lib/utils'
import { useDataProjectStore } from '@/stores/useDataProjectStore'
import {
  DATA_ENVIRONMENT_DEFAULTS,
  DATA_HARD_ROW_CAP,
  type DataEnvironment,
  type DataSafeMode
} from '@shared/data-projects/types'
import {
  ENVIRONMENT_ORDER,
  SAFE_MODE_INFO,
  SAFE_MODE_ORDER
} from '@/components/data-projects/data-project-ui'

const MAX_TIMEOUT_SECONDS = 86_400

export function SettingsDatabases(): React.JSX.Element {
  const defaults = useDataProjectStore((s) => s.defaults)
  const defaultsLoaded = useDataProjectStore((s) => s.defaultsLoaded)
  const saveDefaults = useDataProjectStore((s) => s.saveDefaults)
  const [limitText, setLimitText] = useState(String(defaults.defaultLimit))
  const [timeoutText, setTimeoutText] = useState(
    defaults.queryTimeoutMs > 0 ? String(Math.round(defaults.queryTimeoutMs / 1000)) : ''
  )

  useEffect(() => {
    void useDataProjectStore.getState().loadDefaults()
  }, [])

  // Re-sync the text inputs when the stored values arrive / change.
  useEffect(() => {
    setLimitText(String(defaults.defaultLimit))
    setTimeoutText(
      defaults.queryTimeoutMs > 0 ? String(Math.round(defaults.queryTimeoutMs / 1000)) : ''
    )
  }, [defaults.defaultLimit, defaults.queryTimeoutMs])

  const limitValue = Number(limitText)
  const limitInvalid =
    limitText.trim() === '' ||
    !Number.isInteger(limitValue) ||
    limitValue < 0 ||
    limitValue > DATA_HARD_ROW_CAP
  const timeoutValue = timeoutText.trim() === '' ? 0 : Number(timeoutText)
  const timeoutInvalid =
    !Number.isInteger(timeoutValue) || timeoutValue < 0 || timeoutValue > MAX_TIMEOUT_SECONDS

  const envSafeMode = DATA_ENVIRONMENT_DEFAULTS[defaults.environment].safeMode

  return (
    <div className="space-y-6" data-testid="settings-databases">
      <div>
        <h3 className="text-base font-medium mb-1">Databases</h3>
        <p className="text-sm text-muted-foreground">
          Defaults for new database connections. Each connection can change them later in its own
          settings.
        </p>
      </div>

      {!defaultsLoaded && (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />
          Loading…
        </div>
      )}

      <section className="space-y-2">
        <label className="text-sm font-medium">Environment</label>
        <p className="text-xs text-muted-foreground">
          New connections to localhost and SQLite files are always tagged Local.
        </p>
        <div
          className="grid grid-cols-4 gap-1.5"
          role="radiogroup"
          aria-label="Default environment"
        >
          {ENVIRONMENT_ORDER.map((environment: DataEnvironment) => {
            const info = DATA_ENVIRONMENT_DEFAULTS[environment]
            const active = defaults.environment === environment
            return (
              <button
                key={environment}
                type="button"
                role="radio"
                aria-checked={active}
                onClick={() => void saveDefaults({ environment })}
                className={cn(
                  'flex items-center justify-center gap-1.5 rounded-md border px-2 py-1.5 text-[12px] font-medium transition-colors',
                  active ? 'bg-accent' : 'border-border hover:bg-accent/50'
                )}
                style={active ? { borderColor: info.color } : undefined}
                data-testid={`settings-databases-environment-${environment}`}
              >
                <span className="size-2 rounded-full" style={{ backgroundColor: info.color }} />
                {info.label}
              </button>
            )
          })}
        </div>
      </section>

      <section className="space-y-2">
        <label className="text-sm font-medium">Safe mode</label>
        <p className="text-xs text-muted-foreground">
          Staging and production never start below their own default (half-safe).
        </p>
        <div className="flex flex-col gap-1" role="radiogroup" aria-label="Default safe mode">
          {(['auto', ...SAFE_MODE_ORDER] as Array<DataSafeMode | 'auto'>).map((mode) => {
            const active = defaults.safeMode === mode
            const label =
              mode === 'auto'
                ? `Follow the environment (${SAFE_MODE_INFO[envSafeMode].label.toLowerCase()} for ${DATA_ENVIRONMENT_DEFAULTS[defaults.environment].label.toLowerCase()})`
                : SAFE_MODE_INFO[mode].label
            const description =
              mode === 'auto'
                ? 'Local and development: off. Staging and production: half-safe.'
                : SAFE_MODE_INFO[mode].description
            return (
              <button
                key={mode}
                type="button"
                role="radio"
                aria-checked={active}
                onClick={() => void saveDefaults({ safeMode: mode })}
                className={cn(
                  'flex flex-col items-start rounded-md border px-3 py-2 text-left transition-colors',
                  active ? 'border-ring bg-accent' : 'border-transparent hover:bg-accent/50'
                )}
                data-testid={`settings-databases-safe-mode-${mode}`}
              >
                <span
                  className={cn(
                    'text-[13px] font-medium',
                    mode !== 'auto' && SAFE_MODE_INFO[mode].tone
                  )}
                >
                  {label}
                </span>
                <span className="text-[12px] text-muted-foreground">{description}</span>
              </button>
            )
          })}
        </div>
      </section>

      <section className="grid grid-cols-2 gap-4">
        <div className="space-y-1.5">
          <label htmlFor="settings-databases-limit" className="text-sm font-medium">
            Default row limit
          </label>
          <Input
            id="settings-databases-limit"
            value={limitText}
            inputMode="numeric"
            onChange={(e) => setLimitText(e.target.value.replace(/[^\d]/g, ''))}
            onBlur={() => {
              if (!limitInvalid && limitValue !== defaults.defaultLimit) {
                void saveDefaults({ defaultLimit: limitValue })
              }
            }}
            aria-invalid={limitInvalid || undefined}
            data-testid="settings-databases-limit"
          />
          <p className={cn('text-xs', limitInvalid ? 'text-destructive' : 'text-muted-foreground')}>
            {limitInvalid
              ? `0 (no limit) to ${DATA_HARD_ROW_CAP.toLocaleString('en-US')}`
              : 'Query results stop after this many rows; 0 = no limit.'}
          </p>
        </div>
        <div className="space-y-1.5">
          <label htmlFor="settings-databases-timeout" className="text-sm font-medium">
            Query timeout (seconds)
          </label>
          <Input
            id="settings-databases-timeout"
            value={timeoutText}
            inputMode="numeric"
            placeholder="0"
            onChange={(e) => setTimeoutText(e.target.value.replace(/[^\d]/g, ''))}
            onBlur={() => {
              const ms = timeoutValue * 1000
              if (!timeoutInvalid && ms !== defaults.queryTimeoutMs) {
                void saveDefaults({ queryTimeoutMs: ms })
              }
            }}
            aria-invalid={timeoutInvalid || undefined}
            data-testid="settings-databases-timeout"
          />
          <p
            className={cn('text-xs', timeoutInvalid ? 'text-destructive' : 'text-muted-foreground')}
          >
            {timeoutInvalid ? `0 to ${MAX_TIMEOUT_SECONDS}` : 'Empty or 0 = no timeout.'}
          </p>
        </div>
      </section>

      <section className="flex items-start justify-between gap-4">
        <div>
          <label className="text-sm font-medium">Let the AI assistant read sample rows</label>
          <p className="text-xs text-muted-foreground">
            Off: the assistant sees only table and column names. On: it may read a few rows of new
            connections, which are sent to your AI provider.
          </p>
        </div>
        <Switch
          checked={defaults.allowAiDataAccess}
          onCheckedChange={(checked) => void saveDefaults({ allowAiDataAccess: checked })}
          data-testid="settings-databases-ai-data-access"
        />
      </section>
    </div>
  )
}
