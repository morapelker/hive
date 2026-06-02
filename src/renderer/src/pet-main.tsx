import './pet/pet.css'
import React from 'react'
import ReactDOM from 'react-dom/client'
import { createHiveClient } from './api/hive-client'
import { setRendererRpcClient } from './api/rpc-client'

const renderPet = async (): Promise<void> => {
  const { PetApp } = await import('./pet/PetApp')
  ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
    <React.StrictMode>
      <PetApp />
    </React.StrictMode>
  )
}

const bootstrap = async (): Promise<void> => {
  try {
    const client = await createHiveClient()
    setRendererRpcClient(client)
  } catch (error) {
    console.error('Failed to initialize Hive HTTP client (pet)', error)
  } finally {
    await renderPet()
  }
}

void bootstrap()
