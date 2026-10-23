// Wizard step 4: what the connection is called and how carefully it is handled. Name (suggested
// from database @ host until typed), icon + tint, environment (colour-coded; picking one moves
// the safe mode to that environment's default unless the user chose a mode), safe mode with an
// explanation per level, auto-limit, statement timeout, AI sample-row access (off by default:
// rows leave the machine) and "pin to sidebar".

import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { cn } from '@/lib/utils'
import {
  DATA_ENVIRONMENT_DEFAULTS,
  type DataEnvironment,
  type DataSafeMode
} from '@shared/data-projects/types'
import type { DataProjectDefaults } from '@/stores/useDataProjectStore'
import {
  ENVIRONMENT_ORDER,
  SAFE_MODE_INFO,
  SAFE_MODE_ORDER,
  isLessStrictSafeMode
} from '../data-project-ui'
import { IconPicker } from './IconPicker'
import { Field, SectionTitle, invalidProps } from './wizard-fields'
import { chooseEnvironment, suggestName, type FieldErrors, type WizardForm } from './wizard-model'

export interface DetailsStepProps {
  form: WizardForm
  onChange: (updater: (form: WizardForm) => WizardForm) => void
  errors: FieldErrors
  defaults: DataProjectDefaults
  imageKey: string
  onImageUploaded?: (fileName: string) => void
}

