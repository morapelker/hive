import { useCallback, useEffect, useMemo, useState } from 'react'
import { Check, ChevronDown } from 'lucide-react'
import {
  getAvailableHandoffAgentSdks,
  getCachedModelCatalog,
  getHandoffSdkDisplayName,
  loadHandoffModelCatalog
} from '@/lib/handoffSelection'
import {
  buildCustomProviderCatalog,
  findModelInfo,
  getFirstModelInfo,
  getModelDisplayName,
  getModelVariantKeys,
  type ProviderModels
} from '@/lib/parseProviders'
import { cn } from '@/lib/utils'
import { isWindows } from '@/lib/platform'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { useSettingsStore, type HandoffAgentSdk } from '@/stores/useSettingsStore'
import { CUSTOM_MODEL_PROVIDER_ID, findCustomProvider } from '@shared/types/custom-provider'
import type { SharedSelectedModel } from '@shared/model-resolution'

export interface VoiceCleanupModelSelection {
  model: SharedSelectedModel | null
  customProviderId: string | null
}

interface VoiceCleanupModelPickerProps {
  value: VoiceCleanupModelSelection
  onChange: (next: VoiceCleanupModelSelection) => void
  disabled?: boolean
}

const pillClass =
  'flex h-8 items-center justify-between gap-2 rounded-full border border-border bg-muted/50 px-3 text-left text-xs font-medium text-foreground hover:bg-muted transition-colors disabled:opacity-50 disabled:pointer-events-none'

function sdkFromSelection(value: VoiceCleanupModelSelection): HandoffAgentSdk {
  if (value.customProviderId) return 'claude-code-cli'
  const sdk = value.model?.agentSdk
  if (sdk === 'codex' || sdk === 'opencode' || sdk === 'claude-code-cli') return sdk
  return 'claude-code'
}

/**
 * "Which of my providers cleans up the transcript": the same provider →
 * model → effort chain as the session handoff picker (SDK catalogs plus
 * custom claude-cli providers), inline for the settings page. Clearing the
 * selection lets the app's default provider chain pick a cheap model.
 */
