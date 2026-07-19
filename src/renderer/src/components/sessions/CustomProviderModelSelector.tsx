import { Check, ChevronDown } from 'lucide-react'
import { cn } from '@/lib/utils'
import {
  CUSTOM_MODEL_PROVIDER_ID,
  getCustomProviderModelDisplayName,
  getLaunchableCustomProviderModels,
  resolveCustomProviderModelSelection,
  type CustomClaudeProvider
} from '@shared/types/custom-provider'
import type { SelectedModel } from '@/stores/useSettingsStore'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'

interface CustomProviderModelSelectorProps {
  provider: CustomClaudeProvider
  /** Candidate selection; invalid/absent values display the provider default. */
  value: SelectedModel | null
  onChange: (model: SelectedModel) => void
  testIdPrefix?: string
}

/**
 * Model + effort picker for a custom provider's declared models — the
 * stock ModelSelector is SDK-catalog based and would offer ultracode, so
 * custom providers get this dedicated pill. Renders nothing when the provider
 * declares no launchable models (the command owns the model then).
 */
export function CustomProviderModelSelector({
  provider,
  value,
  onChange,
  testIdPrefix = 'custom-provider-model-selector'
}: CustomProviderModelSelectorProps): React.JSX.Element | null {
  const models = getLaunchableCustomProviderModels(provider.models)
  const selection = resolveCustomProviderModelSelection(provider, value?.modelID, value?.variant)
  if (!selection) return null

  const { model: currentModel, effort: currentEffort } = selection

  const selectModel = (slug: string, variant?: string | null): void => {
    const next = resolveCustomProviderModelSelection(provider, slug, variant)
    if (!next) return
    onChange({
      providerID: CUSTOM_MODEL_PROVIDER_ID,
      modelID: next.model.slug.trim(),
      variant: next.effort ?? undefined
    })
  }

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
          aria-label={`Current model: ${getCustomProviderModelDisplayName(currentModel)}. Click to change model`}
          data-testid={testIdPrefix}
        >
          <span className="truncate max-w-[140px]">
            {getCustomProviderModelDisplayName(currentModel)}
          </span>
          {currentEffort && (
            <span className="text-[10px] font-semibold uppercase text-primary">
              {currentEffort}
            </span>
          )}
          <ChevronDown className="h-3 w-3 shrink-0 opacity-50" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-72 max-h-80 overflow-y-auto">
        <DropdownMenuLabel className="text-xs text-muted-foreground">
          {provider.name || 'Custom Provider'}
        </DropdownMenuLabel>
        {models.map((model) => {
          const active = model.slug.trim() === currentModel.slug.trim()
          return (
            <div key={model.id}>
              <DropdownMenuItem
                onClick={() => selectModel(model.slug)}
                className="flex items-center justify-between gap-2 cursor-pointer"
                data-testid={`${testIdPrefix}-model-${model.slug.trim()}`}
              >
                <span className="truncate text-sm">{getCustomProviderModelDisplayName(model)}</span>
                {active && <Check className="h-4 w-4 shrink-0 text-primary" />}
              </DropdownMenuItem>
              {model.efforts.length > 0 && (
                <div className="flex flex-wrap gap-1 pl-6 pb-1">
                  {model.efforts.map((effort) => {
                    const activeEffort = active && currentEffort === effort
                    return (
                      <button
                        key={effort}
                        className={cn(
                          'text-[10px] px-1.5 py-0.5 rounded',
                          activeEffort
                            ? 'bg-primary text-primary-foreground'
                            : 'bg-muted text-muted-foreground hover:bg-accent'
                        )}
                        onClick={(e) => {
                          e.stopPropagation()
                          selectModel(model.slug, effort)
                        }}
                        data-testid={`${testIdPrefix}-effort-${model.slug.trim()}-${effort}`}
                      >
                        {effort.toUpperCase()}
                      </button>
                    )
                  })}
                </div>
              )}
            </div>
          )
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
