import { Plus, Trash2 } from 'lucide-react'
import { useSettingsStore } from '@/stores/useSettingsStore'
import {
  CUSTOM_PROVIDER_EFFORTS,
  type CustomClaudeProvider,
  type CustomProviderModel,
  type CustomProviderUsage
} from '@shared/types/custom-provider'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'
import { toast } from '@/lib/toast'

const USAGE_OPTIONS: Array<{ value: CustomProviderUsage; label: string }> = [
  { value: 'none', label: 'None' },
  { value: 'claude', label: 'Claude' },
  { value: 'openai', label: 'OpenAI' }
]

export function SettingsCustomProviders(): React.JSX.Element {
  const { customProviders: rawProviders, updateSetting } = useSettingsStore()
  const providers = rawProviders ?? []

  const handleAdd = (): void => {
    const provider: CustomClaudeProvider = {
      id: crypto.randomUUID(),
      name: '',
      command: '',
      usageProvider: 'none',
      models: []
    }
    updateSetting('customProviders', [...providers, provider])
  }

  const handleRemove = (id: string): void => {
    updateSetting(
      'customProviders',
      providers.filter((p) => p.id !== id)
    )
    toast.success('Provider removed')
  }

  const handleChange = (id: string, patch: Partial<CustomClaudeProvider>): void => {
    updateSetting(
      'customProviders',
      providers.map((p) => (p.id === id ? { ...p, ...patch } : p))
    )
  }

  const handleModelAdd = (provider: CustomClaudeProvider): void => {
    handleChange(provider.id, {
      models: [
        ...(provider.models ?? []),
        { id: crypto.randomUUID(), name: '', slug: '', efforts: [] }
      ]
    })
  }

  const handleModelChange = (
    provider: CustomClaudeProvider,
    modelId: string,
    patch: Partial<CustomProviderModel>
  ): void => {
    handleChange(provider.id, {
      models: (provider.models ?? []).map((m) => (m.id === modelId ? { ...m, ...patch } : m))
    })
  }

  const handleModelRemove = (provider: CustomClaudeProvider, modelId: string): void => {
    handleChange(provider.id, {
      models: (provider.models ?? []).filter((m) => m.id !== modelId)
    })
  }

  return (
    <div className="space-y-6">
      <div>
        <h3 className="text-base font-medium mb-1">Custom Providers</h3>
        <p className="text-sm text-muted-foreground">
          Run Claude Code through a custom command — an alias, wrapper script, or full command line
          (e.g. one that points ANTHROPIC_BASE_URL at a proxy to use other models). Custom providers
          appear alongside Claude Code CLI when creating sessions and launching tickets.
        </p>
      </div>

      <div className="space-y-4">
        {providers.map((provider) => (
          <div
            key={provider.id}
            className="rounded-lg border p-4 space-y-3"
            data-testid={`custom-provider-${provider.id}`}
          >
            <div className="flex items-start gap-2">
              <div className="flex-1 space-y-3">
                <div>
                  <label className="text-xs font-medium text-muted-foreground">Name</label>
                  <Input
                    value={provider.name}
                    onChange={(e) => handleChange(provider.id, { name: e.target.value })}
                    placeholder="e.g. Claudex (GPT via proxy)"
                    className="mt-1"
                    data-testid="custom-provider-name"
                  />
                </div>
                <div>
                  <label className="text-xs font-medium text-muted-foreground">Command</label>
                  <Input
                    value={provider.command}
                    onChange={(e) => handleChange(provider.id, { command: e.target.value })}
                    placeholder="e.g. claudex"
                    className="mt-1 font-mono"
                    data-testid="custom-provider-command"
                  />
                  {provider.command.trim() === '' && (
                    <p className="text-xs text-destructive mt-1">
                      Required — the provider is hidden from pickers until a command is set.
                    </p>
                  )}
                  <p className="text-xs text-muted-foreground mt-1">
                    Runs through your login shell, so aliases and functions from your shell config
                    work. Hive appends its own flags (hooks, resume, permission mode) after the
                    command.
                  </p>
                </div>
                <div>
                  <label className="text-xs font-medium text-muted-foreground">
                    Count usage against
                  </label>
                  <div className="flex gap-1 mt-1">
                    {USAGE_OPTIONS.map((option) => (
                      <button
                        key={option.value}
                        onClick={() => handleChange(provider.id, { usageProvider: option.value })}
                        className={cn(
                          'px-3 py-1 rounded-md text-xs border transition-colors',
                          provider.usageProvider === option.value
                            ? 'bg-accent text-accent-foreground border-accent'
                            : 'text-muted-foreground hover:bg-accent/50'
                        )}
                        data-testid={`custom-provider-usage-${option.value}`}
                      >
                        {option.label}
                      </button>
                    ))}
                  </div>
                  <p className="text-xs text-muted-foreground mt-1">
                    Which account&apos;s usage to refresh when this provider finishes a turn.
                  </p>
                </div>
                <div>
                  <label className="text-xs font-medium text-muted-foreground">Models</label>
                  <p className="text-xs text-muted-foreground mt-1">
                    Optional. Declare the models this provider serves — session pickers then offer
                    them, and Hive passes the selection as{' '}
                    <span className="font-mono">--model</span> /{' '}
                    <span className="font-mono">--effort</span> after the command. Leave empty to
                    let the command decide the model.
                  </p>
                  <div className="space-y-2 mt-2">
                    {(provider.models ?? []).map((model) => {
                      const slugValue = model.slug.trim()
                      const duplicateSlug =
                        slugValue !== '' &&
                        (provider.models ?? []).some(
                          (other) => other.id !== model.id && other.slug.trim() === slugValue
                        )
                      return (
                        <div
                          key={model.id}
                          className="rounded-md border p-2 space-y-2"
                          data-testid={`custom-provider-model-${model.id}`}
                        >
                          <div className="flex items-center gap-2">
                            <Input
                              value={model.name}
                              onChange={(e) =>
                                handleModelChange(provider, model.id, { name: e.target.value })
                              }
                              placeholder="Name — e.g. GLM 4.6"
                              className="h-8"
                              data-testid={`custom-provider-model-name-${model.id}`}
                            />
                            <Input
                              value={model.slug}
                              onChange={(e) =>
                                handleModelChange(provider, model.id, { slug: e.target.value })
                              }
                              placeholder="Slug — e.g. glm-4.6"
                              className="h-8 font-mono"
                              data-testid={`custom-provider-model-slug-${model.id}`}
                            />
                            <Button
                              variant="ghost"
                              size="icon"
                              onClick={() => handleModelRemove(provider, model.id)}
                              className="text-muted-foreground hover:text-destructive shrink-0 h-8 w-8"
                              data-testid={`custom-provider-model-remove-${model.id}`}
                            >
                              <Trash2 className="h-3.5 w-3.5" />
                            </Button>
                          </div>
                          {slugValue === '' && (
                            <p className="text-xs text-destructive">
                              Slug required — the model is ignored until one is set. It is passed
                              verbatim as <span className="font-mono">--model</span>.
                            </p>
                          )}
                          {duplicateSlug && (
                            <p className="text-xs text-destructive">
                              Duplicate slug — another model of this provider already uses it.
                            </p>
                          )}
                          <div className="flex items-center gap-1 flex-wrap">
                            <span className="text-[10px] uppercase tracking-wide text-muted-foreground mr-1">
                              Efforts
                            </span>
                            {CUSTOM_PROVIDER_EFFORTS.map((effort) => {
                              const active = model.efforts.includes(effort)
                              return (
                                <button
                                  key={effort}
                                  role="checkbox"
                                  aria-checked={active}
                                  onClick={() => {
                                    const next = new Set(model.efforts)
                                    if (active) next.delete(effort)
                                    else next.add(effort)
                                    handleModelChange(provider, model.id, {
                                      efforts: CUSTOM_PROVIDER_EFFORTS.filter((e) => next.has(e))
                                    })
                                  }}
                                  className={cn(
                                    'px-2 py-0.5 rounded-md text-xs border transition-colors',
                                    active
                                      ? 'bg-accent text-accent-foreground border-accent'
                                      : 'text-muted-foreground hover:bg-accent/50'
                                  )}
                                  data-testid={`custom-provider-model-effort-${model.id}-${effort}`}
                                >
                                  {effort}
                                </button>
                              )
                            })}
                          </div>
                        </div>
                      )
                    })}
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => handleModelAdd(provider)}
                      data-testid="custom-provider-model-add"
                    >
                      <Plus className="h-4 w-4 mr-1" />
                      Add Model
                    </Button>
                  </div>
                </div>
              </div>
              <Button
                variant="ghost"
                size="icon"
                onClick={() => handleRemove(provider.id)}
                className="text-muted-foreground hover:text-destructive shrink-0"
                data-testid="custom-provider-remove"
              >
                <Trash2 className="h-4 w-4" />
              </Button>
            </div>
          </div>
        ))}

        <Button variant="outline" size="sm" onClick={handleAdd} data-testid="custom-provider-add">
          <Plus className="h-4 w-4 mr-1" />
          Add Provider
        </Button>
      </div>
    </div>
  )
}
