import { useEffect, useState } from 'react'
import { useSettingsStore } from '@/stores/useSettingsStore'
import { analyticsApi } from '@/api/analytics-api'
import { AgentNotFoundDialog } from './AgentNotFoundDialog'
import { AgentPickerDialog } from './AgentPickerDialog'
import { systemApi } from '@/api/system-api'

type SetupStatus = 'detecting' | 'none-found' | 'choose' | 'done'

export function AgentSetupGuard(): React.JSX.Element | null {
  const initialSetupComplete = useSettingsStore((s) => s.initialSetupComplete)
  const isLoading = useSettingsStore((s) => s.isLoading)
  const updateSetting = useSettingsStore((s) => s.updateSetting)

  const [status, setStatus] = useState<SetupStatus>('detecting')
  const [detectedSdks, setDetectedSdks] = useState<{
    opencode: boolean
    claude: boolean
    codex: boolean
    codexCli: boolean
  } | null>(null)

  useEffect(() => {
    if (isLoading || initialSetupComplete) return

    let cancelled = false

    systemApi
      .detectAgentSdks()
      .then((result) => {
        if (cancelled) return

        setDetectedSdks({ ...result, codexCli: result.codexCli ?? false })

        const { opencode, claude, codex, codexCli } = result
        const found: Array<'opencode' | 'claude-code' | 'codex' | 'codex-cli'> = []
        if (opencode) found.push('opencode')
        if (claude) found.push('claude-code')
        if (codex) found.push('codex')
        // The codex binary can be present without app-server support (codex
        // false, codexCli true) — then only the terminal Codex CLI is usable.
        // Offer it so a codex-cli-only machine isn't wrongly shown "no agent".
        else if (codexCli) found.push('codex-cli')

        if (found.length === 0) {
          setStatus('none-found')
        } else if (found.length === 1) {
          // Exactly one found — auto-select it
          updateSetting('defaultAgentSdk', found[0])
          updateSetting('initialSetupComplete', true)
          analyticsApi.track('onboarding_completed', {
            sdk: found[0],
            auto_selected: true
          })
          setStatus('done')
        } else {
          // Multiple found — let user choose
          setStatus('choose')
        }
      })
      .catch((error) => {
        console.error('Agent SDK detection failed:', error)
        // Fail open: let user configure later in Settings
        updateSetting('initialSetupComplete', true)
        setStatus('done')
      })

    return () => {
      cancelled = true
    }
  }, [isLoading, initialSetupComplete, updateSetting])

  // Already set up, still loading, or detection in progress
  if (initialSetupComplete || isLoading || status === 'detecting' || status === 'done') {
    return null
  }

  if (status === 'none-found') {
    return <AgentNotFoundDialog />
  }

  if (status === 'choose' && detectedSdks) {
    return (
      <AgentPickerDialog
        // Only offer the terminal Codex CLI as a distinct choice when the
        // app-server-backed Codex isn't available (else they'd double up).
        availableSdks={{ ...detectedSdks, codexCli: detectedSdks.codexCli && !detectedSdks.codex }}
        onSelect={(sdk) => {
          updateSetting('defaultAgentSdk', sdk)
          updateSetting('initialSetupComplete', true)
          analyticsApi.track('onboarding_completed', {
            sdk,
            auto_selected: false
          })
          setStatus('done')
        }}
      />
    )
  }

  return null
}
