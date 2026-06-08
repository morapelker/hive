import { useState } from 'react'
import { Building2, LogIn, RefreshCw } from 'lucide-react'
import { DEFAULT_HIVE_ENTERPRISE_SERVER_URL } from '@shared/types/settings'
import { useSettingsStore } from '@/stores/useSettingsStore'
import { completeHiveEnterpriseLogin, fetchHiveEnterpriseMe } from '@/api/hive-enterprise/client'
import { toast } from '@/lib/toast'

export function SettingsHiveEnterprise(): React.JSX.Element {
  const {
    hiveEnterpriseServerUrl,
    hiveLoggedInEmail,
    hiveOrganizationName,
    hiveOrganizationId,
    updateSetting,
    updateSettings
  } = useSettingsStore()
  const [isSigningIn, setIsSigningIn] = useState(false)
  const [isRefreshing, setIsRefreshing] = useState(false)

  const refreshMe = async (): Promise<void> => {
    setIsRefreshing(true)
    try {
      const me = await fetchHiveEnterpriseMe()
      await updateSettings({
        hiveLoggedInEmail: me?.email ?? null,
        hiveOrganizationId: me?.organization?.id ?? null,
        hiveOrganizationName: me?.organization?.name ?? null
      })
      toast.success('Hive Enterprise account refreshed')
    } catch (error) {
      console.error('[HiveEnterprise] refresh failed:', error)
      toast.error('Failed to refresh Hive Enterprise account')
    } finally {
      setIsRefreshing(false)
    }
  }

  const signIn = async (): Promise<void> => {
    if (!window.desktopBridge?.startHiveEnterpriseLogin) {
      toast.error('Hive Enterprise login is unavailable in this environment')
      return
    }
    setIsSigningIn(true)
    try {
      const { token } = await window.desktopBridge.startHiveEnterpriseLogin(hiveEnterpriseServerUrl)
      await completeHiveEnterpriseLogin(token)
      toast.success('Signed in to Hive Enterprise')
    } catch (error) {
      console.error('[HiveEnterprise] sign-in failed:', error)
      toast.error(error instanceof Error ? error.message : 'Hive Enterprise sign-in failed')
    } finally {
      setIsSigningIn(false)
    }
  }

  return (
    <div className="space-y-6">
      <div>
        <h3 className="text-base font-medium mb-1">Hive Enterprise</h3>
        <p className="text-sm text-muted-foreground">Google sign-in and organization telemetry</p>
      </div>

      <div className="space-y-2">
        <label className="text-sm font-medium">Server URL</label>
        <input
          value={hiveEnterpriseServerUrl}
          onChange={(event) => updateSetting('hiveEnterpriseServerUrl', event.target.value)}
          className="w-full rounded-md border bg-background px-3 py-2 text-sm"
          placeholder={DEFAULT_HIVE_ENTERPRISE_SERVER_URL}
        />
      </div>

      <div className="rounded-md border border-border bg-muted/30 p-3">
        <div className="flex items-start gap-3">
          <Building2 className="mt-0.5 h-4 w-4 text-muted-foreground" />
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium">
              {hiveLoggedInEmail ? hiveLoggedInEmail : 'Not signed in'}
            </p>
            <p className="mt-1 text-xs text-muted-foreground">
              {hiveLoggedInEmail
                ? hiveOrganizationId
                  ? hiveOrganizationName
                  : 'No organization'
                : 'Sign in with Google to check organization membership'}
            </p>
          </div>
        </div>
      </div>

      <div className="flex gap-2">
        <button
          onClick={signIn}
          disabled={isSigningIn}
          className="inline-flex items-center gap-2 rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground disabled:opacity-60"
        >
          {isSigningIn ? <RefreshCw className="h-4 w-4 animate-spin" /> : <LogIn className="h-4 w-4" />}
          Sign in with Google
        </button>
        <button
          onClick={refreshMe}
          disabled={isRefreshing || !hiveLoggedInEmail}
          className="inline-flex items-center gap-2 rounded-md border px-3 py-2 text-sm font-medium disabled:opacity-60"
        >
          <RefreshCw className={isRefreshing ? 'h-4 w-4 animate-spin' : 'h-4 w-4'} />
          Refresh
        </button>
      </div>
    </div>
  )
}
