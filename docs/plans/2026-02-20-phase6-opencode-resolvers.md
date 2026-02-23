# Phase 6: OpenCode AI GraphQL Resolvers — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Implement 21 GraphQL resolvers (14 mutations, 7 queries) that mirror the IPC handlers in `src/main/ipc/opencode-handlers.ts` with SDK-aware dispatch for OpenCode and Claude Code backends.

**Architecture:** Each resolver dispatches to either `openCodeService` (default) or `ctx.sdkManager.getImplementer('claude-code')` based on the session's `agent_sdk` DB field. A shared dispatch helper avoids repeating this logic in every resolver. The resolvers are registered via the existing `mergeResolvers()` pattern.

**Tech Stack:** TypeScript, GraphQL (graphql-yoga), Vitest, existing `AgentSdkManager` + `openCodeService` services.

---

## Task 1: SDK Dispatch Helper (Session 59a)

**Files:**
- Create: `src/server/resolvers/helpers/sdk-dispatch.ts`

**Step 1: Create the dispatch helper file**

```typescript
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
```

**Step 2: Verify build**

Run: `pnpm build`
Expected: SUCCESS (no resolver uses the helper yet, it just needs to compile)

**Step 3: Commit**

```bash
git add src/server/resolvers/helpers/sdk-dispatch.ts
git commit -m "feat(server): add SDK dispatch helpers for OpenCode resolvers"
```

---

## Task 2: Connect, Reconnect, Disconnect Mutations (Session 59b)

**Files:**
- Create: `src/server/resolvers/mutation/opencode.resolvers.ts`
- Modify: `src/server/resolvers/index.ts`

**Step 1: Create the mutation resolver file with connect/reconnect/disconnect**

```typescript
// src/server/resolvers/mutation/opencode.resolvers.ts
import type { Resolvers } from '../../__generated__/resolvers-types'
import { openCodeService } from '../../../main/services/opencode-service'
import { withSdkDispatch, withSdkDispatchByHiveSession } from '../helpers/sdk-dispatch'

export const opencodeMutationResolvers: Resolvers = {
  Mutation: {
    opencodeConnect: async (_parent, { worktreePath, hiveSessionId }, ctx) => {
      try {
        const result = await withSdkDispatchByHiveSession(
          ctx,
          hiveSessionId,
          () => openCodeService.connect(worktreePath, hiveSessionId),
          (impl) => impl.connect(worktreePath, hiveSessionId)
        )
        return { success: true, sessionId: result.sessionId }
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Unknown error'
        }
      }
    },

    opencodeReconnect: async (_parent, { input }, ctx) => {
      try {
        const { worktreePath, opencodeSessionId, hiveSessionId } = input
        const result = await withSdkDispatch(
          ctx,
          opencodeSessionId,
          () => openCodeService.reconnect(worktreePath, opencodeSessionId, hiveSessionId),
          (impl) => impl.reconnect(worktreePath, opencodeSessionId, hiveSessionId)
        )
        return {
          success: result.success ?? true,
          sessionStatus: result.sessionStatus ?? null,
          revertMessageID: result.revertMessageID ?? null
        }
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Unknown error'
        }
      }
    },

    opencodeDisconnect: async (_parent, { worktreePath, sessionId }, ctx) => {
      try {
        await withSdkDispatch(
          ctx,
          sessionId,
          () => openCodeService.disconnect(worktreePath, sessionId),
          (impl) => impl.disconnect(worktreePath, sessionId)
        )
        return { success: true }
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Unknown error'
        }
      }
    },
  }
}
```

**Step 2: Register in resolver index**

Add to `src/server/resolvers/index.ts`:

Import line (add after `connectionMutationResolvers` import):
```typescript
import { opencodeMutationResolvers } from './mutation/opencode.resolvers'
```

Add `opencodeMutationResolvers` to the `deepMerge()` call in `mergeResolvers()`.

**Step 3: Verify build**

Run: `pnpm build`
Expected: SUCCESS

**Step 4: Commit**

```bash
git add src/server/resolvers/mutation/opencode.resolvers.ts src/server/resolvers/index.ts
git commit -m "feat(server): add connect/reconnect/disconnect OpenCode resolvers"
```

---

## Task 3: Prompt & Abort Mutations (Session 60)

**Files:**
- Modify: `src/server/resolvers/mutation/opencode.resolvers.ts`

**Step 1: Add prompt and abort resolvers**

Add these to the `Mutation` object in `opencode.resolvers.ts` (mutation file):

```typescript
    opencodePrompt: async (_parent, { input }, ctx) => {
      try {
        const { worktreePath, opencodeSessionId, message, parts, model } = input
        // Convert message string to parts array if needed
        const messageParts = parts ?? [{ type: 'text', text: message ?? '' }]
        await withSdkDispatch(
          ctx,
          opencodeSessionId,
          () => openCodeService.prompt(worktreePath, opencodeSessionId, messageParts, model),
          (impl) => impl.prompt(worktreePath, opencodeSessionId, messageParts, model)
        )
        return { success: true }
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Unknown error'
        }
      }
    },

    opencodeAbort: async (_parent, { worktreePath, sessionId }, ctx) => {
      try {
        const result = await withSdkDispatch(
          ctx,
          sessionId,
          () => openCodeService.abort(worktreePath, sessionId),
          (impl) => impl.abort(worktreePath, sessionId)
        )
        return { success: result }
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Unknown error'
        }
      }
    },
```

**Step 2: Verify build**

Run: `pnpm build`
Expected: SUCCESS

**Step 3: Commit**

```bash
git add src/server/resolvers/mutation/opencode.resolvers.ts
git commit -m "feat(server): add prompt and abort OpenCode resolvers"
```

---

## Task 4: Messages & Session Info Queries (Session 61)

**Files:**
- Create: `src/server/resolvers/query/opencode.resolvers.ts`
- Modify: `src/server/resolvers/index.ts`

**Step 1: Create the query resolver file**

