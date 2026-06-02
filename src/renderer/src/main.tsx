import './styles/globals.css'
import React from 'react'
import ReactDOM from 'react-dom/client'
import { createHiveClient } from './api/hive-client'
import { setRendererRpcClient } from './api/rpc-client'

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
    setRendererRpcClient(client)
  } catch (error) {
    console.error('Failed to initialize Hive HTTP client', error)
  } finally {
    await renderApp()
  }
}

void bootstrap()
