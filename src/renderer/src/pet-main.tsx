import './pet/pet.css'
import React from 'react'
import ReactDOM from 'react-dom/client'
import { PetApp } from './pet/PetApp'

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <PetApp />
  </React.StrictMode>
)
