import { useState, useEffect } from 'react'
import { useSettingsStore } from '@/stores/useSettingsStore'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { RefreshCw } from 'lucide-react'

export function SettingsUpdates(): React.JSX.Element {
  const { updateChannel, updateSetting } = useSettingsStore()
  const [version, setVersion] = useState('')
  const [checking, setChecking] = useState(false)

  useEffect(() => {
    window.updaterOps
      ?.getVersion()
      .then(setVersion)
      .catch(() => {})
  }, [])

  const handleCheckForUpdates = async (): Promise<void> => {
    setChecking(true)
    try {
      await window.updaterOps?.checkForUpdate()
    } catch {
      /* ignored */
    }
    setTimeout(() => setChecking(false), 2000)
  }

  return (
    <div className="space-y-6">
      <div>
        <h3 className="text-base font-medium mb-1">Updates</h3>
        <p className="text-sm text-muted-foreground">Manage how Hive updates itself</p>
      </div>

      {/* Version display */}
      {version && (
        <div className="text-sm text-muted-foreground">
          Current version: <span className="font-mono text-foreground">{version}</span>
        </div>
      )}

      {/* Channel selector */}
      <div className="space-y-2">
        <label className="text-sm font-medium">Update Channel</label>
        <p className="text-xs text-muted-foreground">
          Choose which release channel to receive updates from
        </p>
        <div className="flex gap-2">
          <button
            onClick={() => updateSetting('updateChannel', 'stable')}
            className={cn(
              'px-3 py-1.5 rounded-md text-sm border transition-colors',
              updateChannel === 'stable'
                ? 'bg-primary text-primary-foreground border-primary'
                : 'bg-muted/50 text-muted-foreground border-border hover:bg-accent/50'
            )}
            data-testid="update-channel-stable"
          >
            Stable
          </button>
          <button
            onClick={() => updateSetting('updateChannel', 'canary')}
            className={cn(
              'px-3 py-1.5 rounded-md text-sm border transition-colors',
              updateChannel === 'canary'
                ? 'bg-primary text-primary-foreground border-primary'
                : 'bg-muted/50 text-muted-foreground border-border hover:bg-accent/50'
            )}
            data-testid="update-channel-canary"
          >
            Canary
          </button>
        </div>
        <p className="text-xs text-muted-foreground">
          {updateChannel === 'canary'
            ? 'You will receive early builds with the latest features. These may contain bugs.'
            : 'You will receive stable, tested releases.'}
        </p>
      </div>

      {/* Check for updates */}
      <div className="pt-4 border-t">
        <Button
          variant="outline"
          size="sm"
          onClick={handleCheckForUpdates}
          disabled={checking}
          data-testid="check-for-updates"
        >
          <RefreshCw className={cn('h-3.5 w-3.5 mr-1.5', checking && 'animate-spin')} />
          {checking ? 'Checking...' : 'Check for Updates'}
        </Button>
      </div>
    </div>
  )
}