```typescript
// src/server/resolvers/query/opencode.resolvers.ts
import type { Resolvers } from '../../__generated__/resolvers-types'
import { openCodeService } from '../../../main/services/opencode-service'
import { withSdkDispatch } from '../helpers/sdk-dispatch'

export const opencodeQueryResolvers: Resolvers = {
  Query: {
    opencodeMessages: async (_parent, { worktreePath, sessionId }, ctx) => {
      try {
        const messages = await withSdkDispatch(
          ctx,
          sessionId,
          () => openCodeService.getMessages(worktreePath, sessionId),
          (impl) => impl.getMessages(worktreePath, sessionId)
        )
        return { success: true, messages }
      } catch (error) {
        return {
          success: false,
          messages: [],
          error: error instanceof Error ? error.message : 'Unknown error'
        }
      }
    },

    opencodeSessionInfo: async (_parent, { worktreePath, sessionId }, ctx) => {
      try {
        const result = await withSdkDispatch(
          ctx,
          sessionId,
          () => openCodeService.getSessionInfo(worktreePath, sessionId),
          (impl) => impl.getSessionInfo(worktreePath, sessionId)
        )
        return {
          success: true,
          revertMessageID: result.revertMessageID,
          revertDiff: result.revertDiff
        }
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Unknown error'
        }
      }
    },
  }
}
```

**Step 2: Register in resolver index**

Add to `src/server/resolvers/index.ts`:

Import line (add after `connectionQueryResolvers` or similar):
```typescript
import { opencodeQueryResolvers } from './query/opencode.resolvers'
```

Add `opencodeQueryResolvers` to the `deepMerge()` call in `mergeResolvers()`.

**Step 3: Verify build**

Run: `pnpm build`
Expected: SUCCESS

**Step 4: Commit**

```bash
git add src/server/resolvers/query/opencode.resolvers.ts src/server/resolvers/index.ts
git commit -m "feat(server): add messages and sessionInfo OpenCode query resolvers"
```

---

## Task 5: Models & Model Info Queries (Session 62)

**Files:**
- Modify: `src/server/resolvers/query/opencode.resolvers.ts`

**Step 1: Add models and modelInfo resolvers**

Add to the `Query` object in the query resolvers file:

```typescript
    opencodeModels: async (_parent, { agentSdk }, ctx) => {
      try {
        if (agentSdk === 'claude_code' && ctx.sdkManager) {
          const impl = ctx.sdkManager.getImplementer('claude-code')
          const providers = await impl.getAvailableModels()
          return { success: true, providers }
        }
        const providers = await openCodeService.getAvailableModels()
        return { success: true, providers }
      } catch (error) {
        return {
          success: false,
          providers: {},
          error: error instanceof Error ? error.message : 'Unknown error'
        }
      }
    },

    opencodeModelInfo: async (_parent, { worktreePath, modelId, agentSdk }, ctx) => {
      try {
        if (agentSdk === 'claude_code' && ctx.sdkManager) {
          const impl = ctx.sdkManager.getImplementer('claude-code')
          const model = await impl.getModelInfo(worktreePath, modelId)
          if (!model) return { success: false, error: 'Model not found' }
          return { success: true, model }
        }
        const model = await openCodeService.getModelInfo(worktreePath, modelId)
        if (!model) return { success: false, error: 'Model not found' }
        return { success: true, model }
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Unknown error'
        }
      }
    },
```

**Important note:** The GraphQL schema uses `AgentSdk` enum which has `opencode` and `claude_code` (with underscore, not dash). The comparison is `agentSdk === 'claude_code'`. Check `src/server/schema/types/project.graphql` for the enum definition if unsure.

**Step 2: Verify build**

Run: `pnpm build`
Expected: SUCCESS

**Step 3: Commit**

```bash
git add src/server/resolvers/query/opencode.resolvers.ts
git commit -m "feat(server): add models and modelInfo OpenCode query resolvers"
```

---

## Task 6: Set Model Mutation (Session 63)

**Files:**
- Modify: `src/server/resolvers/mutation/opencode.resolvers.ts`

**Step 1: Add setModel resolver**

Add to the `Mutation` object in the mutation resolvers file:

```typescript
    opencodeSetModel: async (_parent, { input }, ctx) => {
      try {
        const { providerID, modelID, variant, agentSdk } = input
        if (agentSdk === 'claude_code' && ctx.sdkManager) {
          const impl = ctx.sdkManager.getImplementer('claude-code')
          impl.setSelectedModel({ providerID, modelID, variant: variant ?? undefined })
          return { success: true }
        }
        openCodeService.setSelectedModel({ providerID, modelID, variant: variant ?? undefined })
        return { success: true }
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Unknown error'
        }
      }
    },
```

**Step 2: Verify build**

Run: `pnpm build`
Expected: SUCCESS

**Step 3: Commit**

```bash
git add src/server/resolvers/mutation/opencode.resolvers.ts
git commit -m "feat(server): add setModel OpenCode mutation resolver"
```

---

## Task 7: Undo & Redo Mutations (Session 64)

**Files:**
- Modify: `src/server/resolvers/mutation/opencode.resolvers.ts`

**Step 1: Add undo and redo resolvers**

Add to the `Mutation` object:

```typescript
    opencodeUndo: async (_parent, { worktreePath, sessionId }, ctx) => {
      try {
        const result = await withSdkDispatch(
          ctx,
          sessionId,
          () => openCodeService.undo(worktreePath, sessionId),
          (impl) => impl.undo(worktreePath, sessionId, '')
        )
        const r = result as Record<string, unknown>
        return {
          success: true,
          revertMessageID: (r.revertMessageID as string) ?? null,
          restoredPrompt: (r.restoredPrompt as string) ?? null,
          revertDiff: (r.revertDiff as string) ?? null
        }
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Unknown error'
        }
      }
    },

    opencodeRedo: async (_parent, { worktreePath, sessionId }, ctx) => {
      try {
        const result = await withSdkDispatch(
          ctx,
          sessionId,
          () => openCodeService.redo(worktreePath, sessionId),
          (impl) => impl.redo(worktreePath, sessionId, '')
        )
        const r = result as Record<string, unknown>
        return {
          success: true,
          revertMessageID: (r.revertMessageID as string) ?? null
        }
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Unknown error'
        }
      }
    },
```

**Step 2: Verify build**

Run: `pnpm build`
Expected: SUCCESS

**Step 3: Commit**

```bash
git add src/server/resolvers/mutation/opencode.resolvers.ts
git commit -m "feat(server): add undo and redo OpenCode mutation resolvers"
```

