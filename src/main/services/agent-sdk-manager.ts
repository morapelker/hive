import type { BrowserWindow } from 'electron'
import type { AgentSdkId, AgentSdkCapabilities, AgentSdkImplementer } from './agent-sdk-types'
import { createLogger } from './logger'

const log = createLogger({ component: 'AgentSdkManager' })

export class AgentSdkManager {
  private implementers: Map<AgentSdkId, AgentSdkImplementer>
  readonly defaultSdkId: AgentSdkId = 'opencode'

  constructor(opencode: AgentSdkImplementer, claudeCode: AgentSdkImplementer) {
    this.implementers = new Map<AgentSdkId, AgentSdkImplementer>([
      ['opencode', opencode],
      ['claude-code', claudeCode]
    ])
    log.info('AgentSdkManager initialized', {
      sdks: Array.from(this.implementers.keys())
    })
  }

  getImplementer(sdkId: AgentSdkId): AgentSdkImplementer {
    const impl = this.implementers.get(sdkId)
    if (!impl) {
      throw new Error(`Unknown agent SDK: "${sdkId}"`)
    }
    return impl
  }

  getCapabilities(sdkId: AgentSdkId): AgentSdkCapabilities {
    return this.getImplementer(sdkId).capabilities
  }

  setMainWindow(window: BrowserWindow): void {
    for (const impl of this.implementers.values()) {
      impl.setMainWindow(window)
    }
  }

  async cleanupAll(): Promise<void> {
    log.info('Cleaning up all SDK implementers')
    for (const [id, impl] of this.implementers) {
      try {
        await impl.cleanup()
        log.info('Cleaned up SDK', { id })
      } catch (error) {
        log.error('Error cleaning up SDK', {
          id,
          error: error instanceof Error ? error.message : String(error)
        })
      }
    }
  }
}
