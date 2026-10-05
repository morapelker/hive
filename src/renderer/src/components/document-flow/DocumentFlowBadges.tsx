import { ticketPillClass } from '@/components/kanban/pill'
import { TicketModelBadge } from '@/components/kanban/TicketModelBadge'
import { isUltraVariant } from '@/lib/parseProviders'
import { cn } from '@/lib/utils'
import type { DocumentRunLaunchConfig } from '@shared/types/document-flow'
import { DOCUMENT_FLOW_SDK_LABELS } from './document-flow-launch'
import { tonePillClass, type DocumentFlowTone } from './document-flow-ui'

interface TonePillProps {
  tone: DocumentFlowTone
  children: React.ReactNode
  className?: string
  title?: string
  testId?: string
}

export function TonePill({
  tone,
  children,
  className,
  title,
  testId
}: TonePillProps): React.JSX.Element {
  return (
    <span className={cn(tonePillClass(tone), className)} title={title} data-testid={testId}>
      {children}
    </span>
  )
}

interface LaunchConfigBadgeProps {
  config: DocumentRunLaunchConfig | null
  /** What to show when there is no config of its own, e.g. "default". */
  inheritLabel: string
  testId?: string
}

/** The model a ticket launches with: model name plus effort, or a muted "default" chip. */
export function LaunchConfigBadge({
  config,
  inheritLabel,
  testId
}: LaunchConfigBadgeProps): React.JSX.Element {
  if (!config) {
    return (
      <span className={cn(ticketPillClass, 'font-mono text-[9px]')} data-testid={testId}>
        {inheritLabel}
      </span>
    )
  }
  if (!config.model) {
    return (
      <span className={cn(ticketPillClass, 'font-mono text-[9px]')} data-testid={testId}>
        {DOCUMENT_FLOW_SDK_LABELS[config.sdk]}
      </span>
    )
  }
  const variant = config.model.variant
  return (
    <span className="inline-flex shrink-0 items-center gap-1" data-testid={testId}>
      <TicketModelBadge
        ticket={{
          model_provider_id: config.model.providerID,
          model_id: config.model.modelID,
          model_variant: variant ?? null
        }}
      />
      {variant && (
        <span
          className={cn(
            ticketPillClass,
            'font-mono text-[9px]',
            isUltraVariant(variant) && 'border-violet-500/60 text-violet-600 dark:text-violet-300'
          )}
        >
          {variant}
        </span>
      )}
    </span>
  )
}