---

## Task 8: Commands & Capabilities Queries (Session 65)

**Files:**
- Modify: `src/server/resolvers/query/opencode.resolvers.ts`

**Step 1: Add commands and capabilities resolvers**

Add to the `Query` object in the query resolvers file:

```typescript
    opencodeCommands: async (_parent, { worktreePath, sessionId }, ctx) => {
      try {
        if (ctx.sdkManager && ctx.db && sessionId) {
          const sdkId = ctx.db.getAgentSdkForSession(sessionId)
          if (sdkId === 'claude-code') {
            const impl = ctx.sdkManager.getImplementer('claude-code')
            const commands = await impl.listCommands(worktreePath)
            return { success: true, commands: commands as any[] }
          }
        }
        const commands = await openCodeService.listCommands(worktreePath)
        return { success: true, commands: commands as any[] }
      } catch (error) {
        return {
          success: false,
          commands: [],
          error: error instanceof Error ? error.message : 'Unknown error'
        }
      }
    },

    opencodeCapabilities: async (_parent, { sessionId }, ctx) => {
      try {
        if (ctx.sdkManager && ctx.db && sessionId) {
          const sdkId = ctx.db.getAgentSdkForSession(sessionId)
          if (sdkId) {
            return { success: true, capabilities: ctx.sdkManager.getCapabilities(sdkId) }
          }
        }
        const defaultCaps = ctx.sdkManager?.getCapabilities('opencode') ?? null
        return { success: true, capabilities: defaultCaps }
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Unknown error'
        }
      }
    },
```

**Step 2: Verify build**

Run: `pnpm build`
Expected: SUCCESS

**Step 3: Commit**

```bash
git add src/server/resolvers/query/opencode.resolvers.ts
git commit -m "feat(server): add commands and capabilities OpenCode query resolvers"
```

---

## Task 9: Command Execution Mutation (Session 66)

**Files:**
- Modify: `src/server/resolvers/mutation/opencode.resolvers.ts`

**Step 1: Add command resolver**

Add to the `Mutation` object:

```typescript
    opencodeCommand: async (_parent, { input }, ctx) => {
      try {
        const { worktreePath, opencodeSessionId, command, args, model } = input
        await withSdkDispatch(
          ctx,
          opencodeSessionId,
          () => openCodeService.sendCommand(worktreePath, opencodeSessionId, command, args, model),
          (impl) => impl.sendCommand(worktreePath, opencodeSessionId, command, args)
        )
        return { success: true }
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Unknown error'
        }
      }
    },
```

**Note:** Claude Code implementer's `sendCommand` does NOT accept `model` — it uses its own model selection mechanism. This matches the IPC handler behavior.

**Step 2: Verify build**

Run: `pnpm build`
Expected: SUCCESS

**Step 3: Commit**

```bash
git add src/server/resolvers/mutation/opencode.resolvers.ts
git commit -m "feat(server): add command execution OpenCode mutation resolver"
```

---

## Task 10: Permission List Query & Permission Reply Mutation (Session 67)

**Files:**
- Modify: `src/server/resolvers/query/opencode.resolvers.ts`
- Modify: `src/server/resolvers/mutation/opencode.resolvers.ts`

**Step 1: Add permissionList query**

Add to the `Query` object in the query resolvers file:

```typescript
    opencodePermissionList: async (_parent, { worktreePath }) => {
      try {
        const permissions = await openCodeService.permissionList(worktreePath)
        return { success: true, permissions: permissions as any[] }
      } catch (error) {
        return {
          success: false,
          permissions: [],
          error: error instanceof Error ? error.message : 'Unknown error'
        }
      }
    },
```

**Step 2: Add permissionReply mutation**

Add to the `Mutation` object in the mutation resolvers file:

```typescript
    opencodePermissionReply: async (_parent, { input }) => {
      try {
        const { requestId, reply, worktreePath, message } = input
        await openCodeService.permissionReply(
          requestId,
          reply as 'once' | 'always' | 'reject',
          worktreePath ?? undefined,
          message ?? undefined
        )
        return { success: true }
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Unknown error'
        }
      }
    },
```

**Note:** The IPC handler for permission reply does NOT do SDK dispatch — it always goes to `openCodeService`. The resolver mirrors this.

**Step 3: Verify build**

Run: `pnpm build`
Expected: SUCCESS

**Step 4: Commit**

```bash
git add src/server/resolvers/query/opencode.resolvers.ts src/server/resolvers/mutation/opencode.resolvers.ts
git commit -m "feat(server): add permission list/reply OpenCode resolvers"
```

---

## Task 11: Question Reply & Reject Mutations (Session 68)

**Files:**
- Modify: `src/server/resolvers/mutation/opencode.resolvers.ts`

**Step 1: Add question reply and reject resolvers**

Add to the `Mutation` object:

```typescript
    opencodeQuestionReply: async (_parent, { input }, ctx) => {
      try {
        const { requestId, answers, worktreePath } = input
        // Route to Claude Code if it has a pending question for this requestId
        if (ctx.sdkManager) {
          const claudeImpl = ctx.sdkManager.getImplementer('claude-code')
          if ('hasPendingQuestion' in claudeImpl) {
            const typedImpl = claudeImpl as any
            if (typedImpl.hasPendingQuestion(requestId)) {
              await typedImpl.questionReply(requestId, answers, worktreePath ?? undefined)
              return { success: true }
            }
          }
        }
        await openCodeService.questionReply(requestId, answers, worktreePath ?? undefined)
        return { success: true }
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Unknown error'
        }
      }
    },

    opencodeQuestionReject: async (_parent, { requestId, worktreePath }, ctx) => {
      try {
        // Route to Claude Code if it has a pending question for this requestId
        if (ctx.sdkManager) {
          const claudeImpl = ctx.sdkManager.getImplementer('claude-code')
          if ('hasPendingQuestion' in claudeImpl) {
            const typedImpl = claudeImpl as any
            if (typedImpl.hasPendingQuestion(requestId)) {
              await typedImpl.questionReject(requestId, worktreePath ?? undefined)
              return { success: true }
            }
          }
        }
        await openCodeService.questionReject(requestId, worktreePath ?? undefined)
        return { success: true }
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Unknown error'
        }
      }
    },
```

