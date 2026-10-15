import './styles/globals.css'
import React from 'react'
import ReactDOM from 'react-dom/client'
import { createHiveClient } from './api/hive-client'
import { setRendererRpcClient } from './api/rpc-client'
import { instrumentRendererRpcClient } from './lib/perf-logging/renderer-perf-collector'

const renderApp = async (): Promise<void> => {
  const { default: App } = await import('./App')
  ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>
  )
}

const bootstrap = async (): Promise<void> => {
  try {
    const client = await createHiveClient()
    // Performance logging times every RPC round trip while the setting is on (no-op otherwise).
    setRendererRpcClient(instrumentRendererRpcClient(client))
  } catch (error) {
    console.error('Failed to initialize Hive HTTP client', error)
  } finally {
    await renderApp()
  }
}

void bootstrap()
