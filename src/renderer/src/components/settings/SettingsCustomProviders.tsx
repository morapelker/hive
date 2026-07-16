import { Plus, Trash2 } from 'lucide-react'
import { useSettingsStore } from '@/stores/useSettingsStore'
import type { CustomClaudeProvider, CustomProviderUsage } from '@shared/types/custom-provider'
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
      usageProvider: 'none'
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
