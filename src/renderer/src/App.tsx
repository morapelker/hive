import { useEffect, useRef, useState } from 'react'
import { isHiveTelemetryEnabled, refreshHiveEnterpriseOrg } from '@/api/hive-enterprise/client'
import { AppLayout } from '@/components/layout'
import { DesktopWindowEscapeChrome } from '@/components/layout/DesktopWindowEscapeChrome'
import { ErrorBoundary } from '@/components/error'
import { TooltipProvider } from '@/components/ui/tooltip'
import { reportActiveAccountsSnapshot } from '@/lib/hive-account-report'
import { preloadHandoffModelCatalogs } from '@/lib/handoffSelection'
import { initPlatform } from '@/lib/platform'
import { useSettingsStore } from '@/stores/useSettingsStore'
import { useTipStore } from '@/stores/useTipStore'
import { PetStatusBridge } from '@/components/pet/PetStatusBridge'

function App(): React.JSX.Element {
  const [ready, setReady] = useState(false)
  const didRefreshHiveOrg = useRef(false)
  const hiveAuthToken = useSettingsStore((state) => state.hiveAuthToken)
  const hiveOrganizationId = useSettingsStore((state) => state.hiveOrganizationId)
  const settingsLoading = useSettingsStore((state) => state.isLoading)

  useEffect(() => {
    initPlatform().then(() => {
      // Load seen tips from DB so the tip system knows which tips to skip
      useTipStore.getState().loadSeenTips()
      // Warm the model catalogs so ticket badges show pretty model names
      // immediately instead of raw slugs until a model picker is opened
      void preloadHandoffModelCatalogs()
      setReady(true)
    })
  }, [])

  useEffect(() => {
    if (settingsLoading || didRefreshHiveOrg.current) return
    if (!isHiveTelemetryEnabled({ hiveAuthToken, hiveOrganizationId })) return
    didRefreshHiveOrg.current = true
    void refreshHiveEnterpriseOrg()
    void reportActiveAccountsSnapshot()
  }, [hiveAuthToken, hiveOrganizationId, settingsLoading])

  if (!ready) return <DesktopWindowEscapeChrome boot />

  return (
    <ErrorBoundary componentName="App">
      <TooltipProvider delayDuration={350}>
        <PetStatusBridge />
        <AppLayout />
      </TooltipProvider>
    </ErrorBoundary>
  )
}

export default App
