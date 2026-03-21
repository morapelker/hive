import { useEffect } from 'react'
import { useUsageStore, useSessionStore, resolveUsageProvider, normalizeUsage } from '@/stores'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import claudeIcon from '@/assets/model-icons/claude.svg'
import openaiIcon from '@/assets/model-icons/openai.svg'

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
          style={{ width: `${Math.min(100, Math.max(0, percent))}%` }}
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

export function UsageIndicator(): React.JSX.Element | null {
  const activeProvider = useUsageStore((s) => s.activeProvider)
  const anthropicUsage = useUsageStore((s) => s.anthropicUsage)
  const openaiUsage = useUsageStore((s) => s.openaiUsage)
  const fetchUsage = useUsageStore((s) => s.fetchUsage)
  const setActiveProvider = useUsageStore((s) => s.setActiveProvider)

  const activeSessionId = useSessionStore((s) => s.activeSessionId)

  // Detect provider from active session
  useEffect(() => {
    if (!activeSessionId) return
    const session = findSessionById(activeSessionId)
    if (session) {
      const provider = resolveUsageProvider(session)
      setActiveProvider(provider)
    }
  }, [activeSessionId, setActiveProvider])

  useEffect(() => {
    fetchUsage()
  }, [fetchUsage])

  const usage = normalizeUsage(activeProvider, anthropicUsage, openaiUsage)

  if (!usage) return null

  const fiveHourPercent = Math.round(usage.five_hour.utilization)
  const sevenDayPercent = Math.round(usage.seven_day.utilization)
  const fiveHourReset = formatResetTime(usage.five_hour.resets_at, 'five_hour')
  const sevenDayReset = formatResetTime(usage.seven_day.resets_at, 'seven_day')

  const extra = usage.extra_usage

  const providerIcon = activeProvider === 'anthropic' ? claudeIcon : openaiIcon
  const providerLabel = activeProvider === 'anthropic' ? 'Claude' : 'OpenAI'
  const tooltipTitle = activeProvider === 'anthropic' ? 'Claude API Usage' : 'OpenAI API Usage'

  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <div
            className="border-t px-3 py-1.5 space-y-0.5 cursor-default"
            data-testid="usage-indicator"
          >
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
            {activeProvider === 'anthropic' && extra?.is_enabled && (
              <div className="border-t border-background/20 pt-1 text-[10px]">
                Extra: ${(extra.used_credits ?? 0).toFixed(2)} / ${(extra.monthly_limit ?? 0).toFixed(2)} used (
                {Math.round(extra.utilization ?? 0)}%)
              </div>
            )}
          </div>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  )
}
