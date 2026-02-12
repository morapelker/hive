import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import { Check, ChevronDown, Search, Star } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useSettingsStore } from '@/stores/useSettingsStore'
<<<<<<< HEAD
import { toast } from '@/lib/toast'
=======
import { useSessionStore } from '@/stores/useSessionStore'
import { toast } from 'sonner'
>>>>>>> session-8-implementation-in-implementation-p17
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'

interface ModelInfo {
  id: string
  name?: string
  providerID: string
  variants?: Record<string, Record<string, unknown>>
}

interface ProviderModels {
  providerID: string
  providerName: string
  models: ModelInfo[]
}

function getDisplayName(model: ModelInfo): string {
  return model.name || model.id
}

function getVariantKeys(model: ModelInfo): string[] {
  if (!model.variants) return []
  return Object.keys(model.variants)
}

interface ModelSelectorProps {
  sessionId?: string
}

export function ModelSelector({ sessionId }: ModelSelectorProps): React.JSX.Element {
  // Read per-session model from session store (with global fallback)
  const session = useSessionStore((state) => {
    if (!sessionId) return null
    for (const sessions of state.sessionsByWorktree.values()) {
      const found = sessions.find((s) => s.id === sessionId)
      if (found) return found
    }
    return null
  })
  const globalModel = useSettingsStore((state) => state.selectedModel)
  const sessionModel =
    session?.model_id && session.model_provider_id
      ? {
          providerID: session.model_provider_id,
          modelID: session.model_id,
          variant: session.model_variant ?? undefined
        }
      : null
  const selectedModel = sessionModel ?? globalModel
  const setSelectedModel = useSettingsStore((state) => state.setSelectedModel)
  const favoriteModels = useSettingsStore((s) => s.favoriteModels)
  const toggleFavoriteModel = useSettingsStore((s) => s.toggleFavoriteModel)
  const [providers, setProviders] = useState<ProviderModels[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [filter, setFilter] = useState('')
  const [dropdownOpen, setDropdownOpen] = useState(false)
  const filterInputRef = useRef<HTMLInputElement>(null)

  // Load available models on mount
  useEffect(() => {
    let mounted = true

    async function loadModels(): Promise<void> {
      try {
        const result = await window.opencodeOps.listModels()
        if (!mounted) return

        if (result.success && result.providers) {
          const parsed = parseProviders(result.providers)
          setProviders(parsed)
        }
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
  }, [])

  // Parse the providers response into a structured format
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function parseProviders(data: any): ProviderModels[] {
    const list = Array.isArray(data) ? data : data?.providers || []
    const result: ProviderModels[] = []

    for (const provider of list) {
      const models: ModelInfo[] = []
      const providerID = provider?.id || 'unknown'

      if (provider?.models && typeof provider.models === 'object') {
        for (const [modelID, modelData] of Object.entries(provider.models)) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const md = modelData as any
          const variants =
            md?.variants && typeof md.variants === 'object'
              ? (md.variants as Record<string, Record<string, unknown>>)
              : undefined
          models.push({
            id: md?.id || modelID,
            name: md?.name,
            providerID,
            variants
          })
        }
      }

      if (models.length > 0) {
        result.push({
          providerID,
          providerName: provider?.name || providerID.charAt(0).toUpperCase() + providerID.slice(1),
          models
        })
      }
    }

    return result
  }

  function handleSelectModel(model: ModelInfo): void {
    const variantKeys = getVariantKeys(model)
<<<<<<< HEAD
    const remembered = useSettingsStore
      .getState()
      .getModelVariantDefault(model.providerID, model.id)
    const variant =
      remembered && variantKeys.includes(remembered)
        ? remembered
        : variantKeys.length > 0
          ? variantKeys[0]
          : undefined
    setSelectedModel({ providerID: model.providerID, modelID: model.id, variant })
  }

  function handleSelectVariant(model: ModelInfo, variant: string): void {
    useSettingsStore.getState().setModelVariantDefault(model.providerID, model.id, variant)
    setSelectedModel({ providerID: model.providerID, modelID: model.id, variant })
=======
    // When selecting a new model, pick its first variant if available
    const variant = variantKeys.length > 0 ? variantKeys[0] : undefined
    const newModel = { providerID: model.providerID, modelID: model.id, variant }
    if (sessionId) {
      useSessionStore.getState().setSessionModel(sessionId, newModel)
    } else {
      setSelectedModel(newModel)
    }
  }

  function handleSelectVariant(model: ModelInfo, variant: string): void {
    const newModel = { providerID: model.providerID, modelID: model.id, variant }
    if (sessionId) {
      useSessionStore.getState().setSessionModel(sessionId, newModel)
    } else {
      setSelectedModel(newModel)
    }
>>>>>>> session-8-implementation-in-implementation-p17
  }

  function isActiveModel(model: ModelInfo): boolean {
    if (!selectedModel) {
      return model.providerID === 'anthropic' && model.id === 'claude-opus-4-5-20251101'
    }
    return selectedModel.providerID === model.providerID && selectedModel.modelID === model.id
  }

  // Find the currently selected model info
  const currentModel = useMemo((): ModelInfo | null => {
    const modelID = selectedModel?.modelID || 'claude-opus-4-5-20251101'
    const providerID = selectedModel?.providerID || 'anthropic'
    for (const provider of providers) {
      if (provider.providerID === providerID) {
        const found = provider.models.find((m) => m.id === modelID)
        if (found) return found
      }
    }
    return null
  }, [selectedModel, providers])

  // Cycle thinking-level variant for Alt+T
  const cycleVariant = useCallback(() => {
    if (!currentModel) return
    const variantKeys = getVariantKeys(currentModel)
    if (variantKeys.length <= 1) return

    const currentVariant = selectedModel?.variant
    const currentIndex = currentVariant ? variantKeys.indexOf(currentVariant) : -1
    const nextIndex = (currentIndex + 1) % variantKeys.length
    const nextVariant = variantKeys[nextIndex]

<<<<<<< HEAD
    useSettingsStore
      .getState()
      .setModelVariantDefault(currentModel.providerID, currentModel.id, nextVariant)
    setSelectedModel({
=======
    const newModel = {
>>>>>>> session-8-implementation-in-implementation-p17
      providerID: currentModel.providerID,
      modelID: currentModel.id,
      variant: nextVariant
    }
    if (sessionId) {
      useSessionStore.getState().setSessionModel(sessionId, newModel)
    } else {
      setSelectedModel(newModel)
    }
    toast.success(`Variant: ${nextVariant}`)
  }, [selectedModel, currentModel, setSelectedModel, sessionId])

  // Listen for centralized Alt+T shortcut via custom event
  useEffect(() => {
    const handleCycleVariant = (): void => cycleVariant()
    window.addEventListener('hive:cycle-variant', handleCycleVariant)
    return () => window.removeEventListener('hive:cycle-variant', handleCycleVariant)
  }, [cycleVariant])

  // Determine display name for the pill
  const displayName = currentModel
    ? getDisplayName(currentModel)
    : getDisplayName({
        id: selectedModel?.modelID || 'claude-opus-4-5-20251101',
        providerID: 'anthropic'
      })

  const filteredProviders = useMemo(() => {
    if (!filter.trim()) return providers
    const q = filter.toLowerCase()
    return providers
      .map((provider) => ({
        ...provider,
        models: provider.models.filter(
          (m) =>
            getDisplayName(m).toLowerCase().includes(q) ||
            m.id.toLowerCase().includes(q) ||
            provider.providerName.toLowerCase().includes(q)
        )
      }))
      .filter((p) => p.models.length > 0)
  }, [providers, filter])

  const isFavorite = useCallback(
    (model: ModelInfo) => favoriteModels.includes(`${model.providerID}::${model.id}`),
    [favoriteModels]
  )

  const favoriteModelObjects = useMemo(
    () => providers.flatMap((p) => p.models.filter((m) => isFavorite(m))),
    [providers, isFavorite]
  )

  const currentVariantKeys = currentModel ? getVariantKeys(currentModel) : []
  const hasVariants = currentVariantKeys.length > 0

  return (
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
          title="Select model"
          aria-label={`Current model: ${displayName}. Click to change model`}
          data-testid="model-selector"
        >
          <span className="truncate max-w-[140px]">{isLoading ? 'Loading...' : displayName}</span>
          {hasVariants && selectedModel?.variant && (
            <span
              className="text-[10px] font-semibold text-primary uppercase"
              data-testid="variant-indicator"
            >
              {selectedModel.variant}
            </span>
          )}
          <ChevronDown className="h-3 w-3 shrink-0 opacity-50" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-64 max-h-80 overflow-y-auto">
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
            {favoriteModelObjects.map((model) => (
              <DropdownMenuItem
                key={`fav-${model.providerID}:${model.id}`}
                onClick={() => handleSelectModel(model)}
                onContextMenu={(e) => {
                  e.preventDefault()
                  toggleFavoriteModel(model.providerID, model.id)
                }}
                className="flex items-center justify-between gap-2 cursor-pointer"
              >
                <span className="flex items-center gap-1.5">
                  <Star className="h-3 w-3 text-yellow-500 fill-yellow-500 shrink-0" />
                  <span className="truncate text-sm">{getDisplayName(model)}</span>
                </span>
                {isActiveModel(model) && <Check className="h-4 w-4 shrink-0 text-primary" />}
              </DropdownMenuItem>
            ))}
            <DropdownMenuSeparator />
          </>
        )}
        {filteredProviders.map((provider, index) => (
          <div key={provider.providerID}>
            {index > 0 && <DropdownMenuSeparator />}
            <DropdownMenuLabel className="text-xs text-muted-foreground">
              {provider.providerName}
            </DropdownMenuLabel>
            {provider.models.map((model) => {
              const active = isActiveModel(model)
              const variantKeys = getVariantKeys(model)
              return (
                <div key={`${model.providerID}:${model.id}`}>
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
                      <span className="truncate text-sm">{getDisplayName(model)}</span>
                    </span>
                    {active && <Check className="h-4 w-4 shrink-0 text-primary" />}
                  </DropdownMenuItem>
                  {variantKeys.length > 0 && active && (
                    <div className="flex gap-1 pl-6 pb-1" data-testid={`variant-chips-${model.id}`}>
                      {variantKeys.map((variant) => (
                        <button
                          key={variant}
                          className={cn(
                            'text-[10px] px-1.5 py-0.5 rounded',
                            selectedModel?.variant === variant
                              ? 'bg-primary text-primary-foreground'
                              : 'bg-muted text-muted-foreground hover:bg-accent'
                          )}
                          onClick={(e) => {
                            e.stopPropagation()
                            handleSelectVariant(model, variant)
                          }}
                          data-testid={`variant-chip-${variant}`}
                        >
                          {variant}
                        </button>
                      ))}
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
  )
}
