import { resolveModelIconAsset } from '@/components/worktrees/ModelIcon'
import { getAvailableHandoffAgentSdks, getCachedModelCatalog } from '@/lib/handoffSelection'
import { findModelInfo, getModelDisplayName } from '@/lib/parseProviders'
import { cn } from '@/lib/utils'
import type { KanbanTicket } from '../../../../main/db/types'

/** Looks up the pretty model name from any cached handoff SDK catalog, falling back to the raw modelId. */
function resolveModelDisplayName(providerId: string | null, modelId: string): string {
  if (providerId) {
    for (const sdk of getAvailableHandoffAgentSdks()) {
      const catalog = getCachedModelCatalog(sdk)
      if (!catalog) continue
      const modelInfo = findModelInfo(catalog, providerId, modelId)
      if (modelInfo) return getModelDisplayName(modelInfo)
    }
  }

  return modelId
}

interface TicketModelBadgeProps {
  ticket: Pick<KanbanTicket, 'model_provider_id' | 'model_id' | 'model_variant'>
  className?: string
}

export function TicketModelBadge({
  ticket,
  className
}: TicketModelBadgeProps): React.JSX.Element | null {
  const { model_provider_id: providerId, model_id: modelId, model_variant: variant } = ticket
  if (!modelId) return null

  const icon = resolveModelIconAsset(providerId, modelId)
  const displayName = resolveModelDisplayName(providerId, modelId)
  const title = variant ? `${displayName} (${variant})` : displayName

  return (
    <span
      title={title}
      className={cn(
        'inline-flex items-center gap-1 rounded-full bg-muted/40 px-2 py-0.5 text-[11px] font-medium text-muted-foreground',
        className
      )}
    >
      {icon && <img src={icon.src} alt={icon.alt} className="h-3 w-3 shrink-0" draggable={false} />}
      {displayName}
    </span>
  )
}
