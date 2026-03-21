// src/server/resolvers/helpers/sdk-dispatch.ts
import type { GraphQLContext } from '../../context'
import type { AgentSdkId, AgentSdkImplementer } from '../../../main/services/agent-sdk-types'

/** Map GraphQL agentSdk enum value to internal AgentSdkId */
export function mapGraphQLSdkToInternal(gqlSdk: string): AgentSdkId {
  if (gqlSdk === 'claude_code') return 'claude-code'
  return gqlSdk as AgentSdkId
}

/**
 * SDK dispatch by agent session ID.
 * Looks up which SDK a session uses via db.getAgentSdkForSession().
 * If a non-OpenCode SDK, routes to its implementer; otherwise uses OpenCode.
 */
export async function withSdkDispatch<T>(
  ctx: GraphQLContext,
  agentSessionId: string,
  opencodeFn: () => Promise<T>,
  sdkFn: (impl: AgentSdkImplementer) => Promise<T>
): Promise<T> {
  if (ctx.sdkManager && ctx.db) {
    const sdkId = ctx.db.getAgentSdkForSession(agentSessionId)
    if (sdkId && sdkId !== 'opencode' && sdkId !== 'terminal') {
      return sdkFn(ctx.sdkManager.getImplementer(sdkId))
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
  sdkFn: (impl: AgentSdkImplementer) => Promise<T>
): Promise<T> {
  if (ctx.sdkManager && ctx.db) {
    const session = ctx.db.getSession(hiveSessionId)
    if (
      session?.agent_sdk &&
      session.agent_sdk !== 'opencode' &&
      session.agent_sdk !== 'terminal'
    ) {
      return sdkFn(ctx.sdkManager.getImplementer(session.agent_sdk))
    }
  }
  return opencodeFn()
}
