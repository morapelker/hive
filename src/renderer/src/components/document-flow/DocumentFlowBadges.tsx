import { useSyncExternalStore } from 'react'
import { Check, FlaskConical, Globe, MousePointerClick } from 'lucide-react'
import { ticketPillClass } from '@/components/kanban/pill'
import { TicketModelBadge, resolveModelDisplayName } from '@/components/kanban/TicketModelBadge'
import { resolveModelIconAsset } from '@/components/worktrees/ModelIcon'
import { getModelCatalogCacheVersion, subscribeModelCatalogCache } from '@/lib/handoffSelection'
import { isUltraVariant } from '@/lib/parseProviders'
import { cn } from '@/lib/utils'
import { useSettingsStore } from '@/stores/useSettingsStore'
import { findCustomProvider } from '@shared/types/custom-provider'
import {
  DOCUMENT_VERIFICATION_METHODS,
  type DocumentRunLaunchConfig,
  type DocumentVerificationMethod
} from '@shared/types/document-flow'
import {
  DOCUMENT_FLOW_SDK_LABELS,
  describeLaunchConfig,
  hasCodexFastMode,
  type QuickLaunchChoice
} from './document-flow-launch'
import {
  DOCUMENT_VERIFICATION_LABELS,
  describeVerificationChip,
  tonePillClass,
  type DocumentFlowTone,
  type VerificationChoice
} from './document-flow-ui'

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

const VERIFICATION_ICONS: Record<DocumentVerificationMethod, typeof Check> = {
  tcu: MousePointerClick,
  playwright: Globe,
  tests: FlaskConical
}

interface VerificationChipsProps {
  itemKey: string
  item: VerificationChoice
  /** The run skips verification: the choice stays visible but cannot be changed. */
  disabled?: boolean
  /** The ticket has launched: the choice is shown as it was sent, with no toggling. */
  readOnly?: boolean
  onToggle?: (method: DocumentVerificationMethod) => void
  testIdPrefix?: string
}

/**
 * The three verification methods as one-tap toggles, always all three: pressed = the agent is
 * asked to verify that way. A suggestion the user turned off keeps a dashed border, so what
 * extraction thought stays visible. Disabled (the run skips verification) dims the group but
 * keeps every state, so turning verification back on restores the choice.
 */
export function VerificationChips({
  itemKey,
  item,
  disabled = false,
  readOnly = false,
  onToggle,
  testIdPrefix = 'docflow-item-verify'
}: VerificationChipsProps): React.JSX.Element {
  return (
    <div
      role="group"
      aria-label={`Verify ${itemKey} by`}
      data-testid={`${testIdPrefix}-${itemKey}`}
      data-disabled={disabled || undefined}
      className={cn('flex shrink-0 items-center gap-1', disabled && 'opacity-50')}
    >
      {DOCUMENT_VERIFICATION_METHODS.map((method) => {
        const pressed = item.verification.includes(method)
        const suggested = item.verification_suggested.includes(method)
        const Icon = VERIFICATION_ICONS[method]
        return (
          <button
            key={method}
            type="button"
            aria-pressed={pressed}
            disabled={disabled || readOnly}
            title={describeVerificationChip(method, item, { disabled, readOnly })}
            data-testid={`${testIdPrefix}-${itemKey}-${method}`}
            data-suggested={suggested || undefined}
            className={cn(
              'inline-flex h-6 items-center gap-1 rounded-full border px-2 font-mono text-[10px] font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring/50 disabled:cursor-default',
              pressed
                ? 'border-primary bg-primary text-primary-foreground'
                : 'border-border text-muted-foreground',
              !pressed && suggested && 'border-dashed',
              !disabled && !readOnly && !pressed && 'hover:bg-accent/50 hover:text-foreground',
              readOnly && !pressed && 'opacity-60'
            )}
            onClick={() => onToggle?.(method)}
          >
            {/* The check takes the icon's slot, so the chip keeps its width when toggled. */}
            {pressed ? (
              <Check className="h-2.5 w-2.5 shrink-0" />
            ) : (
              <Icon className="h-2.5 w-2.5 shrink-0" />
            )}
            {DOCUMENT_VERIFICATION_LABELS[method]}
          </button>
        )
      })}
    </div>
  )
}
