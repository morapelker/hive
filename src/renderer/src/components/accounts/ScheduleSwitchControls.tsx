import React, { useState } from 'react'
import { Clock, Gauge, Shuffle, X } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Switch } from '@/components/ui/switch'
import { useTimerTickStore } from '@/stores/useTimerTickStore'
import { useUsageStore } from '@/stores/useUsageStore'
import {
  useAccountScheduleStore,
  describeSchedule,
  getActiveUsagePercent,
  type ScheduledSwitch,
  type ScheduleMode
} from '@/stores/useAccountScheduleStore'
import type { UsageProvider } from '@shared/types/usage'

const TIME_PRESETS = [
  { label: '30m', ms: 30 * 60_000 },
  { label: '1h', ms: 60 * 60_000 },
  { label: '2h', ms: 2 * 60 * 60_000 },
  { label: '4h', ms: 4 * 60 * 60_000 }
]

const USAGE_PRESETS = [90, 95, 98]
const DEFAULT_AUTO_SWITCH_THRESHOLD = 90

const presetButtonClass =
  'rounded-sm border border-border/60 px-1.5 py-0.5 text-[9px] font-medium text-muted-foreground transition-colors hover:bg-accent/60 hover:text-foreground'

interface ScheduleSwitchFormProps {
  provider: UsageProvider
  accountId: string
  email: string | null
  onDone?: () => void
  className?: string
}

/**
 * Compact "schedule a switch to this account" form: by time (switch after a
 * delay) or by usage (switch once the active account's usage bar crosses a
 * percentage). One schedule per provider — setting a new one replaces it.
 */
export function ScheduleSwitchForm({
  provider,
  accountId,
  email,
  onDone,
  className
}: ScheduleSwitchFormProps): React.JSX.Element {
  const scheduleByTime = useAccountScheduleStore((s) => s.scheduleByTime)
  const scheduleByUsage = useAccountScheduleStore((s) => s.scheduleByUsage)
  const existing = useAccountScheduleStore((s) => s.schedules[provider])
  const autoSwitchArmed = useAccountScheduleStore((s) => s.autoSwitch[provider] !== undefined)
  const [mode, setMode] = useState<ScheduleMode>('time')
  const [customValue, setCustomValue] = useState('')

  const replacesOther = existing !== undefined && existing.accountId !== accountId

  const submitTime = (ms: number): void => {
    scheduleByTime(provider, accountId, email, ms)
    onDone?.()
  }

  const submitUsage = (percent: number): void => {
    scheduleByUsage(provider, accountId, email, percent)
    onDone?.()
  }

  const submitCustom = (): void => {
    const value = Number(customValue)
    if (!Number.isFinite(value) || value <= 0) return
    if (mode === 'time') submitTime(value * 60_000)
    else if (value <= 100) submitUsage(value)
  }

  return (
    <div className={cn('space-y-1.5', className)} data-testid="schedule-switch-form">
      <div className="inline-flex items-center gap-0.5 rounded-sm border border-border/60 p-0.5">
        {(
          [
            { key: 'time', label: 'By time', icon: Clock },
            { key: 'usage', label: 'By usage', icon: Gauge }
          ] as const
        ).map(({ key, label, icon: Icon }) => (
          <button
            key={key}
            type="button"
            onClick={() => {
              setMode(key)
              setCustomValue('')
            }}
            aria-pressed={mode === key}
            className={cn(
              'inline-flex items-center gap-1 rounded-sm px-1.5 py-0.5 text-[9px] font-medium transition-colors',
              mode === key
                ? 'bg-accent text-foreground'
                : 'text-muted-foreground hover:text-foreground'
            )}
          >
            <Icon className="h-2.5 w-2.5" />
            {label}
          </button>
        ))}
      </div>

      <div className="flex flex-wrap items-center gap-1">
        {mode === 'time'
          ? TIME_PRESETS.map((preset) => (
              <button
                key={preset.label}
                type="button"
                onClick={() => submitTime(preset.ms)}
                className={presetButtonClass}
                aria-label={`Switch in ${preset.label}`}
              >
                {preset.label}
              </button>
            ))
          : USAGE_PRESETS.map((percent) => (
              <button
                key={percent}
                type="button"
                onClick={() => submitUsage(percent)}
                className={presetButtonClass}
                aria-label={`Switch at ${percent}% usage`}
              >
                {percent}%
              </button>
            ))}
        <div className="flex items-center gap-1">
          <input
            type="number"
            min={1}
            max={mode === 'usage' ? 100 : undefined}
            value={customValue}
            onChange={(e) => setCustomValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                submitCustom()
              }
            }}
            placeholder={mode === 'time' ? 'min' : '%'}
            aria-label={mode === 'time' ? 'Custom minutes' : 'Custom usage percent'}
            className="h-5 w-11 rounded-sm border border-border/60 bg-transparent px-1 text-[9px] text-foreground outline-none focus:border-border [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
          />
          <button
            type="button"
            onClick={submitCustom}
            disabled={!customValue}
            className={cn(presetButtonClass, 'disabled:cursor-not-allowed disabled:opacity-50')}
          >
            Set
          </button>
        </div>
      </div>

      <div className="text-[9px] text-muted-foreground/70">
        {mode === 'time'
          ? 'Switch to this account after the time elapses.'
          : 'Switch when any usage bar of the active account crosses this percent.'}
        {replacesOther && (
          <span className="text-amber-500">
            {' '}
            Replaces the pending {existing?.email ?? 'account'} schedule.
          </span>
        )}
        {autoSwitchArmed && (
          <span className="text-amber-500"> Replaces best-account auto-switch.</span>
        )}
      </div>
    </div>
  )
}

