import { useEffect, useMemo, useState } from 'react'
import {
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  CirclePause,
  Gauge,
  Target
} from 'lucide-react'

import { cn } from '@/lib/utils'
import { useSettingsStore } from '@/stores/useSettingsStore'
import type { CodexThreadGoal } from '@/stores/useSessionStore'

export interface GoalStatusWidgetProps {
  goal: CodexThreadGoal
  topOffsetPx: number
}

function formatGoalTokensCompact(value: number): string {
  const abs = Math.abs(value)
  if (abs >= 1_000_000) return formatCompactNumber(value / 1_000_000, 'M')
  if (abs >= 1_000) return formatCompactNumber(value / 1_000, 'K')
  return String(value)
}

function formatCompactNumber(value: number, suffix: string): string {
  const rounded = Math.abs(value) >= 10 ? Math.round(value) : Math.round(value * 10) / 10
  return `${String(rounded).replace(/\.0$/, '')}${suffix}`
}

function formatGoalElapsedSeconds(seconds: number): string {
  const safeSeconds = Math.max(0, Math.floor(seconds))
  if (safeSeconds < 60) return `${safeSeconds}s`

  const days = Math.floor(safeSeconds / 86_400)
  const hours = Math.floor((safeSeconds % 86_400) / 3_600)
  const minutes = Math.floor((safeSeconds % 3_600) / 60)
  const remainingSeconds = safeSeconds % 60

  if (days > 0) {
    return `${days}d ${hours}h ${minutes}m`
  }

  if (hours > 0) {
    return `${hours}h ${minutes}m`
  }

  if (remainingSeconds > 30) {
    return `${minutes}m ${remainingSeconds}s`
  }

  return `${minutes}m`
}

function getGoalUsage(goal: CodexThreadGoal, elapsedSeconds: number): string | null {
  if (goal.tokenBudget && goal.tokenBudget > 0) {
    return `${formatGoalTokensCompact(goal.tokensUsed)} / ${formatGoalTokensCompact(goal.tokenBudget)}`
  }

  if (elapsedSeconds > 0) {
    return formatGoalElapsedSeconds(elapsedSeconds)
  }

  return null
}

function getGoalStatusLine(goal: CodexThreadGoal, elapsedSeconds: number): string {
  const usage = getGoalUsage(goal, elapsedSeconds)
  const suffix = usage ? ` (${usage})` : ''

  switch (goal.status) {
    case 'paused':
      return 'Goal paused (/goal resume)'
    case 'budgetLimited':
      return usage ? `Goal unmet (${usage})` : 'Goal abandoned'
    case 'complete':
      return `Goal achieved${suffix}`
    case 'active':
    default:
      return `Pursuing goal${suffix}`
  }
}

function getGoalStatusClasses(status: CodexThreadGoal['status']): string {
  switch (status) {
    case 'paused':
      return 'text-amber-700 dark:text-amber-300'
    case 'complete':
      return 'text-emerald-700 dark:text-emerald-300'
    case 'budgetLimited':
      return 'text-rose-700 dark:text-rose-300'
    case 'active':
    default:
      return 'text-blue-700 dark:text-blue-300'
  }
}

function GoalStatusIcon({ status }: { status: CodexThreadGoal['status'] }): React.JSX.Element {
  if (status === 'complete') return <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-500" />
  if (status === 'paused') return <CirclePause className="h-4 w-4 shrink-0 text-amber-500" />
  if (status === 'budgetLimited') return <Gauge className="h-4 w-4 shrink-0 text-rose-500" />
  return <Target className="h-4 w-4 shrink-0 text-blue-500" />
}

export function GoalStatusWidget({
  goal,
  topOffsetPx
}: GoalStatusWidgetProps): React.JSX.Element {
  const collapsed = useSettingsStore((s) => s.goalStatusCollapsed)
  const updateSetting = useSettingsStore((s) => s.updateSetting)
  const [nowMs, setNowMs] = useState(() => Date.now())

  useEffect(() => {
    if (goal.status !== 'active') return

    const timer = window.setInterval(() => {
      setNowMs(Date.now())
    }, 1000)

    return () => {
      window.clearInterval(timer)
    }
  }, [goal.status])

  const elapsedSeconds = useMemo(() => {
    const base = goal.timeUsedSeconds
    if (goal.status !== 'active' || !goal.observedAtMs) return base
    return base + Math.max(0, Math.floor((nowMs - goal.observedAtMs) / 1000))
  }, [goal.observedAtMs, goal.status, goal.timeUsedSeconds, nowMs])

  const statusLine = getGoalStatusLine(goal, elapsedSeconds)
  const tokenText = goal.tokenBudget
    ? `${formatGoalTokensCompact(goal.tokensUsed)} / ${formatGoalTokensCompact(goal.tokenBudget)}`
    : formatGoalTokensCompact(goal.tokensUsed)
  const elapsedText = formatGoalElapsedSeconds(elapsedSeconds)

  return (
    <div
      data-testid="goal-status-widget"
      style={{ top: `${topOffsetPx}px` }}
      className="absolute right-4 z-20 w-80 rounded-lg border border-border bg-background/95 backdrop-blur shadow-md transition-all duration-150"
    >
      {collapsed ? (
        <button
          type="button"
          data-testid="goal-status-widget-toggle"
          onClick={() => updateSetting('goalStatusCollapsed', false)}
          className="flex w-full cursor-pointer items-center gap-2 px-3 py-2 text-left"
          aria-label="Expand goal status"
        >
          <GoalStatusIcon status={goal.status} />
          <span className={cn('min-w-0 flex-1 truncate text-sm font-medium', getGoalStatusClasses(goal.status))}>
            {statusLine}
          </span>
          <ChevronDown className="h-4 w-4 shrink-0" />
        </button>
      ) : (
        <>
          <button
            type="button"
            data-testid="goal-status-widget-toggle"
            onClick={() => updateSetting('goalStatusCollapsed', true)}
            className="flex w-full cursor-pointer items-center gap-2 border-b border-border px-3 py-2 text-left"
            aria-label="Collapse goal status"
          >
            <GoalStatusIcon status={goal.status} />
            <span className="text-sm font-medium">Goal</span>
            <ChevronUp className="ml-auto h-4 w-4 shrink-0" />
          </button>
          <div className="space-y-2 p-3">
            <div className={cn('text-sm font-medium', getGoalStatusClasses(goal.status))}>
              {statusLine}
            </div>
            <div className="line-clamp-3 text-xs leading-5 text-foreground">{goal.objective}</div>
            <div className="grid grid-cols-2 gap-2 text-xs">
              <div className="rounded-md bg-muted/50 px-2 py-1.5">
                <div className="text-muted-foreground">Tokens</div>
                <div className="mt-0.5 font-medium text-foreground">{tokenText}</div>
              </div>
              <div className="rounded-md bg-muted/50 px-2 py-1.5">
                <div className="text-muted-foreground">Elapsed</div>
                <div className="mt-0.5 font-medium text-foreground">{elapsedText}</div>
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  )
}
