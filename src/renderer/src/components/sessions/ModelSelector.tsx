import { useState, useEffect } from 'react'
import { Check, ChevronDown } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useSettingsStore } from '@/stores/useSettingsStore'
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
}

interface ProviderModels {
  providerID: string
  providerName: string
  models: ModelInfo[]
}

/** Strip date suffix from model ID: claude-opus-4-5-20251101 -> claude-opus-4-5 */
function shortenModelName(modelID: string, name?: string): string {
  if (name) return name
  return modelID.replace(/(-\d{8,})$/, '')
}

export function ModelSelector(): React.JSX.Element {
  const selectedModel = useSettingsStore((state) => state.selectedModel)
  const setSelectedModel = useSettingsStore((state) => state.setSelectedModel)
  const [providers, setProviders] = useState<ProviderModels[]>([])
  const [isLoading, setIsLoading] = useState(true)

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
    return () => { mounted = false }
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
          models.push({
            id: md?.id || modelID,
            name: md?.name,
            providerID
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

  function handleSelect(model: ModelInfo): void {
    setSelectedModel({ providerID: model.providerID, modelID: model.id })
  }

  function isActive(model: ModelInfo): boolean {
    if (!selectedModel) {
      // Default model
      return model.providerID === 'anthropic' && model.id === 'claude-opus-4-5-20251101'
    }
    return selectedModel.providerID === model.providerID && selectedModel.modelID === model.id
  }

  // Determine display name for the pill
  const displayName = (() => {
    if (selectedModel) {
      // Find the model in providers to get its name
      for (const provider of providers) {
        const found = provider.models.find(
          (m) => m.id === selectedModel.modelID && m.providerID === selectedModel.providerID
        )
        if (found) return shortenModelName(found.id, found.name)
      }
      return shortenModelName(selectedModel.modelID)
    }
    return shortenModelName('claude-opus-4-5-20251101')
  })()

  return (
    <DropdownMenu>
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
          <ChevronDown className="h-3 w-3 shrink-0 opacity-50" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-64 max-h-80 overflow-y-auto">
        {providers.map((provider, index) => (
          <div key={provider.providerID}>
            {index > 0 && <DropdownMenuSeparator />}
            <DropdownMenuLabel className="text-xs text-muted-foreground">
              {provider.providerName}
            </DropdownMenuLabel>
            {provider.models.map((model) => (
              <DropdownMenuItem
                key={`${model.providerID}:${model.id}`}
                onClick={() => handleSelect(model)}
                className="flex items-center justify-between gap-2 cursor-pointer"
                data-testid={`model-option-${model.id}`}
              >
                <span className="truncate text-sm">
                  {shortenModelName(model.id, model.name)}
                </span>
                {isActive(model) && (
                  <Check className="h-4 w-4 shrink-0 text-primary" />
                )}
              </DropdownMenuItem>
            ))}
          </div>
        ))}
        {providers.length === 0 && !isLoading && (
          <div className="px-2 py-4 text-center text-sm text-muted-foreground">
            No models available
          </div>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
