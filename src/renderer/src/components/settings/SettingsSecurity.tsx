import { useState, useMemo } from 'react'
import { useSettingsStore } from '@/stores/useSettingsStore'
import { Trash2, Plus, Info, Search, X } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { toast } from '@/lib/toast'
import { useI18n } from '@/i18n/useI18n'

export function SettingsSecurity(): React.JSX.Element {
  const { commandFilter: rawCommandFilter, updateSetting } = useSettingsStore()
  const [newPattern, setNewPattern] = useState('')
  const [activeTab, setActiveTab] = useState<'allowlist' | 'blocklist'>('allowlist')
  const [searchQuery, setSearchQuery] = useState('')
  const { t } = useI18n()

  // Defensive null-guard: commandFilter may be undefined on first hydration from old localStorage
  const commandFilter = rawCommandFilter ?? {
    enabled: true,
    defaultBehavior: 'ask' as const,
    allowlist: [],
    blocklist: []
  }

  const isEnabled = commandFilter.enabled ?? true
  const activeTabLabel =
    activeTab === 'allowlist'
      ? t('settings.security.tabs.allowlist')
      : t('settings.security.tabs.blocklist')

  // Filter patterns based on search query
  const filteredAllowlist = useMemo(() => {
    if (!searchQuery) return commandFilter.allowlist
    const query = searchQuery.toLowerCase()
    return commandFilter.allowlist.filter((pattern) => pattern.toLowerCase().includes(query))
  }, [commandFilter.allowlist, searchQuery])

  const filteredBlocklist = useMemo(() => {
    if (!searchQuery) return commandFilter.blocklist
    const query = searchQuery.toLowerCase()
    return commandFilter.blocklist.filter((pattern) => pattern.toLowerCase().includes(query))
  }, [commandFilter.blocklist, searchQuery])

  const handleToggleEnabled = () => {
    updateSetting('commandFilter', {
      ...commandFilter,
      enabled: !isEnabled
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
      toast.error(t('settings.security.pattern.empty'))
      return
    }

    const list = activeTab === 'allowlist' ? commandFilter.allowlist : commandFilter.blocklist

    if (list.includes(pattern)) {
      toast.error(t('settings.security.pattern.duplicate'))
      return
    }

    const updated =
      activeTab === 'allowlist'
        ? { ...commandFilter, allowlist: [...commandFilter.allowlist, pattern] }
        : { ...commandFilter, blocklist: [...commandFilter.blocklist, pattern] }

    updateSetting('commandFilter', updated)
    setNewPattern('')
    toast.success(t('settings.security.pattern.added', { list: activeTabLabel }))
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
    toast.success(
      t('settings.security.pattern.removed', {
        list:
          listType === 'allowlist'
            ? t('settings.security.tabs.allowlist')
            : t('settings.security.tabs.blocklist')
      })
    )
  }

  return (
    <div className="space-y-6" style={{ overflow: 'hidden' }}>
      <div>
        <h3 className="text-base font-medium mb-1">{t('settings.security.title')}</h3>
        <p className="text-sm text-muted-foreground">{t('settings.security.description')}</p>
      </div>

      {/* Enable/Disable */}
      <div className="flex items-center justify-between">
        <div>
          <label className="text-sm font-medium">{t('settings.security.enable.label')}</label>
          <p className="text-xs text-muted-foreground">
            {t('settings.security.enable.description')}
          </p>
        </div>
        <button
          role="switch"
          aria-checked={isEnabled}
          onClick={handleToggleEnabled}
          style={{
            position: 'relative',
            display: 'inline-flex',
            alignItems: 'center',
            height: '24px',
            width: '44px',
            flexShrink: 0,
            cursor: 'pointer',
            borderRadius: '9999px',
            border: 'none',
            backgroundColor: isEnabled ? '#059669' : '#52525b',
            transition: 'background-color 200ms'
          }}
          data-testid="command-filter-toggle"
        >
          <span
            style={{
              pointerEvents: 'none',
              display: 'block',
              height: '18px',
              width: '18px',
              borderRadius: '9999px',
              backgroundColor: '#ffffff',
              boxShadow: '0 1px 2px rgba(0,0,0,0.2)',
              transition: 'transform 200ms',
              transform: isEnabled ? 'translateX(23px)' : 'translateX(3px)'
            }}
          />
        </button>
      </div>

      {/* Default Behavior */}
      <div className={cn('space-y-2', !isEnabled && 'opacity-50 pointer-events-none')}>
        <label className="text-sm font-medium">
          {t('settings.security.defaultBehavior.label')}
        </label>
        <p className="text-xs text-muted-foreground">
          {t('settings.security.defaultBehavior.description')}
        </p>
        <div className="flex gap-2">
          <button
            onClick={() => handleSetDefaultBehavior('ask')}
            disabled={!isEnabled}
            className={cn(
              'px-3 py-1.5 rounded-md text-sm border transition-colors',
              commandFilter.defaultBehavior === 'ask'
                ? 'bg-primary text-primary-foreground border-primary'
                : 'bg-muted/50 text-muted-foreground border-border hover:bg-accent/50'
            )}
            data-testid="default-behavior-ask"
          >
            {t('settings.security.defaultBehavior.ask')}
          </button>
          <button
            onClick={() => handleSetDefaultBehavior('allow')}
            disabled={!isEnabled}
            className={cn(
              'px-3 py-1.5 rounded-md text-sm border transition-colors',
              commandFilter.defaultBehavior === 'allow'
                ? 'bg-primary text-primary-foreground border-primary'
                : 'bg-muted/50 text-muted-foreground border-border hover:bg-accent/50'
            )}
            data-testid="default-behavior-allow"
          >
            {t('settings.security.defaultBehavior.allow')}
          </button>
          <button
            onClick={() => handleSetDefaultBehavior('block')}
            disabled={!isEnabled}
            className={cn(
              'px-3 py-1.5 rounded-md text-sm border transition-colors',
              commandFilter.defaultBehavior === 'block'
                ? 'bg-primary text-primary-foreground border-primary'
                : 'bg-muted/50 text-muted-foreground border-border hover:bg-accent/50'
            )}
            data-testid="default-behavior-block"
          >
            {t('settings.security.defaultBehavior.block')}
          </button>
        </div>
      </div>

      {/* Info box */}
      <div
        className={cn(
          'rounded-md border border-border bg-muted/30 p-3',
          !isEnabled && 'opacity-50'
        )}
      >
        <div className="flex gap-2">
          <Info className="h-4 w-4 text-muted-foreground mt-0.5 shrink-0" />
          <div className="text-xs text-muted-foreground space-y-1">
            <p className="font-medium text-foreground">{t('settings.security.info.title')}</p>
            <ul className="list-disc list-inside space-y-0.5">
              <li>{t('settings.security.info.single')}</li>
              <li>{t('settings.security.info.double')}</li>
              <li>{t('settings.security.info.exampleBash')}</li>
              <li>{t('settings.security.info.exampleRead')}</li>
            </ul>
          </div>
        </div>
      </div>

      {/* Priority note */}
      <div
        className={cn(
          'rounded-md border border-border bg-muted/30 p-3',
          !isEnabled && 'opacity-50'
        )}
      >
        <p className="text-xs text-muted-foreground">
          <span className="font-medium text-foreground">
            {t('settings.security.priority.title')}
          </span>{' '}
          {t('settings.security.priority.description')}
        </p>
      </div>

      {/* Tabs */}
      <div className={cn('space-y-3', !isEnabled && 'opacity-50 pointer-events-none')}>
        <div className="flex gap-2 border-b border-border">
          <button
            onClick={() => setActiveTab('allowlist')}
            disabled={!isEnabled}
            className={cn(
              'px-3 py-1.5 text-sm font-medium transition-colors border-b-2',
              activeTab === 'allowlist'
                ? 'border-primary text-foreground'
                : 'border-transparent text-muted-foreground hover:text-foreground'
            )}
          >
            {t('settings.security.tabs.allowlist')} ({commandFilter.allowlist.length})
          </button>
          <button
            onClick={() => setActiveTab('blocklist')}
            disabled={!isEnabled}
            className={cn(
              'px-3 py-1.5 text-sm font-medium transition-colors border-b-2',
              activeTab === 'blocklist'
                ? 'border-primary text-foreground'
                : 'border-transparent text-muted-foreground hover:text-foreground'
            )}
          >
            {t('settings.security.tabs.blocklist')} ({commandFilter.blocklist.length})
          </button>
        </div>

        {/* Add pattern input */}
        <div style={{ display: 'flex', gap: '8px', overflow: 'hidden' }}>
          <input
            type="text"
            value={newPattern}
            onChange={(e) => setNewPattern(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && isEnabled) {
                handleAddPattern()
              }
            }}
            disabled={!isEnabled}
            placeholder={
              activeTab === 'allowlist'
                ? t('settings.security.pattern.allowPlaceholder')
                : t('settings.security.pattern.blockPlaceholder')
            }
            style={{ flex: '1 1 0', minWidth: 0 }}
            className="px-3 py-1.5 text-sm rounded-md border border-border bg-background"
            data-testid="pattern-input"
          />
          <Button
            size="sm"
            className="shrink-0"
            onClick={handleAddPattern}
            disabled={!newPattern.trim() || !isEnabled}
            data-testid="add-pattern-button"
          >
            <Plus className="h-3.5 w-3.5 mr-1" />
            {t('settings.security.pattern.add')}
          </Button>
        </div>

        {/* Search input */}
        {(commandFilter.allowlist.length > 0 || commandFilter.blocklist.length > 0) && (
          <div className="flex items-center gap-2">
            <div className="relative flex-1">
              <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground pointer-events-none" />
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder={t('settings.security.pattern.searchPlaceholder')}
                disabled={!isEnabled}
                className="w-full pl-8 pr-8 py-1.5 text-sm rounded-md border border-border bg-background disabled:opacity-50"
                data-testid="pattern-search-input"
              />
              {searchQuery && (
                <button
                  onClick={() => setSearchQuery('')}
                  disabled={!isEnabled}
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground transition-colors"
                  data-testid="clear-search-button"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              )}
            </div>
          </div>
        )}

        {/* Show filtered count when searching */}
        {searchQuery && (
          <div className="text-xs text-muted-foreground">
            {t('settings.security.pattern.showingCount', {
              visible:
                activeTab === 'allowlist' ? filteredAllowlist.length : filteredBlocklist.length,
              total:
                activeTab === 'allowlist'
                  ? commandFilter.allowlist.length
                  : commandFilter.blocklist.length
            })}
          </div>
        )}

        {/* Pattern list with scrolling */}
        <div className="space-y-2 max-h-48 overflow-y-auto" style={{ overflowX: 'hidden' }}>
          {activeTab === 'allowlist' && filteredAllowlist.length === 0 && !searchQuery && (
            <div className="text-xs text-muted-foreground text-center py-4">
              {t('settings.security.pattern.noAllowlist')}
            </div>
          )}
          {activeTab === 'allowlist' && filteredAllowlist.length === 0 && searchQuery && (
            <div className="text-xs text-muted-foreground text-center py-4">
              {t('settings.security.pattern.noAllowlistSearch', { query: searchQuery })}
            </div>
          )}
          {activeTab === 'blocklist' && filteredBlocklist.length === 0 && !searchQuery && (
            <div className="text-xs text-muted-foreground text-center py-4">
              {t('settings.security.pattern.noBlocklist')}
            </div>
          )}
          {activeTab === 'blocklist' && filteredBlocklist.length === 0 && searchQuery && (
            <div className="text-xs text-muted-foreground text-center py-4">
              {t('settings.security.pattern.noBlocklistSearch', { query: searchQuery })}
            </div>
          )}
          {activeTab === 'allowlist' &&
            filteredAllowlist.map((pattern) => (
              <div
                key={pattern}
                className="flex items-center gap-2 px-3 py-2 rounded-md border border-border bg-muted/30"
                style={{ overflow: 'hidden' }}
              >
                <code
                  className="text-xs font-mono"
                  style={{
                    flex: '1 1 0',
                    minWidth: 0,
                    wordBreak: 'break-all',
                    whiteSpace: 'pre-wrap'
                  }}
                  title={pattern}
                >
                  {pattern}
                </code>
                <button
                  onClick={() => handleRemovePattern(pattern, 'allowlist')}
                  disabled={!isEnabled}
                  className="shrink-0 text-destructive hover:text-destructive/80 transition-colors"
                  title={t('settings.security.pattern.removeTitle')}
                  data-testid="remove-allowlist-pattern"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </div>
            ))}
          {activeTab === 'blocklist' &&
            filteredBlocklist.map((pattern) => (
              <div
                key={pattern}
                className="flex items-center gap-2 px-3 py-2 rounded-md border border-border bg-muted/30"
                style={{ overflow: 'hidden' }}
              >
                <code
                  className="text-xs font-mono"
                  style={{
                    flex: '1 1 0',
                    minWidth: 0,
                    wordBreak: 'break-all',
                    whiteSpace: 'pre-wrap'
                  }}
                  title={pattern}
                >
                  {pattern}
                </code>
                <button
                  onClick={() => handleRemovePattern(pattern, 'blocklist')}
                  disabled={!isEnabled}
                  className="shrink-0 text-destructive hover:text-destructive/80 transition-colors"
                  title={t('settings.security.pattern.removeTitle')}
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
