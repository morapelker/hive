import { useEffect, useState } from 'react'
import { AppLayout } from '@/components/layout'
import { ErrorBoundary } from '@/components/error'
import { TooltipProvider } from '@/components/ui/tooltip'
import { initPlatform } from '@/lib/platform'
import { useTipStore } from '@/stores/useTipStore'
import { PetStatusBridge } from '@/components/pet/PetStatusBridge'

function App(): React.JSX.Element {
  const [ready, setReady] = useState(false)

  useEffect(() => {
    initPlatform().then(() => {
      // Load seen tips from DB so the tip system knows which tips to skip
      useTipStore.getState().loadSeenTips()
      setReady(true)
    })
  }, [])

  if (!ready) return <div />

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