interface AutoSwitchControlsProps {
  provider: UsageProvider
  className?: string
}

/**
 * Provider-global "auto-switch accounts" control: when armed, crossing the
 * threshold refreshes every saved account and hops to the one with the most
 * headroom — and stays armed for the next crossing. Mutually exclusive with
 * the per-account schedule (arming one replaces the other).
 */
export function AutoSwitchControls({
  provider,
  className
}: AutoSwitchControlsProps): React.JSX.Element {
  const auto = useAccountScheduleStore((s) => s.autoSwitch[provider])
  const schedule = useAccountScheduleStore((s) => s.schedules[provider])
  const setAutoSwitch = useAccountScheduleStore((s) => s.setAutoSwitch)
  const disableAutoSwitch = useAccountScheduleStore((s) => s.disableAutoSwitch)
  // Subscribed only so the "(now X%)" readout re-renders when fresh usage lands.
  useUsageStore((s) => (provider === 'anthropic' ? s.anthropicUsage : s.openaiUsage))
  const [customValue, setCustomValue] = useState('')

  const enabled = auto !== undefined
  const currentPercent = enabled ? getActiveUsagePercent(provider) : null

  const submitCustom = (): void => {
    const value = Number(customValue)
    if (!Number.isFinite(value) || value <= 0 || value > 100) return
    setAutoSwitch(provider, value)
    setCustomValue('')
  }

  return (
    <div
      className={cn(
        'rounded-md border px-2 py-1.5',
        enabled ? 'border-amber-500/40 bg-amber-500/10' : 'border-border/50 bg-background/40',
        className
      )}
      data-testid="auto-switch-controls"
    >
      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-1.5">
          <Shuffle
            className={cn(
              'h-3 w-3 shrink-0',
              enabled ? 'text-amber-500' : 'text-muted-foreground'
            )}
          />
          <span
            className={cn(
              'truncate text-[11px] font-medium',
              enabled ? 'text-amber-600 dark:text-amber-400' : 'text-foreground'
            )}
          >
            Auto-switch account
          </span>
        </div>
        <Switch
          size="sm"
          checked={enabled}
          onCheckedChange={(on) =>
            on
              ? setAutoSwitch(provider, DEFAULT_AUTO_SWITCH_THRESHOLD)
              : disableAutoSwitch(provider)
          }
          aria-label="Toggle usage-based account auto-switch"
          data-testid="auto-switch-toggle"
        />
      </div>

      {enabled && auto ? (
        <>
          <div className="mt-1.5 flex flex-wrap items-center gap-1">
            <span className="text-[9px] text-muted-foreground">at</span>
            {USAGE_PRESETS.map((percent) => (
              <button
                key={percent}
                type="button"
                onClick={() => setAutoSwitch(provider, percent)}
                aria-pressed={auto.thresholdPercent === percent}
                aria-label={`Auto-switch at ${percent}% usage`}
                className={cn(
                  presetButtonClass,
                  auto.thresholdPercent === percent &&
                    'border-amber-500/50 bg-amber-500/10 text-amber-600 dark:text-amber-400'
                )}
              >
                {percent}%
              </button>
            ))}
            <div className="flex items-center gap-1">
              <input
                type="number"
                min={1}
                max={100}
                value={customValue}
                onChange={(e) => setCustomValue(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault()
                    submitCustom()
                  }
                }}
                placeholder={
                  USAGE_PRESETS.includes(auto.thresholdPercent) ? '%' : `${auto.thresholdPercent}%`
                }
                aria-label="Custom auto-switch percent"
                className="h-5 w-11 rounded-sm border border-border/60 bg-transparent px-1 text-[9px] text-foreground outline-none focus:border-border [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
              />
              <button
                type="button"
                onClick={submitCustom}
                disabled={!customValue}
                className={cn(presetButtonClass, 'disabled:cursor-not-allowed disabled:opacity-50')}
              >
                Set
              </button>
            </div>
          </div>
          <div className="mt-1 text-[9px] text-amber-600/90 dark:text-amber-400/90">
            Hops to the account with the most headroom at {auto.thresholdPercent}% usage
            {currentPercent !== null && (
              <span className="opacity-70"> (now {Math.round(currentPercent)}%)</span>
            )}
            .
          </div>
        </>
      ) : (
        <div className="mt-1 text-[9px] text-muted-foreground/70">
          Automatically hop to the account with the most usage left whenever the active one runs
          hot.
          {schedule && (
            <span className="text-amber-500"> Replaces the pending scheduled switch.</span>
          )}
        </div>
      )}
    </div>
  )
}

