import './voice-hud/voice-hud.css'
import React from 'react'
import ReactDOM from 'react-dom/client'
import { VoiceHudApp } from './voice-hud/VoiceHudApp'

// The floating dictation pill: a tiny standalone page in its own transparent
// always-on-top window. It talks to the main process over IPC only (no
// backend RPC client needed).
ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <VoiceHudApp />
  </React.StrictMode>
)