**Step 2: Verify build**

Run: `pnpm build`
Expected: SUCCESS

**Step 3: Commit**

```bash
git add src/server/resolvers/mutation/opencode.resolvers.ts
git commit -m "feat(server): add question reply/reject OpenCode mutation resolvers"
```

---

## Task 12: Plan Approve & Reject Mutations (Session 69)

**Files:**
- Modify: `src/server/resolvers/mutation/opencode.resolvers.ts`

**Step 1: Add plan approve and reject resolvers**

Add to the `Mutation` object:

```typescript
    opencodePlanApprove: async (_parent, { input }, ctx) => {
      try {
        const { worktreePath, hiveSessionId, requestId } = input
        if (ctx.sdkManager) {
          const claudeImpl = ctx.sdkManager.getImplementer('claude-code')
          if ('hasPendingPlan' in claudeImpl) {
            const typedImpl = claudeImpl as any
            if (
              (requestId && typedImpl.hasPendingPlan(requestId)) ||
              typedImpl.hasPendingPlanForSession(hiveSessionId)
            ) {
              await typedImpl.planApprove(worktreePath, hiveSessionId, requestId ?? undefined)
              return { success: true }
            }
          }
        }
        return { success: false, error: 'No pending plan found' }
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Unknown error'
        }
      }
    },

    opencodePlanReject: async (_parent, { input }, ctx) => {
      try {
        const { worktreePath, hiveSessionId, feedback, requestId } = input
        if (ctx.sdkManager) {
          const claudeImpl = ctx.sdkManager.getImplementer('claude-code')
          if ('hasPendingPlan' in claudeImpl) {
            const typedImpl = claudeImpl as any
            if (
              (requestId && typedImpl.hasPendingPlan(requestId)) ||
              typedImpl.hasPendingPlanForSession(hiveSessionId)
            ) {
              await typedImpl.planReject(worktreePath, hiveSessionId, feedback, requestId ?? undefined)
              return { success: true }
            }
          }
        }
        return { success: false, error: 'No pending plan found' }
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Unknown error'
        }
      }
    },
```

**Step 2: Verify build**

Run: `pnpm build`
Expected: SUCCESS

**Step 3: Commit**

```bash
git add src/server/resolvers/mutation/opencode.resolvers.ts
git commit -m "feat(server): add plan approve/reject OpenCode mutation resolvers"
```

---

## Task 13: Fork & Rename Mutations (Session 70)

**Files:**
- Modify: `src/server/resolvers/mutation/opencode.resolvers.ts`

**Step 1: Add fork and rename resolvers**

Add to the `Mutation` object:

```typescript
    opencodeFork: async (_parent, { input }, ctx) => {
      try {
        const { worktreePath, opencodeSessionId, messageId } = input
        const result = await withSdkDispatch(
          ctx,
          opencodeSessionId,
          () => openCodeService.forkSession(worktreePath, opencodeSessionId, messageId ?? undefined),
          async (_impl) => {
            // Claude Code fork is handled via openCodeService (no separate impl)
            return openCodeService.forkSession(worktreePath, opencodeSessionId, messageId ?? undefined)
          }
        )
        return { success: true, sessionId: result.sessionId }
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Unknown error'
        }
      }
    },

    opencodeRenameSession: async (_parent, { input }, ctx) => {
      try {
        const { opencodeSessionId, title, worktreePath } = input
        await withSdkDispatch(
          ctx,
          opencodeSessionId,
          () => openCodeService.renameSession(opencodeSessionId, title, worktreePath ?? undefined),
          (impl) => impl.renameSession(worktreePath ?? '', opencodeSessionId, title)
        )
        return { success: true }
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Unknown error'
        }
      }
    },
```

**Note on fork:** The IPC handler for fork does NOT do SDK dispatch — it always goes to `openCodeService.forkSession()`. The resolver mirrors this. The `withSdkDispatch` call here routes through opencode for both paths, but we keep the pattern for consistency and future-proofing.

**Note on rename:** The `AgentSdkImplementer.renameSession()` takes `(worktreePath, agentSessionId, name)` — different parameter order than `openCodeService.renameSession(sessionId, title, worktreePath)`.

**Step 2: Verify build**

Run: `pnpm build`
Expected: SUCCESS

**Step 3: Commit**

```bash
git add src/server/resolvers/mutation/opencode.resolvers.ts
git commit -m "feat(server): add fork and rename OpenCode mutation resolvers"
```

---

## Task 14: SDK Dispatch Hardening Review (Session 71)

**Files:**
- Review: `src/server/resolvers/mutation/opencode.resolvers.ts`
- Review: `src/server/resolvers/query/opencode.resolvers.ts`
- Review: `src/server/resolvers/helpers/sdk-dispatch.ts`

**Step 1: Review all resolvers for consistency**

Check each resolver against its IPC handler counterpart in `src/main/ipc/opencode-handlers.ts`:

