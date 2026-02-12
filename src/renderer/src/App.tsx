import { AppLayout } from '@/components/layout'
import { ErrorBoundary } from '@/components/error'

function App(): React.JSX.Element {
  return (
    <ErrorBoundary componentName="App">
      <AppLayout />
    </ErrorBoundary>
  )
}

export default App
