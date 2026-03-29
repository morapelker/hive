// src/main/services/ticket-providers/ticket-provider-manager.ts

import type { TicketProviderId, TicketProvider } from './ticket-provider-types'
import { createLogger } from '../logger'

const log = createLogger({ component: 'TicketProviderManager' })

export class TicketProviderManager {
  private providers: Map<TicketProviderId, TicketProvider>

  constructor(providers: TicketProvider[]) {
    this.providers = new Map(providers.map((p) => [p.id, p]))
    log.info('TicketProviderManager initialized', {
      providers: Array.from(this.providers.keys())
    })
  }

  getProvider(id: TicketProviderId): TicketProvider {
    const provider = this.providers.get(id)
    if (!provider) {
      throw new Error(`Unknown ticket provider: "${id}"`)
    }
    return provider
  }

  listProviders(): TicketProvider[] {
    return Array.from(this.providers.values())
  }

  hasProvider(id: TicketProviderId): boolean {
    return this.providers.has(id)
  }
}

let _instance: TicketProviderManager | null = null

export function initTicketProviderManager(providers: TicketProvider[]): TicketProviderManager {
  _instance = new TicketProviderManager(providers)
  return _instance
}

export function getTicketProviderManager(): TicketProviderManager {
  if (!_instance) {
    throw new Error('TicketProviderManager not initialized. Call initTicketProviderManager() first.')
  }
  return _instance
}