export function VoiceCleanupModelPicker({
  value,
  onChange,
  disabled = false
}: VoiceCleanupModelPickerProps): React.JSX.Element {
  const availableAgentSdks = useSettingsStore((state) => state.availableAgentSdks)
  const customProviders = useSettingsStore((state) => state.customProviders)
  const visibleSdks = useMemo(
    () => getAvailableHandoffAgentSdks(availableAgentSdks),
    [availableAgentSdks]
  )
  const visibleCustomProviders = useMemo(
    () => (isWindows() ? [] : (customProviders ?? []).filter((p) => p.command.trim())),
    [customProviders]
  )
  const pickedSdk = sdkFromSelection(value)
  const [catalogs, setCatalogs] = useState<Partial<Record<HandoffAgentSdk, ProviderModels[]>>>({})
  const [loading, setLoading] = useState<Partial<Record<HandoffAgentSdk, boolean>>>({})

  const ensureCatalog = useCallback(async (sdk: HandoffAgentSdk): Promise<ProviderModels[]> => {
    const cached = getCachedModelCatalog(sdk)
    if (cached) {
      setCatalogs((current) => ({ ...current, [sdk]: cached }))
      return cached
    }
    setLoading((current) => ({ ...current, [sdk]: true }))
    const loaded = await loadHandoffModelCatalog(sdk)
    setCatalogs((current) => ({ ...current, [sdk]: loaded }))
    setLoading((current) => ({ ...current, [sdk]: false }))
    return loaded
  }, [])

  useEffect(() => {
    if (value.model && !value.customProviderId) void ensureCatalog(pickedSdk)
  }, [value.model, value.customProviderId, pickedSdk, ensureCatalog])

  const customCatalog = useMemo(() => {
    if (!value.customProviderId) return null
    const provider = findCustomProvider(customProviders, value.customProviderId)
    return provider ? buildCustomProviderCatalog(provider) : []
  }, [value.customProviderId, customProviders])

  const providers = customCatalog ?? catalogs[pickedSdk] ?? getCachedModelCatalog(pickedSdk) ?? []
  const modelInfo = value.model
    ? findModelInfo(providers, value.model.providerID, value.model.modelID)
    : null
  const variantKeys = modelInfo ? getModelVariantKeys(modelInfo) : []

  const selectSdk = async (sdk: HandoffAgentSdk): Promise<void> => {
    const catalog = await ensureCatalog(sdk)
    const first = getFirstModelInfo(catalog)
    onChange({
      customProviderId: null,
      model: first
        ? {
            agentSdk: sdk,
            providerID: first.providerID,
            modelID: first.id,
            variant: getModelVariantKeys(first)[0]
          }
        : null
    })
  }

  const selectCustomProvider = (customProviderId: string): void => {
    const provider = findCustomProvider(customProviders, customProviderId)
    const catalog = provider ? buildCustomProviderCatalog(provider) : []
    const first = getFirstModelInfo(catalog)
    onChange({
      customProviderId,
      model: {
        agentSdk: 'claude-code-cli',
        providerID: CUSTOM_MODEL_PROVIDER_ID,
        modelID: first?.id ?? '',
        variant: first ? getModelVariantKeys(first)[0] : undefined
      }
    })
  }

  const selectModel = (providerID: string, modelID: string): void => {
    const info = findModelInfo(providers, providerID, modelID)
    const keys = info ? getModelVariantKeys(info) : []
    const variant =
      value.model?.variant && keys.includes(value.model.variant) ? value.model.variant : keys[0]
    onChange({
      customProviderId: value.customProviderId,
      model: { agentSdk: pickedSdk, providerID, modelID, variant }
    })
  }

  const providerLabel = value.model
    ? getHandoffSdkDisplayName(pickedSdk, value.customProviderId)
    : 'App default'
  const modelLabel = modelInfo
    ? getModelDisplayName(modelInfo)
    : value.model?.modelID || (loading[pickedSdk] ? 'Loading…' : 'Select model')

  return (
    <div className="space-y-2" data-testid="voice-cleanup-model-picker">
      <div className="grid grid-cols-2 gap-2">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              className={pillClass}
              disabled={disabled}
              aria-label="Select cleanup provider"
              data-testid="voice-cleanup-provider"
            >
              <span className="truncate">{providerLabel}</span>
              <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-56">
            <DropdownMenuItem onSelect={() => onChange({ model: null, customProviderId: null })}>
              <Check className={cn('h-3.5 w-3.5', value.model ? 'opacity-0' : 'opacity-100')} />
              <span>App default (cheapest available)</span>
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            {visibleSdks.map((sdk) => (
              <DropdownMenuItem key={sdk} onSelect={() => void selectSdk(sdk)}>
                <Check
                  className={cn(
                    'h-3.5 w-3.5',
                    value.model && pickedSdk === sdk && !value.customProviderId
                      ? 'opacity-100'
                      : 'opacity-0'
                  )}
                />
                <span>{getHandoffSdkDisplayName(sdk)}</span>
              </DropdownMenuItem>
            ))}
            {visibleCustomProviders.map((provider) => (
              <DropdownMenuItem
                key={provider.id}
                onSelect={() => selectCustomProvider(provider.id)}
              >
                <Check
                  className={cn(
                    'h-3.5 w-3.5',
                    value.customProviderId === provider.id ? 'opacity-100' : 'opacity-0'
                  )}
                />
                <span>{provider.name || 'Custom Provider'}</span>
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>

        {value.customProviderId && providers.length === 0 ? (
          <div
            className="flex h-8 items-center rounded-full border border-border bg-muted/30 px-3 text-xs text-muted-foreground"
            title="The provider's command decides the model"
          >
            <span className="truncate">Model set by command</span>
          </div>
        ) : (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                className={pillClass}
                disabled={disabled || !value.model}
                aria-label="Select cleanup model"
                data-testid="voice-cleanup-model"
              >
                <span className="truncate">{value.model ? modelLabel : 'Automatic'}</span>
                <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="w-72 max-h-72 overflow-y-auto">
              {providers.length === 0 && (
                <DropdownMenuItem disabled>
                  <span>{loading[pickedSdk] ? 'Loading models…' : 'No models available'}</span>
                </DropdownMenuItem>
              )}
              {providers.map((provider, index) => (
                <div key={provider.providerID}>
                  {index > 0 && <DropdownMenuSeparator />}
                  <DropdownMenuLabel className="text-xs uppercase tracking-wide text-muted-foreground">
                    {provider.providerName}
                  </DropdownMenuLabel>
                  {provider.models.map((model) => {
                    const selected =
                      value.model?.providerID === model.providerID &&
                      value.model.modelID === model.id
                    return (
                      <DropdownMenuItem
                        key={`${model.providerID}:${model.id}`}
                        onSelect={() => selectModel(model.providerID, model.id)}
                      >
                        <Check
                          className={cn('h-3.5 w-3.5', selected ? 'opacity-100' : 'opacity-0')}
                        />
                        <span className="truncate">{getModelDisplayName(model)}</span>
                      </DropdownMenuItem>
                    )
                  })}
                </div>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </div>

      {variantKeys.length > 0 && value.model && (
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-[10px] uppercase tracking-wide text-muted-foreground mr-1">
            Effort
          </span>
          {variantKeys.map((variant) => {
            const active = value.model?.variant === variant
            return (
              <button
                key={variant}
                type="button"
                disabled={disabled}
                onClick={() =>
                  onChange({
                    customProviderId: value.customProviderId,
                    model: value.model ? { ...value.model, variant } : null
                  })
                }
                className={cn(
                  'rounded-full border px-2 py-1 text-[10px] font-semibold uppercase tracking-wide transition-colors',
                  active
                    ? 'border-foreground bg-foreground text-background'
                    : 'border-border bg-muted/40 text-muted-foreground hover:bg-muted hover:text-foreground'
                )}
                data-testid={`voice-cleanup-effort-${variant}`}
              >
                {variant}
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}
