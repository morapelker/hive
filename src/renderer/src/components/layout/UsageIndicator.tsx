import { useEffect } from 'react'
import { useUsageStore } from '@/stores'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'

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
  const timeStr = minutes === 0 ? `${hour12}${ampm}` : `${hour12}:${String(minutes).padStart(2, '0')}${ampm}`

  if (type === 'five_hour') {
    return timeStr
  }

  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
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

export function UsageIndicator(): React.JSX.Element | null {
  const usage = useUsageStore((s) => s.usage)
  const fetchUsage = useUsageStore((s) => s.fetchUsage)

  useEffect(() => {
    fetchUsage()
  }, [fetchUsage])

  if (!usage) return null

  const fiveHourPercent = Math.round(usage.five_hour.utilization)
  const sevenDayPercent = Math.round(usage.seven_day.utilization)
  const fiveHourReset = formatResetTime(usage.five_hour.resets_at, 'five_hour')
  const sevenDayReset = formatResetTime(usage.seven_day.resets_at, 'seven_day')

  const extra = usage.extra_usage

  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <div className="border-t px-3 py-1.5 space-y-0.5 cursor-default" data-testid="usage-indicator">
            <UsageRow
              label="5h"
              percent={fiveHourPercent}
              resetTime={fiveHourReset}
            />
            <UsageRow
              label="7d"
              percent={sevenDayPercent}
              resetTime={sevenDayReset}
            />
          </div>
        </TooltipTrigger>
        <TooltipContent side="top" sideOffset={8}>
          <div className="space-y-1">
            <div className="font-medium">Claude API Usage</div>
            <div className="text-[10px]">
              5-hour: {Math.round(fiveHourPercent)}% (resets {fiveHourReset})
            </div>
            <div className="text-[10px]">
              7-day: {Math.round(sevenDayPercent)}% (resets {sevenDayReset})
            </div>
            {extra?.is_enabled && (
              <div className="border-t border-background/20 pt-1 text-[10px]">
                Extra: ${extra.used_credits.toFixed(2)} / ${extra.monthly_limit.toFixed(2)} used
                ({Math.round(extra.utilization)}%)
              </div>
            )}
          </div>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  )
}