export function DetailsStep({
  form,
  onChange,
  errors,
  defaults,
  imageKey,
  onImageUploaded
}: DetailsStepProps): React.JSX.Element {
  const suggestion = suggestName(form)
  const envDefault = DATA_ENVIRONMENT_DEFAULTS[form.environment].safeMode

  return (
    <div className="flex flex-col gap-5" data-testid="data-project-wizard-details-step">
      <Field label="Name" htmlFor="data-project-wizard-name" error={errors.name}>
        <Input
          id="data-project-wizard-name"
          value={form.name}
          placeholder={suggestion}
          onChange={(e) => {
            const value = e.target.value
            onChange((f) => ({ ...f, name: value, nameEdited: value.trim().length > 0 }))
          }}
          autoComplete="off"
          data-testid="data-project-wizard-name"
          {...invalidProps('data-project-wizard-name', errors.name)}
        />
      </Field>

      <div className="flex flex-col gap-2">
        <SectionTitle>Icon</SectionTitle>
        <IconPicker
          engine={form.engine}
          icon={form.icon}
          iconColor={form.iconColor}
          onChange={(icon, iconColor) => onChange((f) => ({ ...f, icon, iconColor }))}
          imageKey={imageKey}
          onImageUploaded={onImageUploaded}
        />
      </div>

      <div className="flex flex-col gap-2">
        <SectionTitle>Environment</SectionTitle>
        <div className="grid grid-cols-4 gap-1.5" role="radiogroup" aria-label="Environment">
          {ENVIRONMENT_ORDER.map((environment: DataEnvironment) => {
            const info = DATA_ENVIRONMENT_DEFAULTS[environment]
            const active = form.environment === environment
            return (
              <button
                key={environment}
                type="button"
                role="radio"
                aria-checked={active}
                onClick={() => onChange((f) => chooseEnvironment(f, environment, defaults))}
                className={cn(
                  'flex items-center justify-center gap-1.5 rounded-md border px-2 py-1.5 text-[12px] font-medium transition-colors',
                  active ? 'bg-accent' : 'border-border hover:bg-accent/50'
                )}
                style={active ? { borderColor: info.color } : undefined}
                data-testid={`data-project-wizard-environment-${environment}`}
              >
                <span className="size-2 rounded-full" style={{ backgroundColor: info.color }} />
                {info.label}
              </button>
            )
          })}
        </div>
        {form.environment === 'production' && (
          <p className="text-[11px] text-muted-foreground">
            Production connections get a red bar, a badge, and typed confirmation for DROP, TRUNCATE
            and DELETE without WHERE.
          </p>
        )}
      </div>

      <div className="flex flex-col gap-2">
        <SectionTitle>Safe mode</SectionTitle>
        <div className="flex flex-col gap-1" role="radiogroup" aria-label="Safe mode">
          {SAFE_MODE_ORDER.map((mode: DataSafeMode) => {
            const info = SAFE_MODE_INFO[mode]
            const active = form.safeMode === mode
            const belowDefault = isLessStrictSafeMode(envDefault, mode)
            return (
              <button
                key={mode}
                type="button"
                role="radio"
                aria-checked={active}
                onClick={() => onChange((f) => ({ ...f, safeMode: mode, safeModeEdited: true }))}
                className={cn(
                  'flex items-start gap-2.5 rounded-md border px-3 py-2 text-left transition-colors',
                  active ? 'border-ring bg-accent' : 'border-transparent hover:bg-accent/50'
                )}
                data-testid={`data-project-wizard-safe-mode-${mode}`}
              >
                <span
                  className={cn(
                    'mt-1 inline-flex size-3 shrink-0 items-center justify-center rounded-full border',
                    active ? 'border-ring' : 'border-muted-foreground/50'
                  )}
                >
                  {active && <span className={cn('size-1.5 rounded-full', info.dot)} />}
                </span>
                <span className="flex min-w-0 flex-col">
                  <span className={cn('text-[13px] font-medium', info.tone)}>
                    {info.label}
                    {mode === envDefault && (
                      <span className="ml-1.5 text-[11px] font-normal text-muted-foreground">
                        default for{' '}
                        {DATA_ENVIRONMENT_DEFAULTS[form.environment].label.toLowerCase()}
                      </span>
                    )}
                  </span>
                  <span className="text-[12px] text-muted-foreground">{info.description}</span>
                  {active && belowDefault && form.environment === 'production' && (
                    <span className="mt-0.5 text-[11px] text-destructive">
                      Less strict than recommended for production.
                    </span>
                  )}
                </span>
              </button>
            )
          })}
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <Field
          label="Default row limit"
          htmlFor="data-project-wizard-default-limit"
          error={errors.defaultLimit}
          hint="Results stop after this many rows; 0 = no limit."
        >
          <Input
            id="data-project-wizard-default-limit"
            value={form.defaultLimit}
            onChange={(e) =>
              onChange((f) => ({ ...f, defaultLimit: e.target.value.replace(/[^\d]/g, '') }))
            }
            inputMode="numeric"
            data-testid="data-project-wizard-default-limit"
            {...invalidProps('data-project-wizard-default-limit', errors.defaultLimit)}
          />
        </Field>
        <Field
          label="Query timeout (seconds)"
          htmlFor="data-project-wizard-query-timeout"
          error={errors.queryTimeoutSec}
          hint="Empty or 0 = none."
        >
          <Input
            id="data-project-wizard-query-timeout"
            value={form.queryTimeoutSec}
            onChange={(e) =>
              onChange((f) => ({ ...f, queryTimeoutSec: e.target.value.replace(/[^\d]/g, '') }))
            }
            inputMode="numeric"
            placeholder="0"
            data-testid="data-project-wizard-query-timeout"
            {...invalidProps('data-project-wizard-query-timeout', errors.queryTimeoutSec)}
          />
        </Field>
      </div>

      <div className="flex flex-col gap-3">
        <label className="flex items-start justify-between gap-3">
          <span className="flex flex-col">
            <span className="text-[13px] font-medium">Allow AI assistant to read sample rows</span>
            <span className="text-[12px] text-muted-foreground">
              The assistant always sees table and column names. With this on it may also read a few
              rows, which are sent to your AI provider.
            </span>
          </span>
          <Switch
            checked={form.allowAiDataAccess}
            onCheckedChange={(checked) => onChange((f) => ({ ...f, allowAiDataAccess: checked }))}
            data-testid="data-project-wizard-ai-data-access"
          />
        </label>
        <label className="flex items-center gap-2 text-[13px]">
          <Checkbox
            checked={form.pinned}
            onCheckedChange={(checked) => onChange((f) => ({ ...f, pinned: checked }))}
            data-testid="data-project-wizard-pinned"
          />
          Pin to the sidebar (one click away from the Pinned Board)
        </label>
      </div>
    </div>
  )
}
