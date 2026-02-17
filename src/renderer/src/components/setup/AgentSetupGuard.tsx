import { useEffect, useState } from 'react'
import { useSettingsStore } from '@/stores/useSettingsStore'
import { AgentNotFoundDialog } from './AgentNotFoundDialog'
import { AgentPickerDialog } from './AgentPickerDialog'

type SetupStatus = 'detecting' | 'none-found' | 'choose' | 'done'

export function AgentSetupGuard(): React.JSX.Element | null {
  const initialSetupComplete = useSettingsStore((s) => s.initialSetupComplete)
  const isLoading = useSettingsStore((s) => s.isLoading)
  const updateSetting = useSettingsStore((s) => s.updateSetting)

  const [status, setStatus] = useState<SetupStatus>('detecting')

  useEffect(() => {
    if (isLoading || initialSetupComplete) return

    let cancelled = false

    window.systemOps
      .detectAgentSdks()
      .then((result) => {
        if (cancelled) return

        const { opencode, claude } = result

        if (!opencode && !claude) {
          setStatus('none-found')
        } else if (opencode && claude) {
          setStatus('choose')
        } else {
          // Exactly one found — auto-select it
          updateSetting('defaultAgentSdk', opencode ? 'opencode' : 'claude-code')
          updateSetting('initialSetupComplete', true)
          setStatus('done')
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

  if (status === 'choose') {
    return (
      <AgentPickerDialog
        onSelect={(sdk) => {
          updateSetting('defaultAgentSdk', sdk)
          updateSetting('initialSetupComplete', true)
          setStatus('done')
        }}
      />
    )
  }

  return null
}