interface SchedulePendingSummaryProps {
  schedule: ScheduledSwitch
  onCancel: () => void
  className?: string
}

/** Live "auto-switch pending" line with a cancel button. */
export function SchedulePendingSummary({
  schedule,
  onCancel,
  className
}: SchedulePendingSummaryProps): React.JSX.Element {
  const tickMs = useTimerTickStore((s) => s.tickMs)
  const currentPercent = schedule.mode === 'usage' ? getActiveUsagePercent(schedule.provider) : null

  return (
    <div
      className={cn(
        'flex items-center gap-1 rounded-sm border border-amber-500/40 bg-amber-500/10 px-1.5 py-0.5 text-[9px] text-amber-600 dark:text-amber-400',
        className
      )}
      data-testid="schedule-pending-summary"
    >
      <Clock className="h-2.5 w-2.5 shrink-0" />
      <span className="min-w-0 flex-1 truncate">
        Auto-switch {describeSchedule(schedule, tickMs)}
        {schedule.mode === 'usage' && currentPercent !== null && (
          <span className="opacity-70"> (now {Math.round(currentPercent)}%)</span>
        )}
      </span>
      <button
        type="button"
        onClick={onCancel}
        aria-label="Cancel scheduled switch"
        className="shrink-0 rounded-sm p-0.5 transition-colors hover:bg-amber-500/20"
      >
        <X className="h-2.5 w-2.5" />
      </button>
    </div>
  )
}
