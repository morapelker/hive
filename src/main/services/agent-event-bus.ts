import { EventEmitter } from 'node:events'
import type { BrowserWindow } from 'electron'
import type { OpenCodeStreamEvent } from '@shared/types/opencode'
import { createLogger } from './logger'

const log = createLogger({ component: 'AgentEventBus' })

class AgentEventBus extends EventEmitter {
  private mainWindow: BrowserWindow | null = null

  setMainWindow(window: BrowserWindow | null): void {
    this.mainWindow = window
  }

  publish(event: OpenCodeStreamEvent): void {
    if (this.mainWindow && !this.mainWindow.isDestroyed()) {
      this.mainWindow.webContents.send('opencode:stream', event)
    } else {
      log.debug('publish: no renderer window')
    }
    this.emit('opencode:stream', event)
  }

  subscribe(listener: (event: OpenCodeStreamEvent) => void): () => void {
    this.on('opencode:stream', listener)
    return () => this.off('opencode:stream', listener)
  }
}

export const agentEventBus = new AgentEventBus()
