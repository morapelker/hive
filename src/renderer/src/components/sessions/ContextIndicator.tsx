import { useMemo } from 'react'
import { getModelLimitKey, useContextStore } from '@/stores/useContextStore'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'

interface ContextIndicatorProps {
  sessionId: string
  modelId: string
  providerId?: string
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

export function ContextIndicator({
  sessionId,
  modelId,
  providerId
}: ContextIndicatorProps): React.JSX.Element | null {
  const tokenInfo = useContextStore((state) => state.tokensBySession[sessionId])
  const sessionModel = useContextStore((state) => state.modelBySession[sessionId])
  const modelLimits = useContextStore((state) => state.modelLimits)
  const cost = useContextStore((state) => state.costBySession[sessionId]) ?? 0

  const { used, limit, percent, tokens } = useMemo(() => {
    const t = tokenInfo ?? { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 }
    const model =
      sessionModel ??
      (modelId
        ? {
            providerID: providerId ?? '*',
            modelID: modelId
          }
        : undefined)

    const lim = model
      ? (modelLimits[getModelLimitKey(model.modelID, model.providerID)] ??
        modelLimits[getModelLimitKey(model.modelID)])
      : undefined

    const u = t.input + t.output + t.reasoning + t.cacheRead + t.cacheWrite
    const pct = typeof lim === 'number' && lim > 0 ? Math.round((u / lim) * 100) : null
    return { used: u, limit: lim, percent: pct, tokens: t }
  }, [tokenInfo, sessionModel, modelId, providerId, modelLimits])

  const percentForBar = percent ?? 0

  // Don't render if no limit or no usage yet
  if (!limit && used === 0) return null

  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <div className="w-[120px] flex-shrink-0 cursor-default" data-testid="context-indicator">
            <div className="h-1.5 rounded-full bg-muted overflow-hidden">
              <div
                className={cn(
                  'h-full rounded-full transition-all duration-300',
                  getBarColor(percentForBar)
                )}
                style={{ width: `${Math.min(100, Math.max(0, percentForBar))}%` }}
                data-testid="context-bar"
              />
            </div>
          </div>
        </TooltipTrigger>
        <TooltipContent side="top" sideOffset={8} className="max-w-[240px]">
          <div className="space-y-1.5">
            <div className="font-medium">Context Usage</div>
            {typeof limit === 'number' ? (
              <div>
                {formatNumber(used)} / {formatNumber(limit)} tokens ({percent ?? 0}%)
              </div>
            ) : (
              <div>{formatNumber(used)} tokens (limit unavailable)</div>
            )}
            <div className="border-t border-background/20 pt-1.5 space-y-0.5 text-[10px] opacity-80">
              <div>Input: {formatNumber(tokens.input)}</div>
              <div>Output: {formatNumber(tokens.output)}</div>
              <div>Reasoning: {formatNumber(tokens.reasoning)}</div>
              <div>Cache read: {formatNumber(tokens.cacheRead)}</div>
              <div>Cache write: {formatNumber(tokens.cacheWrite)}</div>
            </div>
            {cost > 0 && (
              <div className="border-t border-background/20 pt-1.5">
                <div>Session cost: ${cost.toFixed(4)}</div>
              </div>
            )}
          </div>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  )
}