| Resolver | IPC handler line | Dispatch method | Verified |
|----------|-----------------|-----------------|----------|
| `opencodeConnect` | L19-44 | `withSdkDispatchByHiveSession` (checks `session.agent_sdk`) | |
| `opencodeReconnect` | L47-73 | `withSdkDispatch` (checks `getAgentSdkForSession`) | |
| `opencodeDisconnect` | L154-179 | `withSdkDispatch` | |
| `opencodePrompt` | L77-151 | `withSdkDispatch` | |
| `opencodeAbort` | L729-754 | `withSdkDispatch` | |
| `opencodeSetModel` | L209-240 | Direct `agentSdk` field check | |
| `opencodeUndo` | L387-413 | `withSdkDispatch` | |
| `opencodeRedo` | L416-442 | `withSdkDispatch` | |
| `opencodeCommand` | L342-384 | `withSdkDispatch` | |
| `opencodeRenameSession` | L650-672 | `withSdkDispatch` (IPC doesn't dispatch, but good to have) | |
| `opencodeFork` | L675-697 | No dispatch (IPC uses openCodeService only) | |
| `opencodeQuestionReply` | L466-497 | `hasPendingQuestion` check on Claude impl | |
| `opencodeQuestionReject` | L500-524 | `hasPendingQuestion` check on Claude impl | |
| `opencodePlanApprove` | L527-558 | `hasPendingPlan`/`hasPendingPlanForSession` check | |
| `opencodePlanReject` | L561-597 | `hasPendingPlan`/`hasPendingPlanForSession` check | |
| `opencodePermissionReply` | L600-628 | No dispatch (direct openCodeService) | |
| `opencodeMessages` | L700-726 | `withSdkDispatch` | |
| `opencodeSessionInfo` | L282-307 | `withSdkDispatch` | |
| `opencodeModels` | L182-206 | Direct `agentSdk` arg check | |
| `opencodeModelInfo` | L243-278 | Direct `agentSdk` arg check | |
| `opencodeCommands` | L310-338 | Inline SDK dispatch on `sessionId` | |
| `opencodeCapabilities` | L444-463 | Inline SDK dispatch via `sdkManager.getCapabilities()` | |
| `opencodePermissionList` | L631-647 | No dispatch (direct openCodeService) | |

**Step 2: Verify all error paths return `{ success: false, error: string }`**

Scan all resolver functions and confirm every `catch` block returns the standard error shape.

**Step 3: Verify build**

Run: `pnpm build`
Expected: SUCCESS

**Step 4: Commit (only if changes were made)**

```bash
git add src/server/resolvers/mutation/opencode.resolvers.ts src/server/resolvers/query/opencode.resolvers.ts src/server/resolvers/helpers/sdk-dispatch.ts
git commit -m "fix(server): harden SDK dispatch consistency across OpenCode resolvers"
```

---

## Task 15: Create Mock SDK Helpers (Session 72a)

**Files:**
- Create: `test/server/helpers/mock-sdk.ts`

**Step 1: Create mock SDK test helpers**

```typescript
// test/server/helpers/mock-sdk.ts
import { vi } from 'vitest'
import type { AgentSdkCapabilities, AgentSdkImplementer } from '../../../src/main/services/agent-sdk-types'

export const MOCK_OPENCODE_CAPABILITIES: AgentSdkCapabilities = {
  supportsUndo: true,
  supportsRedo: true,
  supportsCommands: true,
  supportsPermissionRequests: true,
  supportsQuestionPrompts: true,
  supportsModelSelection: true,
  supportsReconnect: true,
  supportsPartialStreaming: true
}

export const MOCK_CLAUDE_CAPABILITIES: AgentSdkCapabilities = {
  supportsUndo: true,
  supportsRedo: false,
  supportsCommands: true,
  supportsPermissionRequests: true,
  supportsQuestionPrompts: true,
  supportsModelSelection: true,
  supportsReconnect: true,
  supportsPartialStreaming: true
}

/**
 * Creates a mock AgentSdkImplementer with vi.fn() stubs for all methods.
 * Each method records calls for assertions.
 */
export function createMockImplementer(
  sdkId: 'opencode' | 'claude-code',
  capabilities: AgentSdkCapabilities
): AgentSdkImplementer & {
  hasPendingQuestion: ReturnType<typeof vi.fn>
  hasPendingPlan: ReturnType<typeof vi.fn>
  hasPendingPlanForSession: ReturnType<typeof vi.fn>
  planApprove: ReturnType<typeof vi.fn>
  planReject: ReturnType<typeof vi.fn>
} {
  return {
    id: sdkId,
    capabilities,
    connect: vi.fn().mockResolvedValue({ sessionId: `${sdkId}-session-1` }),
    reconnect: vi.fn().mockResolvedValue({ success: true, sessionStatus: 'idle', revertMessageID: null }),
    disconnect: vi.fn().mockResolvedValue(undefined),
    cleanup: vi.fn().mockResolvedValue(undefined),
    prompt: vi.fn().mockResolvedValue(undefined),
    abort: vi.fn().mockResolvedValue(true),
    getMessages: vi.fn().mockResolvedValue([{ id: '1', role: 'user', content: 'hello' }]),
    getAvailableModels: vi.fn().mockResolvedValue({ anthropic: [{ id: 'claude-4', name: 'Claude 4' }] }),
    getModelInfo: vi.fn().mockResolvedValue({ id: 'claude-4', name: 'Claude 4', limit: { context: 200000, output: 8192 } }),
    setSelectedModel: vi.fn(),
    getSessionInfo: vi.fn().mockResolvedValue({ revertMessageID: null, revertDiff: null }),
    questionReply: vi.fn().mockResolvedValue(undefined),
    questionReject: vi.fn().mockResolvedValue(undefined),
    permissionReply: vi.fn().mockResolvedValue(undefined),
    permissionList: vi.fn().mockResolvedValue([]),
    undo: vi.fn().mockResolvedValue({ revertMessageID: 'msg-1', restoredPrompt: 'original', revertDiff: 'diff' }),
    redo: vi.fn().mockResolvedValue({ revertMessageID: 'msg-2' }),
    listCommands: vi.fn().mockResolvedValue([{ name: 'compact', description: 'Compact context', template: '/compact' }]),
    sendCommand: vi.fn().mockResolvedValue(undefined),
    renameSession: vi.fn().mockResolvedValue(undefined),
    setMainWindow: vi.fn(),
    // Claude-specific methods (not on interface but used via casting in resolvers)
    hasPendingQuestion: vi.fn().mockReturnValue(false),
    hasPendingPlan: vi.fn().mockReturnValue(false),
    hasPendingPlanForSession: vi.fn().mockReturnValue(false),
    planApprove: vi.fn().mockResolvedValue(undefined),
    planReject: vi.fn().mockResolvedValue(undefined),
  }
}

/**
 * Creates a mock AgentSdkManager with both opencode and claude-code implementers.
 */
export function createMockSdkManager() {
  const opencodeImpl = createMockImplementer('opencode', MOCK_OPENCODE_CAPABILITIES)
  const claudeImpl = createMockImplementer('claude-code', MOCK_CLAUDE_CAPABILITIES)

  return {
    manager: {
      getImplementer: vi.fn((sdkId: string) => {
        if (sdkId === 'claude-code') return claudeImpl
        return opencodeImpl
      }),
      getCapabilities: vi.fn((sdkId: string) => {
        if (sdkId === 'claude-code') return MOCK_CLAUDE_CAPABILITIES
        return MOCK_OPENCODE_CAPABILITIES
      }),
      setMainWindow: vi.fn(),
      cleanupAll: vi.fn().mockResolvedValue(undefined),
      defaultSdkId: 'opencode' as const
    },
    opencodeImpl,
    claudeImpl
  }
}
```

**Step 2: Commit**

```bash
git add test/server/helpers/mock-sdk.ts
git commit -m "test(server): add mock SDK helpers for OpenCode resolver tests"
```

---

## Task 16: Integration Tests (Session 72b)

**Files:**
- Create: `test/server/integration/opencode.test.ts`
- Modify: `test/server/helpers/test-server.ts` (to accept sdkManager in context)

**Step 1: Update test-server to accept custom context overrides**

In `test/server/helpers/test-server.ts`, modify `createTestServer` to accept an optional context override:

```typescript
export function createTestServer(
  mockDb: MockDatabaseService,
  contextOverrides?: Record<string, unknown>
) {
  const typeDefs = loadSchemaSDL()
  const resolvers = mergeResolvers()

  const yoga = createYoga({
    schema: createSchema({ typeDefs, resolvers }),
    context: {
      db: mockDb,
      authenticated: true,
      clientIp: '127.0.0.1',
      sdkManager: {} as any,
      eventBus: {} as any,
      ...contextOverrides
    }
  })

  return {
    execute: async (
      query: string,
      variables?: Record<string, unknown>
    ): Promise<{ data?: any; errors?: any[] }> => {
      const response = await yoga.fetch('http://localhost/graphql', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ query, variables })
      })
      return response.json() as any
    }
  }
}
```

**Step 2: Create the integration test file**

```typescript
// test/server/integration/opencode.test.ts
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { homedir } from 'os'
import { join } from 'path'

// Mock Electron
vi.mock('electron', () => ({
  app: {
    getPath: (name: string) => {
      if (name === 'home') return homedir()
      if (name === 'userData') return join(homedir(), '.hive')
      if (name === 'logs') return join(homedir(), '.hive', 'logs')
      return '/tmp'
    },
    getVersion: () => '0.0.0-test',
    getAppPath: () => '/tmp/hive-test-app'
  },
  ipcMain: { handle: vi.fn() },
  BrowserWindow: vi.fn()
}))

// Mock opencode-service (all resolvers import it directly)
const mockOpenCodeService = {
  connect: vi.fn().mockResolvedValue({ sessionId: 'oc-session-1' }),
  reconnect: vi.fn().mockResolvedValue({ success: true, sessionStatus: 'idle', revertMessageID: null }),
  disconnect: vi.fn().mockResolvedValue(undefined),
  prompt: vi.fn().mockResolvedValue(undefined),
  abort: vi.fn().mockResolvedValue(true),
  getMessages: vi.fn().mockResolvedValue([{ id: '1', role: 'user', content: 'hi' }]),
  getAvailableModels: vi.fn().mockResolvedValue({ openai: [{ id: 'gpt-4', name: 'GPT-4' }] }),
  getModelInfo: vi.fn().mockResolvedValue({ id: 'gpt-4', name: 'GPT-4', limit: { context: 128000, output: 4096 } }),
  setSelectedModel: vi.fn(),
  getSessionInfo: vi.fn().mockResolvedValue({ revertMessageID: 'msg-5', revertDiff: '@@ -1 +1 @@' }),
  questionReply: vi.fn().mockResolvedValue(undefined),
  questionReject: vi.fn().mockResolvedValue(undefined),
  permissionReply: vi.fn().mockResolvedValue(undefined),
  permissionList: vi.fn().mockResolvedValue([]),
  undo: vi.fn().mockResolvedValue({ revertMessageID: 'msg-3', restoredPrompt: 'my prompt', revertDiff: 'diff' }),
  redo: vi.fn().mockResolvedValue({ revertMessageID: 'msg-4' }),
  listCommands: vi.fn().mockResolvedValue([{ name: 'compact', description: 'Compact', template: '/compact' }]),
  sendCommand: vi.fn().mockResolvedValue(undefined),
  renameSession: vi.fn().mockResolvedValue(undefined),
  forkSession: vi.fn().mockResolvedValue({ sessionId: 'fork-session-1' }),
  setMainWindow: vi.fn()
}

vi.mock('../../../src/main/services/opencode-service', () => ({
  openCodeService: mockOpenCodeService
}))

// Mock event-bus
vi.mock('../../../src/server/event-bus', () => ({
  getEventBus: vi.fn(() => ({ emit: vi.fn() }))
}))

// Mock worktree/branch watchers
vi.mock('../../../src/main/services/worktree-watcher', () => ({
  watchWorktree: vi.fn(),
  unwatchWorktree: vi.fn()
}))

vi.mock('../../../src/main/services/branch-watcher', () => ({
  watchBranch: vi.fn(),
  unwatchBranch: vi.fn()
}))

// Mock connection-service
vi.mock('../../../src/main/services/connection-service', () => ({
  createConnectionDir: vi.fn(() => '/tmp/fake-conn-dir'),
  createSymlink: vi.fn(),
  removeSymlink: vi.fn(),
  deleteConnectionDir: vi.fn(),
  generateConnectionInstructions: vi.fn(),
  deriveSymlinkName: vi.fn((n: string) => n.toLowerCase().replace(/\s+/g, '-')),
  generateConnectionColor: vi.fn(() => '["#aaa","#bbb","#ccc","#ddd"]')
}))

import { MockDatabaseService } from '../helpers/mock-db'
import { createTestServer } from '../helpers/test-server'
import { createMockSdkManager } from '../helpers/mock-sdk'

/* eslint-disable @typescript-eslint/no-explicit-any */

describe('OpenCode Resolvers — Integration Tests', () => {
  let db: MockDatabaseService
  let execute: (query: string, variables?: Record<string, unknown>) => Promise<{ data?: any; errors?: any[] }>
  let sdkMocks: ReturnType<typeof createMockSdkManager>

  beforeEach(() => {
    vi.clearAllMocks()
    db = new MockDatabaseService()
    sdkMocks = createMockSdkManager()

    const server = createTestServer(db, { sdkManager: sdkMocks.manager })
    execute = server.execute

    // Create a project + worktree + session for OpenCode tests
    const project = db.createProject({ name: 'Test', path: '/tmp/test', branch_name: 'main' })
    const worktree = db.createWorktree({
      project_id: project.id,
      path: '/tmp/test',
      branch_name: 'main',
      is_main: 1
    })
    db.createSession({
      worktree_id: worktree.id,
      opencode_session_id: 'oc-session-1',
      agent_sdk: 'opencode'
    })
    db.createSession({
      worktree_id: worktree.id,
      opencode_session_id: 'cc-session-1',
      agent_sdk: 'claude-code'
    })
  })

  // --- Connect ---

  describe('opencodeConnect', () => {
    it('routes to openCodeService for opencode sessions', async () => {
      // Create a hive session with opencode sdk
      const project = db.projects[0]
      const worktree = db.worktrees[0]
      const session = db.createSession({
        worktree_id: worktree.id,
        agent_sdk: 'opencode'
      })

      const result = await execute(`
        mutation { opencodeConnect(worktreePath: "/tmp/test", hiveSessionId: "${session.id}") {
          success sessionId
        }}
      `)

      expect(result.data.opencodeConnect.success).toBe(true)
      expect(result.data.opencodeConnect.sessionId).toBe('oc-session-1')
      expect(mockOpenCodeService.connect).toHaveBeenCalledWith('/tmp/test', session.id)
    })

    it('routes to claude-code implementer for claude-code sessions', async () => {
      const worktree = db.worktrees[0]
      const session = db.createSession({
        worktree_id: worktree.id,
        agent_sdk: 'claude-code'
      })

      const result = await execute(`
        mutation { opencodeConnect(worktreePath: "/tmp/test", hiveSessionId: "${session.id}") {
          success sessionId
        }}
      `)

      expect(result.data.opencodeConnect.success).toBe(true)
      expect(result.data.opencodeConnect.sessionId).toBe('claude-code-session-1')
      expect(sdkMocks.claudeImpl.connect).toHaveBeenCalledWith('/tmp/test', session.id)
    })
  })

  // --- Disconnect ---

  describe('opencodeDisconnect', () => {
    it('disconnects opencode session', async () => {
      const result = await execute(`
        mutation { opencodeDisconnect(worktreePath: "/tmp/test", sessionId: "oc-session-1") {
          success
        }}
      `)
      expect(result.data.opencodeDisconnect.success).toBe(true)
      expect(mockOpenCodeService.disconnect).toHaveBeenCalledWith('/tmp/test', 'oc-session-1')
    })

    it('disconnects claude-code session via implementer', async () => {
      const result = await execute(`
        mutation { opencodeDisconnect(worktreePath: "/tmp/test", sessionId: "cc-session-1") {
          success
        }}
      `)
      expect(result.data.opencodeDisconnect.success).toBe(true)
      expect(sdkMocks.claudeImpl.disconnect).toHaveBeenCalledWith('/tmp/test', 'cc-session-1')
    })
  })

  // --- Prompt ---

  describe('opencodePrompt', () => {
    it('sends prompt with text message', async () => {
      const result = await execute(`
        mutation { opencodePrompt(input: {
          worktreePath: "/tmp/test"
          opencodeSessionId: "oc-session-1"
          message: "Hello world"
        }) { success }}
      `)
      expect(result.data.opencodePrompt.success).toBe(true)
      expect(mockOpenCodeService.prompt).toHaveBeenCalled()
    })
  })

  // --- Abort ---

  describe('opencodeAbort', () => {
    it('aborts opencode session', async () => {
      const result = await execute(`
        mutation { opencodeAbort(worktreePath: "/tmp/test", sessionId: "oc-session-1") {
          success
        }}
      `)
      expect(result.data.opencodeAbort.success).toBe(true)
    })
  })

  // --- Messages ---

  describe('opencodeMessages', () => {
    it('gets messages from opencode session', async () => {
      const result = await execute(`
        query { opencodeMessages(worktreePath: "/tmp/test", sessionId: "oc-session-1") {
          success messages
        }}
      `)
      expect(result.data.opencodeMessages.success).toBe(true)
      expect(result.data.opencodeMessages.messages).toBeDefined()
    })

    it('gets messages from claude-code session', async () => {
      const result = await execute(`
        query { opencodeMessages(worktreePath: "/tmp/test", sessionId: "cc-session-1") {
          success messages
        }}
      `)
      expect(result.data.opencodeMessages.success).toBe(true)
      expect(sdkMocks.claudeImpl.getMessages).toHaveBeenCalledWith('/tmp/test', 'cc-session-1')
    })
  })

  // --- Session Info ---

  describe('opencodeSessionInfo', () => {
    it('gets session info', async () => {
      const result = await execute(`
        query { opencodeSessionInfo(worktreePath: "/tmp/test", sessionId: "oc-session-1") {
          success revertMessageID revertDiff
        }}
      `)
      expect(result.data.opencodeSessionInfo.success).toBe(true)
      expect(result.data.opencodeSessionInfo.revertMessageID).toBe('msg-5')
    })
  })

  // --- Models ---

  describe('opencodeModels', () => {
    it('lists opencode models by default', async () => {
      const result = await execute(`
        query { opencodeModels { success providers }}
      `)
      expect(result.data.opencodeModels.success).toBe(true)
      expect(mockOpenCodeService.getAvailableModels).toHaveBeenCalled()
    })

    it('lists claude-code models when agentSdk specified', async () => {
      const result = await execute(`
        query { opencodeModels(agentSdk: claude_code) { success providers }}
      `)
      expect(result.data.opencodeModels.success).toBe(true)
      expect(sdkMocks.claudeImpl.getAvailableModels).toHaveBeenCalled()
    })
  })

  // --- Set Model ---

  describe('opencodeSetModel', () => {
    it('sets model for opencode', async () => {
      const result = await execute(`
        mutation { opencodeSetModel(input: {
          providerID: "openai", modelID: "gpt-4"
        }) { success }}
      `)
      expect(result.data.opencodeSetModel.success).toBe(true)
      expect(mockOpenCodeService.setSelectedModel).toHaveBeenCalled()
    })
  })

  // --- Undo ---

  describe('opencodeUndo', () => {
    it('undoes opencode session', async () => {
      const result = await execute(`
        mutation { opencodeUndo(worktreePath: "/tmp/test", sessionId: "oc-session-1") {
          success revertMessageID restoredPrompt revertDiff
        }}
      `)
      expect(result.data.opencodeUndo.success).toBe(true)
      expect(result.data.opencodeUndo.revertMessageID).toBe('msg-3')
      expect(result.data.opencodeUndo.restoredPrompt).toBe('my prompt')
    })
  })

  // --- Redo ---

  describe('opencodeRedo', () => {
    it('redoes opencode session', async () => {
      const result = await execute(`
        mutation { opencodeRedo(worktreePath: "/tmp/test", sessionId: "oc-session-1") {
          success revertMessageID
        }}
      `)
      expect(result.data.opencodeRedo.success).toBe(true)
      expect(result.data.opencodeRedo.revertMessageID).toBe('msg-4')
    })
  })

  // --- Commands ---

  describe('opencodeCommands', () => {
    it('lists commands', async () => {
      const result = await execute(`
        query { opencodeCommands(worktreePath: "/tmp/test") {
          success commands { name description template }
        }}
      `)
      expect(result.data.opencodeCommands.success).toBe(true)
      expect(result.data.opencodeCommands.commands).toHaveLength(1)
      expect(result.data.opencodeCommands.commands[0].name).toBe('compact')
    })
  })

  // --- Capabilities ---

  describe('opencodeCapabilities', () => {
    it('returns opencode capabilities by default', async () => {
      const result = await execute(`
        query { opencodeCapabilities { success capabilities {
          supportsUndo supportsRedo supportsCommands
        }}}
      `)
      expect(result.data.opencodeCapabilities.success).toBe(true)
      expect(result.data.opencodeCapabilities.capabilities.supportsRedo).toBe(true)
    })

    it('returns claude-code capabilities for claude session', async () => {
      const result = await execute(`
        query { opencodeCapabilities(sessionId: "cc-session-1") { success capabilities {
          supportsUndo supportsRedo
        }}}
      `)
      expect(result.data.opencodeCapabilities.success).toBe(true)
      expect(result.data.opencodeCapabilities.capabilities.supportsRedo).toBe(false)
    })
  })

  // --- Permission List ---

  describe('opencodePermissionList', () => {
    it('lists permissions', async () => {
      const result = await execute(`
        query { opencodePermissionList { success permissions { id } }}
      `)
      expect(result.data.opencodePermissionList.success).toBe(true)
    })
  })

  // --- Permission Reply ---

  describe('opencodePermissionReply', () => {
    it('replies to permission request', async () => {
      const result = await execute(`
        mutation { opencodePermissionReply(input: {
          requestId: "perm-1", reply: "once"
        }) { success }}
      `)
      expect(result.data.opencodePermissionReply.success).toBe(true)
      expect(mockOpenCodeService.permissionReply).toHaveBeenCalledWith('perm-1', 'once', undefined, undefined)
    })
  })

  // --- Question Reply ---

  describe('opencodeQuestionReply', () => {
    it('replies to question', async () => {
      const result = await execute(`
        mutation { opencodeQuestionReply(input: {
          requestId: "q-1", answers: [["yes"]]
        }) { success }}
      `)
      expect(result.data.opencodeQuestionReply.success).toBe(true)
    })
  })

  // --- Question Reject ---

  describe('opencodeQuestionReject', () => {
    it('rejects question', async () => {
      const result = await execute(`
        mutation { opencodeQuestionReject(requestId: "q-1") { success }}
      `)
      expect(result.data.opencodeQuestionReject.success).toBe(true)
    })
  })

  // --- Fork ---

  describe('opencodeFork', () => {
    it('forks session', async () => {
      const result = await execute(`
        mutation { opencodeFork(input: {
          worktreePath: "/tmp/test", opencodeSessionId: "oc-session-1"
        }) { success sessionId }}
      `)
      expect(result.data.opencodeFork.success).toBe(true)
      expect(result.data.opencodeFork.sessionId).toBe('fork-session-1')
    })
  })

  // --- Rename ---

  describe('opencodeRenameSession', () => {
    it('renames session', async () => {
      const result = await execute(`
        mutation { opencodeRenameSession(input: {
          opencodeSessionId: "oc-session-1", title: "New Title"
        }) { success }}
      `)
      expect(result.data.opencodeRenameSession.success).toBe(true)
      expect(mockOpenCodeService.renameSession).toHaveBeenCalledWith('oc-session-1', 'New Title', undefined)
    })
  })

  // --- Reconnect ---

  describe('opencodeReconnect', () => {
    it('reconnects opencode session', async () => {
      const result = await execute(`
        mutation { opencodeReconnect(input: {
          worktreePath: "/tmp/test"
          opencodeSessionId: "oc-session-1"
          hiveSessionId: "${db.sessions[0].id}"
        }) { success sessionStatus revertMessageID }}
      `)
      expect(result.data.opencodeReconnect.success).toBe(true)
    })
  })
})
```

**Step 3: Run the tests**

Run: `pnpm vitest run test/server/integration/opencode.test.ts`
Expected: All tests PASS

**Step 4: Verify full build**

Run: `pnpm build`
Expected: SUCCESS

**Step 5: Commit**

```bash
git add test/server/helpers/mock-sdk.ts test/server/helpers/test-server.ts test/server/integration/opencode.test.ts
git commit -m "test(server): add OpenCode resolver integration tests with mock SDK"
```

---

## Task 17: Final Verification

**Step 1: Run all server tests**

Run: `pnpm vitest run test/server/`
Expected: All tests PASS (existing + new)

**Step 2: Run full build**

Run: `pnpm build`
Expected: SUCCESS

**Step 3: Run lint**

Run: `pnpm lint`
Expected: No new errors

---

## Summary of Files

**Created:**
- `src/server/resolvers/helpers/sdk-dispatch.ts`
- `src/server/resolvers/mutation/opencode.resolvers.ts`
- `src/server/resolvers/query/opencode.resolvers.ts`
- `test/server/helpers/mock-sdk.ts`
- `test/server/integration/opencode.test.ts`

**Modified:**
- `src/server/resolvers/index.ts` (add imports + merge)
- `test/server/helpers/test-server.ts` (add contextOverrides param)
