import { useEffect, useState } from 'react'
import { AppLayout } from '@/components/layout'
import { ErrorBoundary } from '@/components/error'
import { TooltipProvider } from '@/components/ui/tooltip'
import { initPlatform } from '@/lib/platform'

function App(): React.JSX.Element {
  const [ready, setReady] = useState(false)

  useEffect(() => {
    initPlatform().then(() => setReady(true))
  }, [])

  if (!ready) return <div />

  return (
    <ErrorBoundary componentName="App">
      <TooltipProvider delayDuration={350}>
        <AppLayout />
      </TooltipProvider>
    </ErrorBoundary>
  )
}

export default App
