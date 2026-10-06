import { useSyncExternalStore } from 'react'
import { Check } from 'lucide-react'
import { ticketPillClass } from '@/components/kanban/pill'
import { TicketModelBadge, resolveModelDisplayName } from '@/components/kanban/TicketModelBadge'
import { resolveModelIconAsset } from '@/components/worktrees/ModelIcon'
import { getModelCatalogCacheVersion, subscribeModelCatalogCache } from '@/lib/handoffSelection'
import { isUltraVariant } from '@/lib/parseProviders'
import { cn } from '@/lib/utils'
import { useSettingsStore } from '@/stores/useSettingsStore'
import { findCustomProvider } from '@shared/types/custom-provider'
import type { DocumentRunLaunchConfig } from '@shared/types/document-flow'
import {
  DOCUMENT_FLOW_SDK_LABELS,
  describeLaunchConfig,
  hasCodexFastMode,
  type QuickLaunchChoice
} from './document-flow-launch'
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

interface LaunchConfigChipProps {
  choice: QuickLaunchChoice
  /** The ticket launches with this config right now. */
  pressed: boolean
  testId?: string
  onClick: () => void
}

/**
 * A model another ticket already uses, offered as a one-tap toggle: model name plus effort,
 * with the whole launch config (SDK, fast mode, custom provider) behind it.
 */
export function LaunchConfigChip({
  choice,
  pressed,
  testId,
  onClick
}: LaunchConfigChipProps): React.JSX.Element {
  // Swap the raw model slug for its pretty name once a catalog lands, like TicketModelBadge.
  useSyncExternalStore(subscribeModelCatalogCache, getModelCatalogCacheVersion)

  const { config, sdkLabel } = choice
  // A custom provider runs its own command: one tap must say which one, like the picker does.
  const customProviderName = useSettingsStore((s) =>
    config.customProviderId
      ? findCustomProvider(s.customProviders, config.customProviderId)?.name.trim() ||
        'Custom Provider'
      : null
  )
  const model = config.model
  const icon = model ? resolveModelIconAsset(model.providerID, model.modelID) : null
  const name = model
    ? resolveModelDisplayName(model.providerID, model.modelID)
    : (customProviderName ?? DOCUMENT_FLOW_SDK_LABELS[config.sdk])
  const variant = model?.variant
  const fast = hasCodexFastMode(config)
  const source = model && customProviderName ? customProviderName : sdkLabel
  const description = `${describeLaunchConfig(config, customProviderName)}${fast ? ' · fast' : ''}`
  // What tells two chips apart stays as readable as the name until the chip is pressed.
  const detailClass = cn('shrink-0', pressed && 'opacity-70')

  return (
    <button
      type="button"
      aria-pressed={pressed}
      title={pressed ? `${description} (click to use the run default)` : `Use ${description}`}
      data-testid={testId}
      className={cn(
        'inline-flex h-6 min-w-0 items-center gap-1 rounded-full border px-2 font-mono text-[10px] font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring/50',
        pressed
          ? 'border-primary bg-primary text-primary-foreground'
          : 'border-border text-muted-foreground hover:bg-accent/50 hover:text-foreground'
      )}
      onClick={onClick}
    >
      {/* The check takes the icon's slot, so the chip keeps its width when toggled. */}
      {pressed ? (
        <Check className="h-2.5 w-2.5 shrink-0" />
      ) : (
        icon && <img src={icon.src} alt="" className="h-2.5 w-2.5 shrink-0" draggable={false} />
      )}
      <span className="max-w-[120px] truncate">{name}</span>
      {variant && (
        <span
          className={cn(
            detailClass,
            !pressed && isUltraVariant(variant) && 'text-violet-600 dark:text-violet-300'
          )}
        >
          {variant}
        </span>
      )}
      {fast && <span className={detailClass}>fast</span>}
      {source && <span className={cn(detailClass, 'max-w-[90px] shrink truncate')}>{source}</span>}
    </button>
  )
}
