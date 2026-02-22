// src/server/resolvers/helpers/sdk-dispatch.ts
import type { GraphQLContext } from '../../context'
import type { AgentSdkImplementer } from '../../../main/services/agent-sdk-types'

/**
 * SDK dispatch by agent session ID.
 * Looks up which SDK a session uses via db.getAgentSdkForSession().
 * If 'claude-code', routes to the Claude implementer; otherwise uses OpenCode.
 */
export async function withSdkDispatch<T>(
  ctx: GraphQLContext,
  agentSessionId: string,
  opencodeFn: () => Promise<T>,
  claudeFn: (impl: AgentSdkImplementer) => Promise<T>
): Promise<T> {
  if (ctx.sdkManager && ctx.db) {
    const sdkId = ctx.db.getAgentSdkForSession(agentSessionId)
    if (sdkId === 'claude-code') {
      return claudeFn(ctx.sdkManager.getImplementer('claude-code'))
    }
  }
  return opencodeFn()
}

/**
 * SDK dispatch by Hive session ID (used for connect, where agent session
 * doesn't exist yet). Looks up session.agent_sdk from the DB.
 */
export async function withSdkDispatchByHiveSession<T>(
  ctx: GraphQLContext,
  hiveSessionId: string,
  opencodeFn: () => Promise<T>,
  claudeFn: (impl: AgentSdkImplementer) => Promise<T>
): Promise<T> {
  if (ctx.sdkManager && ctx.db) {
    const session = ctx.db.getSession(hiveSessionId)
    if (session?.agent_sdk === 'claude-code') {
      return claudeFn(ctx.sdkManager.getImplementer('claude-code'))
    }
  }
  return opencodeFn()
}
