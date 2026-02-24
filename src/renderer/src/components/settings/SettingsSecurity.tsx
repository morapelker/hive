import { useState } from 'react'
import { useSettingsStore } from '@/stores/useSettingsStore'
import { Trash2, Plus, Info } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { toast } from '@/lib/toast'

export function SettingsSecurity(): React.JSX.Element {
  const { commandFilter, updateSetting } = useSettingsStore()
  const [newPattern, setNewPattern] = useState('')
  const [activeTab, setActiveTab] = useState<'allowlist' | 'blocklist'>('allowlist')

  const handleToggleEnabled = () => {
    updateSetting('commandFilter', {
      ...commandFilter,
      enabled: !commandFilter.enabled
    })
  }

  const handleSetDefaultBehavior = (behavior: 'ask' | 'allow' | 'block') => {
    updateSetting('commandFilter', {
      ...commandFilter,
      defaultBehavior: behavior
    })
  }

  const handleAddPattern = () => {
    const pattern = newPattern.trim()
    if (!pattern) {
      toast.error('Pattern cannot be empty')
      return
    }

    const list = activeTab === 'allowlist' ? commandFilter.allowlist : commandFilter.blocklist

    if (list.includes(pattern)) {
      toast.error('Pattern already exists in this list')
      return
    }

    const updated =
      activeTab === 'allowlist'
        ? { ...commandFilter, allowlist: [...commandFilter.allowlist, pattern] }
        : { ...commandFilter, blocklist: [...commandFilter.blocklist, pattern] }

    updateSetting('commandFilter', updated)
    setNewPattern('')
    toast.success(`Pattern added to ${activeTab}`)
  }

  const handleRemovePattern = (pattern: string, listType: 'allowlist' | 'blocklist') => {
    const updated =
      listType === 'allowlist'
        ? {
            ...commandFilter,
            allowlist: commandFilter.allowlist.filter((p) => p !== pattern)
          }
        : {
            ...commandFilter,
            blocklist: commandFilter.blocklist.filter((p) => p !== pattern)
          }

    updateSetting('commandFilter', updated)
    toast.success(`Pattern removed from ${listType}`)
  }

  return (
    <div className="space-y-6">
      <div>
        <h3 className="text-base font-medium mb-1">Security</h3>
        <p className="text-sm text-muted-foreground">Control which commands Claude can execute</p>
      </div>

      {/* Enable/Disable */}
      <div className="flex items-center justify-between">
        <div>
          <label className="text-sm font-medium">Enable command filtering</label>
          <p className="text-xs text-muted-foreground">
            Control which tools and commands Claude can use during sessions
          </p>
        </div>
        <button
          role="switch"
          aria-checked={commandFilter.enabled}
          onClick={handleToggleEnabled}
          className={cn(
            'relative inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors',
            commandFilter.enabled ? 'bg-primary' : 'bg-muted'
          )}
          data-testid="command-filter-toggle"
        >
          <span
            className={cn(
              'pointer-events-none block h-4 w-4 rounded-full bg-background shadow-lg ring-0 transition-transform',
              commandFilter.enabled ? 'translate-x-4' : 'translate-x-0'
            )}
          />
        </button>
      </div>

      {/* Default Behavior */}
      <div className={cn('space-y-2', !commandFilter.enabled && 'opacity-50 pointer-events-none')}>
        <label className="text-sm font-medium">Default behavior for unlisted commands</label>
        <p className="text-xs text-muted-foreground">
          How to handle commands not on either list
        </p>
        <div className="flex gap-2">
          <button
            onClick={() => handleSetDefaultBehavior('ask')}
            disabled={!commandFilter.enabled}
            className={cn(
              'px-3 py-1.5 rounded-md text-sm border transition-colors',
              commandFilter.defaultBehavior === 'ask'
                ? 'bg-primary text-primary-foreground border-primary'
                : 'bg-muted/50 text-muted-foreground border-border hover:bg-accent/50'
            )}
            data-testid="default-behavior-ask"
          >
            Ask for approval
          </button>
          <button
            onClick={() => handleSetDefaultBehavior('allow')}
            disabled={!commandFilter.enabled}
            className={cn(
              'px-3 py-1.5 rounded-md text-sm border transition-colors',
              commandFilter.defaultBehavior === 'allow'
                ? 'bg-primary text-primary-foreground border-primary'
                : 'bg-muted/50 text-muted-foreground border-border hover:bg-accent/50'
            )}
            data-testid="default-behavior-allow"
          >
            Allow silently
          </button>
          <button
            onClick={() => handleSetDefaultBehavior('block')}
            disabled={!commandFilter.enabled}
            className={cn(
              'px-3 py-1.5 rounded-md text-sm border transition-colors',
              commandFilter.defaultBehavior === 'block'
                ? 'bg-primary text-primary-foreground border-primary'
                : 'bg-muted/50 text-muted-foreground border-border hover:bg-accent/50'
            )}
            data-testid="default-behavior-block"
          >
            Block silently
          </button>
        </div>
      </div>

      {/* Info box */}
      <div
        className={cn(
          'rounded-md border border-border bg-muted/30 p-3',
          !commandFilter.enabled && 'opacity-50'
        )}
      >
        <div className="flex gap-2">
          <Info className="h-4 w-4 text-muted-foreground mt-0.5 shrink-0" />
          <div className="text-xs text-muted-foreground space-y-1">
            <p className="font-medium text-foreground">Pattern matching with wildcards:</p>
            <ul className="list-disc list-inside space-y-0.5">
              <li>
                <code className="text-xs bg-muted px-1 py-0.5 rounded">*</code> matches any sequence
                except /
              </li>
              <li>
                <code className="text-xs bg-muted px-1 py-0.5 rounded">**</code> matches any
                sequence including /
              </li>
              <li>
                Example: <code className="text-xs bg-muted px-1 py-0.5 rounded">bash: npm *</code>{' '}
                matches all npm commands
              </li>
              <li>
                Example: <code className="text-xs bg-muted px-1 py-0.5 rounded">read: src/**</code>{' '}
                matches any file in src/
              </li>
            </ul>
          </div>
        </div>
      </div>

      {/* Priority note */}
      <div
        className={cn(
          'rounded-md border border-border bg-muted/30 p-3',
          !commandFilter.enabled && 'opacity-50'
        )}
      >
        <p className="text-xs text-muted-foreground">
          <span className="font-medium text-foreground">Priority:</span> Blocklist takes precedence
          over allowlist. If a command matches both, it will be blocked.
        </p>
      </div>

      {/* Tabs */}
      <div className={cn('space-y-3', !commandFilter.enabled && 'opacity-50 pointer-events-none')}>
        <div className="flex gap-2 border-b border-border">
          <button
            onClick={() => setActiveTab('allowlist')}
            disabled={!commandFilter.enabled}
            className={cn(
              'px-3 py-1.5 text-sm font-medium transition-colors border-b-2',
              activeTab === 'allowlist'
                ? 'border-primary text-foreground'
                : 'border-transparent text-muted-foreground hover:text-foreground'
            )}
          >
            Allowlist ({commandFilter.allowlist.length})
          </button>
          <button
            onClick={() => setActiveTab('blocklist')}
            disabled={!commandFilter.enabled}
            className={cn(
              'px-3 py-1.5 text-sm font-medium transition-colors border-b-2',
              activeTab === 'blocklist'
                ? 'border-primary text-foreground'
                : 'border-transparent text-muted-foreground hover:text-foreground'
            )}
          >
            Blocklist ({commandFilter.blocklist.length})
          </button>
        </div>

        {/* Add pattern input */}
        <div className="flex gap-2">
          <input
            type="text"
            value={newPattern}
            onChange={(e) => setNewPattern(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && commandFilter.enabled) {
                handleAddPattern()
              }
            }}
            disabled={!commandFilter.enabled}
            placeholder={
              activeTab === 'allowlist'
                ? 'e.g., bash: git status or read: src/**'
                : 'e.g., bash: rm -rf * or edit: .env'
            }
            className="flex-1 px-3 py-1.5 text-sm rounded-md border border-border bg-background"
            data-testid="pattern-input"
          />
          <Button
            size="sm"
            onClick={handleAddPattern}
            disabled={!newPattern.trim() || !commandFilter.enabled}
            data-testid="add-pattern-button"
          >
            <Plus className="h-3.5 w-3.5 mr-1" />
            Add
          </Button>
        </div>

        {/* Pattern list with scrolling */}
        <div className="space-y-2 max-h-48 overflow-y-auto pr-1">
          {activeTab === 'allowlist' && commandFilter.allowlist.length === 0 && (
            <div className="text-xs text-muted-foreground text-center py-4">
              No patterns in allowlist. Commands will follow the default behavior.
            </div>
          )}
          {activeTab === 'blocklist' && commandFilter.blocklist.length === 0 && (
            <div className="text-xs text-muted-foreground text-center py-4">
              No patterns in blocklist. Default dangerous patterns are included on first launch.
            </div>
          )}
          {activeTab === 'allowlist' &&
            commandFilter.allowlist.map((pattern) => (
              <div
                key={pattern}
                className="flex items-center justify-between px-3 py-2 rounded-md border border-border bg-muted/30"
              >
                <code className="text-xs font-mono">{pattern}</code>
                <button
                  onClick={() => handleRemovePattern(pattern, 'allowlist')}
                  disabled={!commandFilter.enabled}
                  className="text-destructive hover:text-destructive/80 transition-colors"
                  title="Remove pattern"
                  data-testid="remove-allowlist-pattern"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </div>
            ))}
          {activeTab === 'blocklist' &&
            commandFilter.blocklist.map((pattern) => (
              <div
                key={pattern}
                className="flex items-center justify-between px-3 py-2 rounded-md border border-border bg-muted/30"
              >
                <code className="text-xs font-mono">{pattern}</code>
                <button
                  onClick={() => handleRemovePattern(pattern, 'blocklist')}
                  disabled={!commandFilter.enabled}
                  className="text-destructive hover:text-destructive/80 transition-colors"
                  title="Remove pattern"
                  data-testid="remove-blocklist-pattern"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </div>
            ))}
        </div>
      </div>
    </div>
  )
}
