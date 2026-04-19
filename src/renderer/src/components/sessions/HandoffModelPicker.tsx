import { useCallback, useEffect, useMemo, useState } from 'react'
import { Check, ChevronDown } from 'lucide-react'
import {
  getAvailableHandoffAgentSdks,
  getCachedModelCatalog,
  getEffectiveHandoffSelection,
  getHandoffSdkDisplayName,
  loadHandoffModelCatalog,
  resolveModelForSdkDefault,
  type HandoffSelectionOverride
} from '@/lib/handoffSelection'
import {
  findModelInfo,
  getFirstModelInfo,
  getModelDisplayName,
  getModelVariantKeys,
  type ProviderModels
} from '@/lib/parseProviders'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { useSettingsStore, type HandoffAgentSdk, type SelectedModel } from '@/stores/useSettingsStore'

interface HandoffModelPickerProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  anchor: React.ReactNode
  worktreeId?: string
  onConfirm: (override: HandoffSelectionOverride) => void
}

function buildModelFromInfo(
  modelInfo: NonNullable<ReturnType<typeof getFirstModelInfo>>,
  preferredVariant?: string
): SelectedModel {
  const variantKeys = getModelVariantKeys(modelInfo)
  const rememberedVariant = useSettingsStore
    .getState()
    .getModelVariantDefault(modelInfo.providerID, modelInfo.id)
  const variant =
    preferredVariant && variantKeys.includes(preferredVariant)
      ? preferredVariant
      : rememberedVariant && variantKeys.includes(rememberedVariant)
        ? rememberedVariant
        : variantKeys[0]

  return {
    providerID: modelInfo.providerID,
    modelID: modelInfo.id,
    variant
  }
}

