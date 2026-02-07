import { useSettingsStore } from '@/stores/useSettingsStore'
import { Textarea } from '@/components/ui/textarea'
import { Input } from '@/components/ui/input'

export function SettingsGit(): React.JSX.Element {
  const { commitTemplate, autoFetchInterval, updateSetting } = useSettingsStore()

  return (
    <div className="space-y-6">
      <div>
        <h3 className="text-base font-medium mb-1">Git</h3>
        <p className="text-sm text-muted-foreground">Configure git-related settings</p>
      </div>

      {/* Commit template */}
      <div className="space-y-2">
        <label className="text-sm font-medium">Commit Message Template</label>
        <Textarea
          value={commitTemplate}
          onChange={(e) => updateSetting('commitTemplate', e.target.value)}
          placeholder="e.g., feat: "
          rows={3}
          className="font-mono text-sm resize-none"
          data-testid="commit-template"
        />
        <p className="text-xs text-muted-foreground">
          Pre-fill the commit message with this template when starting a new commit.
        </p>
      </div>

      {/* Auto-fetch interval */}
      <div className="space-y-2">
        <label className="text-sm font-medium">Auto-fetch Interval (minutes)</label>
        <div className="flex items-center gap-3">
          <Input
            type="number"
            min={0}
            max={60}
            value={autoFetchInterval}
            onChange={(e) => {
              const val = parseInt(e.target.value, 10)
              if (!isNaN(val) && val >= 0 && val <= 60) {
                updateSetting('autoFetchInterval', val)
              }
            }}
            className="w-24"
            data-testid="auto-fetch-interval"
          />
          <span className="text-xs text-muted-foreground">
            {autoFetchInterval === 0 ? 'Disabled' : `Every ${autoFetchInterval} minute${autoFetchInterval > 1 ? 's' : ''}`}
          </span>
        </div>
        <p className="text-xs text-muted-foreground">
          Set to 0 to disable. When enabled, automatically fetches from remote at the specified interval.
        </p>
      </div>
    </div>
  )
}
