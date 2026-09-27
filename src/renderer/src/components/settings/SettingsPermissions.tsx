import { useCallback, useEffect, useState } from 'react'
import { ExternalLink, RefreshCw, ShieldAlert, ShieldCheck } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { toast } from '@/lib/toast'
import { systemApi } from '@/api/system-api'
import type { MacosPermissionStatus, MacosPrivacyPane } from '@shared/system-types'

/**
 * Re-probe cadence while this section is open. Granting Full Disk Access
 * happens in System Settings, outside the app, so the status has to be
 * polled for the row to flip to "Granted" when the user comes back.
 */
const POLL_INTERVAL_MS = 2000

const PROTECTED_LOCATIONS = [
  'Desktop, Documents and Downloads',
  'External and network drives',
  'iCloud Drive and other synced folders',
  "Other apps' protected data"
]

export function SettingsPermissions(): React.JSX.Element {
  const [status, setStatus] = useState<MacosPermissionStatus | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [checking, setChecking] = useState(false)

  const refresh = useCallback(async (): Promise<void> => {
    try {
      const next = await systemApi.getMacosPermissions()
      setStatus(next)
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }, [])

  useEffect(() => {
    void refresh()
    const timer = window.setInterval(() => {
      void refresh()
    }, POLL_INTERVAL_MS)
    const onFocus = (): void => {
      void refresh()
    }
    window.addEventListener('focus', onFocus)
    return () => {
      window.clearInterval(timer)
      window.removeEventListener('focus', onFocus)
    }
  }, [refresh])

  const handleCheckAgain = async (): Promise<void> => {
    setChecking(true)
    await refresh()
    setTimeout(() => setChecking(false), 400)
  }

  const openPane = async (pane: MacosPrivacyPane): Promise<void> => {
    try {
      const result = await systemApi.openMacosPrivacySettings(pane)
      if (!result.success) {
        toast.error('Could not open System Settings', {
          description: result.error ?? 'Open System Settings › Privacy & Security manually.'
        })
      }
    } catch (err) {
      toast.error('Could not open System Settings', {
        description: err instanceof Error ? err.message : String(err)
      })
    }
  }

  const granted = status?.fullDiskAccess === true

  return (
    <div className="space-y-6">
      <div>
        <h3 className="text-base font-medium mb-1">Permissions</h3>
        <p className="text-sm text-muted-foreground">
          macOS access for the agent sessions and terminals Hive runs
        </p>
      </div>

      {status && !status.supported ? (
        <p className="text-sm text-muted-foreground" data-testid="permissions-unsupported">
          There are no system-level permissions to manage on this platform.
        </p>
      ) : (
        <>
          {/* Full Disk Access */}
          <div className="space-y-3 rounded-md border border-border p-4">
            <div className="flex items-start justify-between gap-4">
              <div className="min-w-0">
                <label className="text-sm font-medium">Full Disk Access</label>
                <p className="text-xs text-muted-foreground mt-0.5">
                  Optional access to all protected files, including other apps’ data.
                </p>
              </div>
              <span
                className={cn(
                  'inline-flex shrink-0 items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium',
                  status === null
                    ? 'border-border text-muted-foreground'
                    : granted
                      ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400'
                      : 'border-amber-500/40 bg-amber-500/10 text-amber-600 dark:text-amber-400'
                )}
                data-testid="permissions-fda-status"
              >
                {status === null ? (
                  'Checking…'
                ) : granted ? (
                  <>
                    <ShieldCheck className="h-3 w-3" /> Granted
                  </>
                ) : (
                  <>
                    <ShieldAlert className="h-3 w-3" /> Not granted
                  </>
                )}
              </span>
            </div>

            <p className="text-xs text-muted-foreground">
              Claude Code, Codex and the terminal run inside Hive, so macOS treats every file
              they touch as Hive touching it. Access to these locations may prompt:
            </p>
            <ul className="list-disc pl-5 text-xs text-muted-foreground space-y-0.5">
              {PROTECTED_LOCATIONS.map((location) => (
                <li key={location}>{location}</li>
              ))}
            </ul>
            <p className="text-xs text-muted-foreground">
              For &ldquo;data from other apps&rdquo;, Allow lasts only until Hive quits.
              macOS can ask again after relaunch even if you previously allowed it. Avoiding those
              files avoids that prompt. Full Disk Access covers these file-access categories at
              once: open System Settings, turn on <strong>Hive</strong> in the Full Disk
              Access list (use <strong>+</strong> and pick it from Applications if it is not
              listed), then restart Hive.
            </p>

            <div className="flex flex-wrap gap-2 pt-1">
              <Button
                size="sm"
                onClick={() => void openPane('fullDiskAccess')}
                data-testid="permissions-open-fda"
              >
                <ExternalLink className="h-3.5 w-3.5 mr-1.5" />
                Open System Settings
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => void handleCheckAgain()}
                disabled={checking}
                data-testid="permissions-check-again"
              >
                <RefreshCw className={cn('h-3.5 w-3.5 mr-1.5', checking && 'animate-spin')} />
                Check again
              </Button>
            </div>
            {error && (
              <p className="text-xs text-destructive" data-testid="permissions-error">
                Could not read the permission state: {error}
              </p>
            )}
          </div>

          {/* Per-folder answers */}
          <div className="space-y-2">
            <label className="text-sm font-medium">Folder-by-folder access</label>
            <p className="text-xs text-muted-foreground">
              macOS remembers ordinary folder grants separately from temporary access to other apps’
              data. If a session cannot see a folder, review its grant under Files and Folders.
            </p>
            <Button
              variant="outline"
              size="sm"
              onClick={() => void openPane('filesAndFolders')}
              data-testid="permissions-open-files-and-folders"
            >
              <ExternalLink className="h-3.5 w-3.5 mr-1.5" />
              Open Files and Folders
            </Button>
          </div>

          <p className="text-xs text-muted-foreground pt-4 border-t">
            macOS keeps a separate answer for every app, so the packaged Hive needs its own grant,
            and a development checkout prompts as &ldquo;Electron&rdquo; or as the terminal it was
            started from.
          </p>
        </>
      )}
    </div>
  )
}
