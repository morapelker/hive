import React, { useState } from 'react'
import { Clock, Gauge, X } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useTimerTickStore } from '@/stores/useTimerTickStore'
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

const USAGE_PRESETS = [50, 70, 90]

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
      </div>
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
