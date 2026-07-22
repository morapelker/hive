import { memo, useState, useEffect, useCallback, useMemo, useRef } from 'react'
import { Check, ChevronDown, Search, Star } from 'lucide-react'
import { cn } from '@/lib/utils'
import {
  cacheHandoffModelCatalog,
  getAvailableHandoffAgentSdks,
  getHandoffSdkDisplayName
} from '@/lib/handoffSelection'
import {
  findModelInfo,
  getModelDisplayName,
  getModelVariantKeys,
  getVariantKeysForSdk,
  isUltraVariant,
  parseProviders,
  ULTRACODE_VARIANT,
  type ModelInfo,
  type ProviderModels
} from '@/lib/parseProviders'
import {
  useSettingsStore,
  resolveModelForSdk,
  type SelectedModel,
  type HandoffAgentSdk
} from '@/stores/useSettingsStore'
import { useSessionStore } from '@/stores/useSessionStore'
import { toModelCatalogSdk } from '@shared/types/agent-sdk'
import { toast } from '@/lib/toast'
import { unwrapEnvelope } from '@/lib/ipc-envelope'
import { opencodeApi } from '@/api/opencode-api'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'

interface ModelSelectorProps {
  sessionId?: string
  // Controlled mode (for settings)
  value?: SelectedModel | null
  onChange?: (model: SelectedModel) => void
  // Override the SDK used for model listing (e.g. force 'opencode' in settings when defaultAgentSdk is 'terminal')
  agentSdkOverride?: 'opencode' | 'claude-code' | 'claude-code-cli' | 'codex'
  disableTitleTooltip?: boolean
  hideProviderPrefix?: boolean
  allowAgentSdkSelection?: boolean
}

type SelectableModelInfo = ModelInfo & { agentSdk: HandoffAgentSdk }
type SelectableProviderModels = Omit<ProviderModels, 'models'> & {
  agentSdk: HandoffAgentSdk
  models: SelectableModelInfo[]
}
type SdkFilterOption = {
  agentSdk: HandoffAgentSdk
  label: string
}

const ULTRACODE_TOOLTIP = 'xhigh effort + dynamic-workflow orchestration'

/** ultracode and codex's `ultra` effort share the violet accent so both read as
 * special top-tier modes rather than just another effort level. */
const isAccentVariant = isUltraVariant

/** Styling for a variant chip. Accent variants (ultracode, ultra) get a
 * distinct look so they read as the special modes they are. */
function variantChipClass(isActive: boolean, isAccent: boolean): string {
  if (isAccent) {
    return cn(
      'text-[10px] px-1.5 py-0.5 rounded font-medium',
      isActive
        ? 'bg-violet-600 text-white'
        : 'bg-violet-500/15 text-violet-600 dark:text-violet-300 hover:bg-violet-500/25'
    )
  }
  return cn(
    'text-[10px] px-1.5 py-0.5 rounded',
    isActive
      ? 'bg-primary text-primary-foreground'
      : 'bg-muted text-muted-foreground hover:bg-accent'
  )
}

