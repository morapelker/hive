import React, { useEffect } from 'react'
import { useUsageStore, useSessionStore, resolveUsageProvider, resolveDefaultUsageProvider, normalizeUsage } from '@/stores'
import { useSettingsStore } from '@/stores/useSettingsStore'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import claudeIcon from '@/assets/model-icons/claude.svg'
import openaiIcon from '@/assets/model-icons/openai.svg'
import type { UsageProvider } from '@shared/types/usage'

function getBarColor(percent: number): string {
  if (percent >= 90) return 'bg-red-500'
  if (percent >= 80) return 'bg-orange-500'
  if (percent >= 60) return 'bg-yellow-500'
  return 'bg-green-500'
}

function formatResetTime(isoString: string, type: 'five_hour' | 'seven_day'): string {
  const date = new Date(isoString)
  if (isNaN(date.getTime())) return ''

  const hours = date.getHours()
  const minutes = date.getMinutes()
  const ampm = hours >= 12 ? 'pm' : 'am'
  const hour12 = hours % 12 || 12
  const timeStr =
    minutes === 0 ? `${hour12}${ampm}` : `${hour12}:${String(minutes).padStart(2, '0')}${ampm}`

  if (type === 'five_hour') {
    return timeStr
  }

  const months = [
    'Jan',
    'Feb',
    'Mar',
    'Apr',
    'May',
    'Jun',
    'Jul',
    'Aug',
    'Sep',
    'Oct',
    'Nov',
    'Dec'
  ]
  const month = months[date.getMonth()]
  const day = date.getDate()
  return `${month} ${day}, ${timeStr}`
}

interface UsageRowProps {
  label: string
  percent: number
  resetTime: string
}

function UsageRow({ label, percent, resetTime }: UsageRowProps): React.JSX.Element {
  return (
    <div className="flex items-center gap-1.5">
      <span className="text-[10px] text-muted-foreground w-5 shrink-0">{label}</span>
      <div className="h-1.5 flex-1 rounded-full bg-muted overflow-hidden">
        <div
          className={cn('h-full rounded-full transition-all duration-300', getBarColor(percent))}
          style={{ width: `${Math.min(100, Math.max(0, percent))}%`, minWidth: 2 }}
        />
      </div>
      <span className="text-[10px] font-mono text-muted-foreground w-7 text-right shrink-0">
        {Math.round(percent)}%
      </span>
      <span className="text-[10px] text-muted-foreground/60 shrink-0">{resetTime}</span>
    </div>
  )
}

function findSessionById(
  sessionId: string
): {
  agent_sdk?: string | null
  model_provider_id?: string | null
  model_id?: string | null
} | null {
  const state = useSessionStore.getState()
  for (const sessions of state.sessionsByWorktree.values()) {
    const session = sessions.find((s) => s.id === sessionId)
    if (session) return session
  }
  for (const sessions of state.sessionsByConnection.values()) {
    const session = sessions.find((s) => s.id === sessionId)
    if (session) return session
  }
  return null
}

const PROVIDER_ORDER: UsageProvider[] = ['anthropic', 'openai']

function getVisibleProviders(
  mode: 'current-agent' | 'specific-providers',
  selectedProviders: UsageProvider[],
  activeProvider: UsageProvider
): UsageProvider[] {
  if (mode === 'current-agent') return [activeProvider]
  return PROVIDER_ORDER.filter((p) => selectedProviders.includes(p))
}

