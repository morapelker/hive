import type { DatabaseService } from '../main/db/database'
import type { AgentSdkManager } from '../main/services/agent-sdk-manager'
import type { EventBus } from './event-bus'

export interface GraphQLContext {
  db: DatabaseService
  sdkManager: AgentSdkManager
  eventBus: EventBus
  clientIp: string
  authenticated: boolean
}
