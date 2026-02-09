import { useMemo } from 'react'
import { useContextStore } from '@/stores/useContextStore'
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger
} from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'

interface ContextIndicatorProps {
  sessionId: string
  modelId: string
}

function formatNumber(n: number): string {
  return n.toLocaleString()
}

function getBarColor(percent: number): string {
  if (percent >= 90) return 'bg-red-500'
  if (percent >= 80) return 'bg-orange-500'
  if (percent >= 60) return 'bg-yellow-500'
  return 'bg-green-500'
}

export function ContextIndicator({ sessionId, modelId }: ContextIndicatorProps): React.JSX.Element | null {
  // Select raw state values (stable references) to avoid infinite re-render
  const tokenInfo = useContextStore((state) => state.tokensBySession[sessionId])
  const modelLimit = useContextStore((state) => state.modelLimits[modelId])

  // Compute derived values locally
  const { used, limit, percent, tokens } = useMemo(() => {
    const t = tokenInfo ?? { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 }
    const lim = modelLimit ?? 0
    const u = t.input + t.output + t.cacheRead
    const pct = lim > 0 ? Math.min(100, Math.round((u / lim) * 100)) : 0
    return { used: u, limit: lim, percent: pct, tokens: t }
  }, [tokenInfo, modelLimit])

  // Don't render if no limit or no usage yet
  if (limit === 0 && used === 0) return null

  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <div
            className="w-[120px] flex-shrink-0 cursor-default"
            data-testid="context-indicator"
          >
            <div className="h-1.5 rounded-full bg-muted overflow-hidden">
              <div
                className={cn('h-full rounded-full transition-all duration-300', getBarColor(percent))}
                style={{ width: `${Math.min(100, percent)}%` }}
                data-testid="context-bar"
              />
            </div>
          </div>
        </TooltipTrigger>
        <TooltipContent side="top" sideOffset={8} className="max-w-[240px]">
          <div className="space-y-1.5">
            <div className="font-medium">Context Usage</div>
            <div>
              {formatNumber(used)} / {formatNumber(limit)} tokens ({percent}%)
            </div>
            <div className="border-t border-background/20 pt-1.5 space-y-0.5 text-[10px] opacity-80">
              <div>Input: {formatNumber(tokens.input)}</div>
              <div>Output: {formatNumber(tokens.output)}</div>
              <div>Reasoning: {formatNumber(tokens.reasoning)}</div>
              <div>Cache read: {formatNumber(tokens.cacheRead)}</div>
              <div>Cache write: {formatNumber(tokens.cacheWrite)}</div>
            </div>
          </div>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  )
}