function ProviderUsageBlock({
  provider,
  isExplicitlySelected
}: {
  provider: UsageProvider
  isExplicitlySelected: boolean
}): React.JSX.Element | null {
  const anthropicUsage = useUsageStore((s) => s.anthropicUsage)
  const openaiUsage = useUsageStore((s) => s.openaiUsage)

  const usage = normalizeUsage(provider, anthropicUsage, openaiUsage)

  const providerIcon = provider === 'anthropic' ? claudeIcon : openaiIcon
  const providerLabel = provider === 'anthropic' ? 'Claude' : 'OpenAI'
  const tooltipTitle = provider === 'anthropic' ? 'Claude API Usage' : 'OpenAI API Usage'

  // No credentials state — show muted N/A bars when explicitly selected
  if (!usage) {
    if (!isExplicitlySelected) return null
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <div className="px-3 py-1.5 space-y-0.5 cursor-default opacity-40">
            <div className="flex items-center gap-1.5">
              <img src={providerIcon} alt={providerLabel} className="h-3 w-3 shrink-0 opacity-50" />
              <div className="flex-1 space-y-0.5">
                <UsageRow label="5h" percent={0} resetTime="N/A" />
                <UsageRow label="7d" percent={0} resetTime="N/A" />
              </div>
            </div>
          </div>
        </TooltipTrigger>
        <TooltipContent side="top" sideOffset={8}>
          <div className="space-y-1">
            <div className="font-medium">{tooltipTitle}</div>
            <div className="text-[10px]">No credentials configured</div>
          </div>
        </TooltipContent>
      </Tooltip>
    )
  }

  const fiveHourPercent = Math.round(usage.five_hour.utilization)
  const sevenDayPercent = Math.round(usage.seven_day.utilization)
  const fiveHourReset = formatResetTime(usage.five_hour.resets_at, 'five_hour')
  const sevenDayReset = formatResetTime(usage.seven_day.resets_at, 'seven_day')
  const extra = usage.extra_usage

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <div className="px-3 py-1.5 space-y-0.5 cursor-default">
          <div className="flex items-center gap-1.5">
            <img src={providerIcon} alt={providerLabel} className="h-3 w-3 shrink-0 opacity-50" />
            <div className="flex-1 space-y-0.5">
              <UsageRow label="5h" percent={fiveHourPercent} resetTime={fiveHourReset} />
              <UsageRow label="7d" percent={sevenDayPercent} resetTime={sevenDayReset} />
            </div>
          </div>
        </div>
      </TooltipTrigger>
      <TooltipContent side="top" sideOffset={8}>
        <div className="space-y-1">
          <div className="font-medium">{tooltipTitle}</div>
          <div className="text-[10px]">
            5-hour: {Math.round(fiveHourPercent)}% (resets {fiveHourReset})
          </div>
          <div className="text-[10px]">
            7-day: {Math.round(sevenDayPercent)}% (resets {sevenDayReset})
          </div>
          {provider === 'anthropic' && extra?.is_enabled && (
            <div className="border-t border-background/20 pt-1 text-[10px]">
              Extra: ${(extra.used_credits ?? 0).toFixed(2)} / ${(extra.monthly_limit ?? 0).toFixed(2)} used (
              {Math.round(extra.utilization ?? 0)}%)
            </div>
          )}
        </div>
      </TooltipContent>
    </Tooltip>
  )
}

export function UsageIndicator(): React.JSX.Element | null {
  const usageIndicatorMode = useSettingsStore((s) => s.usageIndicatorMode)
  const usageIndicatorProviders = useSettingsStore((s) => s.usageIndicatorProviders)

  const activeProvider = useUsageStore((s) => s.activeProvider)
  const fetchUsageForProvider = useUsageStore((s) => s.fetchUsageForProvider)
  const setActiveProvider = useUsageStore((s) => s.setActiveProvider)

  const activeSessionId = useSessionStore((s) => s.activeSessionId)

  // Detect provider from active session and fetch all visible providers on worktree switch.
  // setActiveProvider fetches the detected provider internally (if stale).
  // We additionally fetch every visible provider so pinned bars stay fresh.
  // fetchUsageForProvider is debounce-safe, so overlapping calls are no-ops.
  useEffect(() => {
    if (activeSessionId) {
      const session = findSessionById(activeSessionId)
      if (session) {
        const provider = resolveUsageProvider(session)
        setActiveProvider(provider)
      } else {
        // BOARD_TAB_ID or stale session — fall back to default SDK
        const { defaultAgentSdk } = useSettingsStore.getState()
        setActiveProvider(resolveDefaultUsageProvider(defaultAgentSdk))
      }
    } else {
      // No session at all — resolve from defaultAgentSdk setting
      const { defaultAgentSdk } = useSettingsStore.getState()
      setActiveProvider(resolveDefaultUsageProvider(defaultAgentSdk))
    }

    // Read settings via getState() to avoid array-ref dep churn
    const { usageIndicatorMode: mode, usageIndicatorProviders: selected } =
      useSettingsStore.getState()
    const current = useUsageStore.getState().activeProvider
    getVisibleProviders(mode, selected, current).forEach((p) => fetchUsageForProvider(p))
  }, [activeSessionId, setActiveProvider, fetchUsageForProvider])

  const visibleProviders = getVisibleProviders(
    usageIndicatorMode,
    usageIndicatorProviders,
    activeProvider
  )

  if (visibleProviders.length === 0) return null

  const isExplicitlySelected = usageIndicatorMode === 'specific-providers'

  return (
    <div className="border-t" data-testid="usage-indicator">
      {visibleProviders.map((provider, i) => (
        <React.Fragment key={provider}>
          {i > 0 && <div className="border-t border-border/50 mx-3" />}
          <ProviderUsageBlock provider={provider} isExplicitlySelected={isExplicitlySelected} />
        </React.Fragment>
      ))}
    </div>
  )
}