export const ModelSelector = memo(function ModelSelector({
  sessionId,
  value,
  onChange,
  agentSdkOverride,
  disableTitleTooltip = false,
  hideProviderPrefix = false,
  allowAgentSdkSelection = false
}: ModelSelectorProps): React.JSX.Element {
  // Read per-session model from session store (with global fallback)
  const session = useSessionStore((state) => {
    if (!sessionId) return null
    for (const sessions of state.sessionsByWorktree.values()) {
      const found = sessions.find((s) => s.id === sessionId)
      if (found) return found
    }
    for (const sessions of state.sessionsByConnection.values()) {
      const found = sessions.find((s) => s.id === sessionId)
      if (found) return found
    }
    return null
  })
  const defaultAgentSdk = useSettingsStore((s) => s.defaultAgentSdk)
  const rawAgentSdk = agentSdkOverride ?? session?.agent_sdk ?? defaultAgentSdk ?? 'opencode'
  // Terminal SDK has no models — fall back to opencode for model listing
  const agentSdk = rawAgentSdk === 'terminal' ? 'opencode' : rawAgentSdk
  const globalModel = useSettingsStore((state) => resolveModelForSdk(agentSdk, state))
  const availableAgentSdks = useSettingsStore((s) => s.availableAgentSdks)
  const sessionModel: SelectedModel | null =
    session?.model_id && session.model_provider_id
      ? {
          providerID: session.model_provider_id,
          modelID: session.model_id,
          variant: session.model_variant ?? undefined
        }
      : null
  // Controlled mode: non-null value overrides; null means "use global fallback."
  // SettingsModels passes null for cleared mode defaults — display the effective model, not empty.
  const selectedModel =
    value !== undefined && value !== null ? value : (sessionModel ?? globalModel)
  const showModelProvider = useSettingsStore((s) => s.showModelProvider)
  const favoriteModels = useSettingsStore((s) => s.favoriteModels)
  const toggleFavoriteModel = useSettingsStore((s) => s.toggleFavoriteModel)
  const [providers, setProviders] = useState<SelectableProviderModels[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [filter, setFilter] = useState('')
  const [agentSdkFilter, setAgentSdkFilter] = useState<HandoffAgentSdk | null>(() =>
    allowAgentSdkSelection ? (value?.agentSdk ?? null) : null
  )
  const [dropdownOpen, setDropdownOpen] = useState(false)
  const filterInputRef = useRef<HTMLInputElement>(null)
  const rememberedModelBySdkRef = useRef<Partial<Record<HandoffAgentSdk, SelectedModel>>>({})

  const catalogAgentSdks = useMemo((): HandoffAgentSdk[] => {
    if (!allowAgentSdkSelection) return [agentSdk as HandoffAgentSdk]
    return getAvailableHandoffAgentSdks(availableAgentSdks)
  }, [agentSdk, allowAgentSdkSelection, availableAgentSdks])

  // Load available models on mount
  useEffect(() => {
    let mounted = true

    async function loadModels(): Promise<void> {
      try {
        if (!mounted) return
        setIsLoading(true)
        const catalogs = await Promise.all(
          catalogAgentSdks.map(async (sdk) => {
            const listModelsSdk = toModelCatalogSdk(sdk)
            const result = unwrapEnvelope(await opencodeApi.listModels({ agentSdk: listModelsSdk }))
            if (!result.success || !result.providers) return []
            const parsed = parseProviders(result.providers)
            cacheHandoffModelCatalog(sdk, result.providers)
            return parsed.map(
              (provider): SelectableProviderModels => ({
                ...provider,
                agentSdk: sdk,
                models: provider.models.map((model) => ({ ...model, agentSdk: sdk }))
              })
            )
          })
        )
        if (mounted) setProviders(catalogs.flat())
      } catch (error) {
        console.error('Failed to load models:', error)
      } finally {
        if (mounted) setIsLoading(false)
      }
    }

    loadModels()
    return () => {
      mounted = false
    }
  }, [catalogAgentSdks])

  const isModelPortableToCurrentSdk = useCallback(
    (providerID: string, modelID: string, variant?: string): boolean => {
      const currentSdkProviders = providers.filter((provider) => provider.agentSdk === agentSdk)
      const currentSdkModel = findModelInfo(currentSdkProviders, providerID, modelID)
      if (!currentSdkModel) return false
      return !variant || getVariantKeysForSdk(currentSdkModel, agentSdk).includes(variant)
    },
    [providers, agentSdk]
  )

  const isModelPortableToAllCatalogSdks = useCallback(
    (providerID: string, modelID: string, variant?: string): boolean => {
      if (catalogAgentSdks.length === 0) return false
      return catalogAgentSdks.every((sdk) => {
        const sdkProviders = providers.filter((provider) => provider.agentSdk === sdk)
        if (sdkProviders.length === 0) return false
        const sdkModel = findModelInfo(sdkProviders, providerID, modelID)
        if (!sdkModel) return false
        return !variant || getVariantKeysForSdk(sdkModel, sdk).includes(variant)
      })
    },
    [providers, catalogAgentSdks]
  )

  const buildSelectedModel = useCallback(
    (
      model: SelectableModelInfo,
      variant?: string,
      options?: { includeAgentSdk?: boolean }
    ): SelectedModel => {
      const includeAgentSdk =
        options?.includeAgentSdk ??
        (allowAgentSdkSelection &&
          (agentSdkFilter !== null ||
            !isModelPortableToAllCatalogSdks(model.providerID, model.id, variant)))
      return {
        ...(includeAgentSdk ? { agentSdk: model.agentSdk } : {}),
        providerID: model.providerID,
        modelID: model.id,
        variant
      }
    },
    [allowAgentSdkSelection, agentSdkFilter, isModelPortableToAllCatalogSdks]
  )

  const rememberSelectedModel = useCallback((model: SelectedModel, sdk: HandoffAgentSdk): void => {
    rememberedModelBySdkRef.current[sdk] = {
      ...model,
      agentSdk: sdk
    }
  }, [])

  const applySelectedModel = useCallback(
    (model: SelectedModel, sdk: HandoffAgentSdk): void => {
      rememberSelectedModel(model, sdk)
      if (onChange) {
        onChange(model)
      } else if (sessionId) {
        useSessionStore.getState().setSessionModel(sessionId, model)
      } else {
        useSettingsStore.getState().setSelectedModelForSdk(sdk, model)
      }
    },
    [onChange, rememberSelectedModel, sessionId]
  )

  function getFallbackModelForSdk(sdk: HandoffAgentSdk): SelectableModelInfo | null {
    return providers.find((provider) => provider.agentSdk === sdk)?.models[0] ?? null
  }

  function resolveSelectableModelForSdk(sdk: HandoffAgentSdk): SelectedModel | null {
    const remembered =
      rememberedModelBySdkRef.current[sdk] ?? resolveModelForSdk(sdk, useSettingsStore.getState())
    if (remembered) {
      const sdkProviders = providers.filter((provider) => provider.agentSdk === sdk)
      const modelInfo = findModelInfo(
        sdkProviders,
        remembered.providerID,
        remembered.modelID
      ) as SelectableModelInfo | null
      if (modelInfo) {
        return {
          ...remembered,
          agentSdk: sdk
        }
      }
    }

    const fallbackModel = getFallbackModelForSdk(sdk)
    if (!fallbackModel) return null
    return buildSelectedModel(fallbackModel, getModelVariantKeys(fallbackModel)[0], {
      includeAgentSdk: true
    })
  }

  function handleSelectModel(model: SelectableModelInfo): void {
    // SDK-aware so a remembered `ultracode` choice is honored on re-select.
    // ultracode is appended last, so it never becomes the implicit [0] default.
    const variantKeys = getVariantKeysForSdk(model, model.agentSdk)
    const remembered = useSettingsStore
      .getState()
      .getModelVariantDefault(model.providerID, model.id)
    const variant =
      remembered && variantKeys.includes(remembered)
        ? remembered
        : variantKeys.length > 0
          ? variantKeys[0]
          : undefined
    const newModel = buildSelectedModel(model, variant)

    // Use controlled onChange if provided (for settings), otherwise update store
    applySelectedModel(newModel, model.agentSdk)
  }

  function handleSelectVariant(model: SelectableModelInfo, variant: string): void {
    const newModel = buildSelectedModel(model, variant)

    // Use controlled onChange if provided (for settings), otherwise update store
    if (onChange) {
      // In controlled mode, just notify parent - don't update global variant preference
      applySelectedModel(newModel, model.agentSdk)
    } else {
      // In uncontrolled mode, persist variant preference globally
      useSettingsStore.getState().setModelVariantDefault(model.providerID, model.id, variant)
      applySelectedModel(newModel, model.agentSdk)
    }
  }

  function handleSelectAgentSdkFilter(sdk: HandoffAgentSdk | null): void {
    setAgentSdkFilter(sdk)
    if (!sdk) {
      if (onChange && selectedModel?.agentSdk) {
        if (
          isModelPortableToAllCatalogSdks(
            selectedModel.providerID,
            selectedModel.modelID,
            selectedModel.variant
          )
        ) {
          onChange({
            providerID: selectedModel.providerID,
            modelID: selectedModel.modelID,
            variant: selectedModel.variant
          })
        } else {
          onChange(selectedModel)
        }
      }
      return
    }
    const nextModel = resolveSelectableModelForSdk(sdk)
    if (nextModel) applySelectedModel(nextModel, sdk)
  }

  function isActiveModel(model: SelectableModelInfo): boolean {
    if (!selectedModel) {
      return model.providerID === 'anthropic' && model.id === 'claude-opus-4-5-20251101'
    }
    if (allowAgentSdkSelection && !selectedModel.agentSdk && agentSdkFilter === null) {
      const matchesModel =
        selectedModel.providerID === model.providerID && selectedModel.modelID === model.id
      if (!matchesModel) return false
      return isModelPortableToCurrentSdk(
        selectedModel.providerID,
        selectedModel.modelID,
        selectedModel.variant
      )
        ? model.agentSdk === agentSdk
        : true
    }
    const selectedAgentSdk = selectedModel.agentSdk ?? agentSdk
    return (
      selectedAgentSdk === model.agentSdk &&
      selectedModel.providerID === model.providerID &&
      selectedModel.modelID === model.id
    )
  }

  // Find the currently selected model info
  const currentModel = useMemo((): SelectableModelInfo | null => {
    const modelID = selectedModel?.modelID || 'claude-opus-4-5-20251101'
    const providerID = selectedModel?.providerID || 'anthropic'
    const selectedAgentSdk = selectedModel?.agentSdk ?? agentSdk
    if (
      allowAgentSdkSelection &&
      selectedModel &&
      !selectedModel.agentSdk &&
      agentSdkFilter === null
    ) {
      const currentSdkProviders = providers.filter((provider) => provider.agentSdk === agentSdk)
      const currentSdkModel = findModelInfo(
        currentSdkProviders,
        providerID,
        modelID
      ) as SelectableModelInfo | null
      if (currentSdkModel) return currentSdkModel

      return findModelInfo(providers, providerID, modelID) as SelectableModelInfo | null
    }

    const sdkProviders = providers.filter((provider) => provider.agentSdk === selectedAgentSdk)
    return findModelInfo(sdkProviders, providerID, modelID) as SelectableModelInfo | null
  }, [selectedModel, providers, agentSdk, allowAgentSdkSelection, agentSdkFilter])

  const providerPrefix = useMemo(() => {
    if (hideProviderPrefix || !showModelProvider) return null
    if (allowAgentSdkSelection) {
      const selectedAgentSdk = currentModel?.agentSdk ?? selectedModel?.agentSdk ?? agentSdk
      return getHandoffSdkDisplayName(selectedAgentSdk as HandoffAgentSdk)
    }
    if (agentSdk === 'claude-code') return 'ANTHROPIC'
    return (
      currentModel?.providerID?.toUpperCase() ?? selectedModel?.providerID?.toUpperCase() ?? null
    )
  }, [
    hideProviderPrefix,
    showModelProvider,
    allowAgentSdkSelection,
    agentSdk,
    currentModel,
    selectedModel
  ])

  // Cycle thinking-level variant for Alt+T
  const cycleVariant = useCallback(() => {
    if (!currentModel) return
    const variantKeys = getVariantKeysForSdk(currentModel, currentModel.agentSdk)
    if (variantKeys.length <= 1) return

    const currentVariant = selectedModel?.variant
    const currentIndex = currentVariant ? variantKeys.indexOf(currentVariant) : -1
    const nextIndex = (currentIndex + 1) % variantKeys.length
    const nextVariant = variantKeys[nextIndex]

    const newModel = buildSelectedModel(currentModel, nextVariant)

    // Use controlled onChange if provided (for settings), otherwise update store
    if (onChange) {
      // In controlled mode, just notify parent - don't update global variant preference
      applySelectedModel(newModel, currentModel.agentSdk)
    } else {
      // In uncontrolled mode, persist variant preference globally
      useSettingsStore
        .getState()
        .setModelVariantDefault(currentModel.providerID, currentModel.id, nextVariant)
      applySelectedModel(newModel, currentModel.agentSdk)
    }
    toast.success(`Variant: ${nextVariant}`)
  }, [selectedModel, currentModel, onChange, buildSelectedModel, applySelectedModel])

  // Listen for centralized Alt+T shortcut via custom event (session selectors only).
  // Controlled-mode selectors (e.g. Settings > Models) must not react to the global
  // shortcut — otherwise every selector on the page cycles its variant at once.
  useEffect(() => {
    if (onChange) return
    const handleCycleVariant = (): void => cycleVariant()
    window.addEventListener('hive:cycle-variant', handleCycleVariant)
    return () => window.removeEventListener('hive:cycle-variant', handleCycleVariant)
  }, [cycleVariant, onChange])

  // Determine display name for the pill
  const displayName = currentModel
    ? getModelDisplayName(currentModel)
    : getModelDisplayName({
        id: selectedModel?.modelID || 'claude-opus-4-5-20251101'
      })

  const sdkFilterOptions = useMemo((): SdkFilterOption[] => {
    const availableSdks = new Set(providers.map((provider) => provider.agentSdk))
    const controlledSdk = allowAgentSdkSelection ? value?.agentSdk : null
    return catalogAgentSdks
      .filter((sdk) => availableSdks.has(sdk) || sdk === controlledSdk)
      .map((sdk) => ({
        agentSdk: sdk,
        label: getHandoffSdkDisplayName(sdk)
      }))
  }, [providers, catalogAgentSdks, allowAgentSdkSelection, value?.agentSdk])

  useEffect(() => {
    if (!allowAgentSdkSelection) return
    setAgentSdkFilter(value?.agentSdk ?? null)
  }, [allowAgentSdkSelection, value?.agentSdk])

  useEffect(() => {
    if (!agentSdkFilter) return
    if (sdkFilterOptions.length === 0) return
    if (!sdkFilterOptions.some((option) => option.agentSdk === agentSdkFilter)) {
      setAgentSdkFilter(null)
    }
  }, [agentSdkFilter, sdkFilterOptions])

  const selectedProviderFilterLabel =
    sdkFilterOptions.find((option) => option.agentSdk === agentSdkFilter)?.label ??
    'All providers'
  const showProviderFilter = sdkFilterOptions.length > 1

  const providerScopedProviders = useMemo(() => {
    if (!agentSdkFilter) return providers
    return providers.filter((provider) => provider.agentSdk === agentSdkFilter)
  }, [providers, agentSdkFilter])

  const filteredProviders = useMemo(() => {
    if (!filter.trim()) return providerScopedProviders
    const q = filter.toLowerCase()
    return providerScopedProviders
      .map((provider) => ({
        ...provider,
        models: provider.models.filter(
          (m) =>
            getModelDisplayName(m).toLowerCase().includes(q) ||
            m.id.toLowerCase().includes(q) ||
            provider.providerName.toLowerCase().includes(q)
        )
      }))
      .filter((p) => p.models.length > 0)
  }, [providerScopedProviders, filter])

  const isFavorite = useCallback(
    (model: ModelInfo) => favoriteModels.includes(`${model.providerID}::${model.id}`),
    [favoriteModels]
  )

  const favoriteModelObjects = useMemo(
    () => providerScopedProviders.flatMap((p) => p.models.filter((m) => isFavorite(m))),
    [providerScopedProviders, isFavorite]
  )

  const currentVariantKeys = currentModel ? getModelVariantKeys(currentModel) : []
  const hasVariants = currentVariantKeys.length > 0

  return (
    <div className="flex items-center gap-1.5">
      {providerPrefix && (
        <span className="text-[10px] font-medium text-muted-foreground uppercase shrink-0">
          {providerPrefix}
        </span>
      )}
      {showProviderFilter && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              className={cn(
                'flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-medium transition-colors',
                'border select-none',
                'bg-background border-border text-muted-foreground hover:bg-muted hover:text-foreground'
              )}
              title="Filter providers"
              aria-label={`Provider filter: ${selectedProviderFilterLabel}`}
              data-testid="model-provider-filter"
            >
              <span className="truncate max-w-[130px]">{selectedProviderFilterLabel}</span>
              <ChevronDown className="h-3 w-3 shrink-0 opacity-50" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-56">
            <DropdownMenuItem
              onClick={() => handleSelectAgentSdkFilter(null)}
              className="flex items-center justify-between gap-2 cursor-pointer"
              data-testid="model-provider-filter-option-all"
            >
              <span className="truncate text-sm">All providers</span>
              {!agentSdkFilter && <Check className="h-4 w-4 shrink-0 text-primary" />}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            {sdkFilterOptions.map((option) => (
              <DropdownMenuItem
                key={option.agentSdk}
                onClick={() => handleSelectAgentSdkFilter(option.agentSdk)}
                className="flex items-center justify-between gap-2 cursor-pointer"
                data-testid={`model-provider-filter-option-${option.agentSdk}`}
              >
                <span className="truncate text-sm">{option.label}</span>
                {agentSdkFilter === option.agentSdk && (
                  <Check className="h-4 w-4 shrink-0 text-primary" />
                )}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      )}
      <DropdownMenu
        open={dropdownOpen}
        onOpenChange={(open) => {
          setDropdownOpen(open)
          if (!open) setFilter('')
          else setTimeout(() => filterInputRef.current?.focus(), 0)
        }}
      >
        <DropdownMenuTrigger asChild>
          <button
            className={cn(
              'flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-medium transition-colors',
              'border select-none',
              'bg-muted/50 border-border text-muted-foreground hover:bg-muted hover:text-foreground'
            )}
            title={disableTitleTooltip ? undefined : 'Select model'}
            aria-label={`Current model: ${displayName}. Click to change model`}
            data-testid="model-selector"
          >
            <span className="truncate max-w-[140px]">{isLoading ? 'Loading...' : displayName}</span>
            {hasVariants && selectedModel?.variant && (
              <span
                className={cn(
                  'text-[10px] font-semibold uppercase',
                  isAccentVariant(selectedModel.variant)
                    ? 'text-violet-600 dark:text-violet-300'
                    : 'text-primary'
                )}
                data-testid="variant-indicator"
              >
                {selectedModel.variant}
              </span>
            )}
            <ChevronDown className="h-3 w-3 shrink-0 opacity-50" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-96 max-h-80 overflow-y-auto">
          <div className="flex items-center gap-1.5 px-2 pb-1.5 pt-1">
            <Search className="h-3 w-3 shrink-0 text-muted-foreground" />
            <input
              ref={filterInputRef}
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              onKeyDown={(e) => e.stopPropagation()}
              placeholder="Filter models..."
              className="flex-1 bg-transparent text-xs outline-none placeholder:text-muted-foreground/60"
            />
          </div>
          <DropdownMenuSeparator />
          {favoriteModelObjects.length > 0 && (
            <>
              <DropdownMenuLabel className="text-xs text-muted-foreground flex items-center gap-1">
                <Star className="h-3 w-3 fill-yellow-500 text-yellow-500" /> Favorites
              </DropdownMenuLabel>
              {favoriteModelObjects.map((model) => {
                const favActive = isActiveModel(model)
                const favVariantKeys = getVariantKeysForSdk(model, model.agentSdk)
                return (
                  <div key={`fav-${model.agentSdk}:${model.providerID}:${model.id}`}>
                    <DropdownMenuItem
                      onClick={() => handleSelectModel(model)}
                      onContextMenu={(e) => {
                        e.preventDefault()
                        toggleFavoriteModel(model.providerID, model.id)
                      }}
                      className="flex items-center justify-between gap-2 cursor-pointer"
                    >
                      <span className="flex items-center gap-1.5">
                        <Star className="h-3 w-3 text-yellow-500 fill-yellow-500 shrink-0" />
                        <span className="truncate text-sm">{getModelDisplayName(model)}</span>
                      </span>
                      {favActive && <Check className="h-4 w-4 shrink-0 text-primary" />}
                    </DropdownMenuItem>
                    {favVariantKeys.length > 0 && (
                      <div className="flex flex-wrap gap-1 pl-6 pb-1">
                        {favVariantKeys.map((variant) => {
                          const isActiveVariant = favActive && selectedModel?.variant === variant
                          const isUltracode = variant === ULTRACODE_VARIANT
                          return (
                            <button
                              key={variant}
                              className={variantChipClass(isActiveVariant, isAccentVariant(variant))}
                              title={isUltracode ? ULTRACODE_TOOLTIP : undefined}
                              onClick={(e) => {
                                e.stopPropagation()
                                handleSelectVariant(model, variant)
                              }}
                            >
                              {variant.toUpperCase()}
                            </button>
                          )
                        })}
                      </div>
                    )}
                  </div>
                )
              })}
              <DropdownMenuSeparator />
            </>
          )}
          {filteredProviders.map((provider, index) => (
            <div key={`${provider.agentSdk}:${provider.providerID}`}>
              {index > 0 && <DropdownMenuSeparator />}
              <DropdownMenuLabel className="text-xs text-muted-foreground">
                {allowAgentSdkSelection
                  ? `${getHandoffSdkDisplayName(provider.agentSdk)} / ${provider.providerName}`
                  : provider.providerName}
              </DropdownMenuLabel>
              {provider.models.map((model) => {
                const active = isActiveModel(model)
                const variantKeys = getVariantKeysForSdk(model, model.agentSdk)
                return (
                  <div key={`${model.agentSdk}:${model.providerID}:${model.id}`}>
                    <DropdownMenuItem
                      onClick={() => handleSelectModel(model)}
                      onContextMenu={(e) => {
                        e.preventDefault()
                        toggleFavoriteModel(model.providerID, model.id)
                      }}
                      className="flex items-center justify-between gap-2 cursor-pointer"
                      data-testid={`model-item-${model.id}`}
                    >
                      <span className="flex items-center gap-1.5">
                        {isFavorite(model) && (
                          <Star className="h-3 w-3 text-yellow-500 fill-yellow-500 shrink-0" />
                        )}
                        <span className="truncate text-sm">{getModelDisplayName(model)}</span>
                      </span>
                      {active && <Check className="h-4 w-4 shrink-0 text-primary" />}
                    </DropdownMenuItem>
                    {variantKeys.length > 0 && (
                      <div
                        className="flex flex-wrap gap-1 pl-6 pb-1"
                        data-testid={`variant-chips-${model.id}`}
                      >
                        {variantKeys.map((variant) => {
                          const isActiveVariant = active && selectedModel?.variant === variant
                          const isUltracode = variant === ULTRACODE_VARIANT
                          return (
                            <button
                              key={variant}
                              className={variantChipClass(isActiveVariant, isAccentVariant(variant))}
                              title={isUltracode ? ULTRACODE_TOOLTIP : undefined}
                              onClick={(e) => {
                                e.stopPropagation()
                                handleSelectVariant(model, variant)
                              }}
                              data-testid={`variant-chip-${variant}`}
                            >
                              {variant.toUpperCase()}
                            </button>
                          )
                        })}
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          ))}
          {filteredProviders.length === 0 && !isLoading && (
            <div className="px-2 py-4 text-center text-sm text-muted-foreground">
              {filter ? 'No matching models' : 'No models available'}
            </div>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  )
})