export function HandoffModelPicker({
  open,
  onOpenChange,
  anchor,
  worktreeId,
  onConfirm
}: HandoffModelPickerProps): React.JSX.Element {
  const availableAgentSdks = useSettingsStore((state) => state.availableAgentSdks)
  const visibleSdks = useMemo(
    () => getAvailableHandoffAgentSdks(availableAgentSdks),
    [availableAgentSdks]
  )
  const [pickedSdk, setPickedSdk] = useState<HandoffAgentSdk>('opencode')
  const [pickedModel, setPickedModel] = useState<SelectedModel | null>(null)
  const [providersBySdk, setProvidersBySdk] = useState<Partial<Record<HandoffAgentSdk, ProviderModels[]>>>({})
  const [loadingSdks, setLoadingSdks] = useState<Partial<Record<HandoffAgentSdk, boolean>>>({})

  const ensureProviders = useCallback(async (agentSdk: HandoffAgentSdk): Promise<ProviderModels[]> => {
    const cached = getCachedModelCatalog(agentSdk)
    if (cached) {
      setProvidersBySdk((current) => ({ ...current, [agentSdk]: cached }))
      return cached
    }

    setLoadingSdks((current) => ({ ...current, [agentSdk]: true }))
    const loaded = await loadHandoffModelCatalog(agentSdk)
    setProvidersBySdk((current) => ({ ...current, [agentSdk]: loaded }))
    setLoadingSdks((current) => ({ ...current, [agentSdk]: false }))
    return loaded
  }, [])

  const resolveModelForCatalog = useCallback(
    (providers: ProviderModels[], model: SelectedModel): SelectedModel => {
      const info = findModelInfo(providers, model.providerID, model.modelID)
      if (info) return buildModelFromInfo(info, model.variant)

      const fallbackInfo = getFirstModelInfo(providers)
      return fallbackInfo ? buildModelFromInfo(fallbackInfo) : model
    },
    []
  )

  useEffect(() => {
    if (!open) return

    let active = true
    const effective = getEffectiveHandoffSelection({ worktreeId })
    setPickedSdk(effective.agentSdk)
    setPickedModel(effective.model)

    void ensureProviders(effective.agentSdk).then((providers) => {
      if (!active) return
      setPickedModel(resolveModelForCatalog(providers, effective.model))
    })

    return () => {
      active = false
    }
  }, [open, worktreeId, ensureProviders, resolveModelForCatalog])

  const currentProviders = useMemo(
    () => providersBySdk[pickedSdk] ?? getCachedModelCatalog(pickedSdk) ?? [],
    [pickedSdk, providersBySdk]
  )
  const currentModelInfo = pickedModel
    ? findModelInfo(currentProviders, pickedModel.providerID, pickedModel.modelID)
    : null
  const variantKeys = currentModelInfo ? getModelVariantKeys(currentModelInfo) : []

  const handleSelectSdk = useCallback(
    async (nextSdk: HandoffAgentSdk) => {
      setPickedSdk(nextSdk)
      setPickedModel(null)

      const providers = await ensureProviders(nextSdk)
      const configuredDefault = resolveModelForSdkDefault(nextSdk)
      const configuredInfo = findModelInfo(
        providers,
        configuredDefault.providerID,
        configuredDefault.modelID
      )
      const nextInfo = configuredInfo ?? getFirstModelInfo(providers)
      setPickedModel(nextInfo ? buildModelFromInfo(nextInfo, configuredDefault.variant) : configuredDefault)
    },
    [ensureProviders]
  )

  const handleSelectModel = useCallback((model: SelectedModel) => {
    const info = findModelInfo(currentProviders, model.providerID, model.modelID)
    setPickedModel(info ? buildModelFromInfo(info, model.variant) : model)
  }, [currentProviders])

  const handleConfirm = useCallback(() => {
    if (!pickedModel) return

    const nextOverride = {
      agentSdk: pickedSdk,
      providerID: pickedModel.providerID,
      modelID: pickedModel.modelID,
      variant: pickedModel.variant
    }
    useSettingsStore.getState().setLastHandoffOverride(nextOverride)
    onConfirm({ agentSdk: pickedSdk, model: pickedModel })
    onOpenChange(false)
  }, [onConfirm, onOpenChange, pickedModel, pickedSdk])

  const modelLabel = currentModelInfo
    ? getModelDisplayName(currentModelInfo)
    : pickedModel?.modelID ?? (loadingSdks[pickedSdk] ? 'Loading…' : 'Select model')

  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger asChild>{anchor}</PopoverTrigger>
      <PopoverContent align="end" className="w-[360px] p-3">
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-2">
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button
                  type="button"
                  aria-label="Select handoff SDK"
                  className={cn(
                    'flex h-8 items-center justify-between gap-2 rounded-full border border-border bg-muted/50 px-3 text-left text-xs font-medium text-foreground',
                    'hover:bg-muted transition-colors'
                  )}
                >
                  <span className="truncate">{getHandoffSdkDisplayName(pickedSdk)}</span>
                  <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" className="w-52">
                {visibleSdks.map((sdkOption) => (
                  <DropdownMenuItem
                    key={sdkOption}
                    onSelect={() => {
                      void handleSelectSdk(sdkOption)
                    }}
                  >
                    <Check
                      className={cn(
                        'h-3.5 w-3.5',
                        pickedSdk === sdkOption ? 'opacity-100' : 'opacity-0'
                      )}
                    />
                    <span>{getHandoffSdkDisplayName(sdkOption)}</span>
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>

            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button
                  type="button"
                  aria-label="Select handoff model"
                  className={cn(
                    'flex h-8 items-center justify-between gap-2 rounded-full border border-border bg-muted/50 px-3 text-left text-xs font-medium text-foreground',
                    'hover:bg-muted transition-colors'
                  )}
                >
                  <span className="truncate">{modelLabel}</span>
                  <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" className="w-72">
                {currentProviders.length === 0 && (
                  <DropdownMenuItem disabled>
                    <span>{loadingSdks[pickedSdk] ? 'Loading models…' : 'No models available'}</span>
                  </DropdownMenuItem>
                )}
                {currentProviders.map((provider, index) => (
                  <div key={provider.providerID}>
                    {index > 0 && <DropdownMenuSeparator />}
                    <DropdownMenuLabel className="text-xs uppercase tracking-wide text-muted-foreground">
                      {provider.providerName}
                    </DropdownMenuLabel>
                    {provider.models.map((model) => {
                      const selected =
                        pickedModel?.providerID === model.providerID && pickedModel.modelID === model.id

                      return (
                        <DropdownMenuItem
                          key={`${model.providerID}:${model.id}`}
                          onSelect={() => {
                            handleSelectModel(buildModelFromInfo(model, pickedModel?.variant))
                          }}
                        >
                          <Check className={cn('h-3.5 w-3.5', selected ? 'opacity-100' : 'opacity-0')} />
                          <span className="truncate">{getModelDisplayName(model)}</span>
                        </DropdownMenuItem>
                      )
                    })}
                  </div>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          </div>

          {variantKeys.length > 0 && pickedModel && (
            <div className="flex flex-wrap gap-1.5">
              {variantKeys.map((variant) => {
                const active = pickedModel.variant === variant
                return (
                  <button
                    key={variant}
                    type="button"
                    onClick={() => {
                      setPickedModel({ ...pickedModel, variant })
                    }}
                    className={cn(
                      'rounded-full border px-2 py-1 text-[10px] font-semibold uppercase tracking-wide transition-colors',
                      active
                        ? 'border-foreground bg-foreground text-background'
                        : 'border-border bg-muted/40 text-muted-foreground hover:bg-muted hover:text-foreground'
                    )}
                  >
                    {variant}
                  </button>
                )
              })}
            </div>
          )}

          <Button
            type="button"
            size="sm"
            className="h-8 w-full rounded-full text-xs"
            disabled={!pickedModel}
            onClick={handleConfirm}
          >
            Handoff
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  )
}
