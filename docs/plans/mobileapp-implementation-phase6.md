# Phase 6 — Resolvers: OpenCode AI (Sessions 59–72)

**PRD Reference:** `docs/plans/mobileapp.md`
**Master Plan Reference:** `docs/plans/mobileapp-implementation.md`

## Phase Overview

Phase 6 implements the most complex resolvers — AI session management with dual SDK dispatch. The Hive app supports two AI backends: **OpenCode** (default) and **Claude Code**. The IPC handler at `src/main/ipc/opencode-handlers.ts` routes requests based on the session's `agent_sdk` field. GraphQL resolvers must replicate this same dispatch pattern.

At the end of this phase, all 20+ OpenCode operations work via GraphQL, including connect, disconnect, prompt, abort, model selection, undo/redo, commands, permissions, questions, plans, fork, and rename.

## Prerequisites

- Phases 1-5 completed: all infrastructure, DB resolvers, and operation resolvers working.
- `GraphQLContext` has `db`, `sdkManager`, `eventBus`.
- `AgentSdkManager` from `src/main/services/agent-sdk-manager.ts` is available in context.

## Key Architecture: SDK Dispatch Pattern

The existing IPC handler pattern (from `src/main/ipc/opencode-handlers.ts` lines 19-44):

```typescript
// For each operation, check if session uses claude-code SDK
if (sdkManager && dbService) {
  const session = dbService.getSession(hiveSessionId)
  if (session?.agent_sdk === 'claude-code') {
    const impl = sdkManager.getImplementer('claude-code')
    const result = await impl.connect(worktreePath, hiveSessionId)
    return { success: true, ...result }
  }
}
// Fall through to existing OpenCode path
const result = await openCodeService.connect(worktreePath, hiveSessionId)
return { success: true, ...result }
```

GraphQL resolvers must implement the SAME dispatch:
1. Look up the session's `agent_sdk` from DB
2. If `'claude-code'` → route to `ctx.sdkManager.getImplementer('claude-code')`
3. If `'opencode'` (or default) → route to `openCodeService` directly

Create a helper function to avoid repeating this pattern in every resolver:

```typescript
async function dispatchToSdk(ctx, sessionId, opencodeFn, claudeFn) {
  if (ctx.sdkManager && ctx.db) {
    const sdkId = ctx.db.getAgentSdkForSession(sessionId)
    if (sdkId === 'claude-code') {
      return await claudeFn(ctx.sdkManager.getImplementer('claude-code'))
    }
  }
  return await opencodeFn()
}
```

## Source of Truth

| Reference | Purpose |
|-----------|---------|
| `src/main/ipc/opencode-handlers.ts` | Full IPC handler with SDK dispatch (763 lines) — THE template |
| `src/main/services/opencode-service.ts` | OpenCode SDK service |
| `src/main/services/claude-code-implementer.ts` | Claude Code SDK implementer |
| `src/main/services/agent-sdk-manager.ts` | SDK router |
| `src/main/services/agent-sdk-types.ts` | `AgentSdkImplementer` interface |
| `src/preload/index.ts` lines 927-1186 | All `opencodeOps.*` IPC calls |

---

## Session 59: OpenCode Mutation — Connect & Disconnect

**Goal:** Implement `opencodeConnect`, `opencodeReconnect`, `opencodeDisconnect` mutations.

**Definition of Done:** Can connect to an AI session, reconnect to existing session, and disconnect, with correct SDK dispatch.

**Tasks:**

1. `[server]` Create `src/server/resolvers/mutation/opencode.resolvers.ts`:

2. `[server]` Create SDK dispatch helper:
   ```typescript
   import { openCodeService } from '../../main/services/opencode-service'
   import type { GraphQLContext } from '../context'

   function getSessionSdk(ctx: GraphQLContext, sessionId: string): 'opencode' | 'claude-code' {
     if (ctx.db && ctx.sdkManager) {
       return ctx.db.getAgentSdkForSession(sessionId) || 'opencode'
     }
     return 'opencode'
   }
   ```

3. `[server]` Implement `opencodeConnect`:
   ```typescript
   opencodeConnect: async (_p, { worktreePath, hiveSessionId }, ctx) => {
     try {
       const session = ctx.db.session.get(hiveSessionId)
       if (session?.agent_sdk === 'claude-code' && ctx.sdkManager) {
         const impl = ctx.sdkManager.getImplementer('claude-code')
         const result = await impl.connect(worktreePath, hiveSessionId)
         return { success: true, sessionId: result.sessionId }
       }
       const result = await openCodeService.connect(worktreePath, hiveSessionId)
       return { success: true, sessionId: result.sessionId }
     } catch (error) {
       return { success: false, error: error.message }
     }
   }
   ```

4. `[server]` Implement `opencodeReconnect`:
   - Takes `OpenCodeReconnectInput { worktreePath, opencodeSessionId, hiveSessionId }`
   - SDK dispatch: check `db.getAgentSdkForSession(opencodeSessionId)`
   - OpenCode path: `openCodeService.reconnect(worktreePath, opencodeSessionId, hiveSessionId)`
   - Claude path: `impl.reconnect(worktreePath, opencodeSessionId, hiveSessionId)`
   - Returns `OpenCodeReconnectResult { success, sessionStatus, revertMessageID }`

5. `[server]` Implement `opencodeDisconnect`:
   - Takes `worktreePath, sessionId`
   - SDK dispatch on `sessionId`
   - OpenCode path: `openCodeService.disconnect(worktreePath, sessionId)`
   - Claude path: `impl.disconnect(worktreePath, sessionId)`
   - Returns `SuccessResult`

6. `[server]` Register in resolver merger.
7. `[server]` Verify: `pnpm build`

---

## Session 60: OpenCode Mutation — Prompt & Abort

**Goal:** Implement `opencodePrompt`, `opencodeAbort` mutations.

**Definition of Done:** Can send prompts (text + file attachments) and abort streaming sessions.

**Tasks:**

1. `[server]` Implement `opencodePrompt`:
   - Takes `OpenCodePromptInput { worktreePath, opencodeSessionId, message, parts, model }`
   - If `message` provided: convert to `[{ type: 'text', text: message }]`
   - If `parts` provided: use directly as `MessagePart[]`
   - SDK dispatch on `opencodeSessionId`
   - OpenCode path: `openCodeService.prompt(worktreePath, opencodeSessionId, parts, model)`
   - Claude path: `impl.prompt(worktreePath, opencodeSessionId, parts, model)`
   - Returns `SuccessResult`

   Note: The prompt is fire-and-forget. The actual response streams via the `opencodeStream` subscription (Phase 8). The prompt mutation just initiates the request.

2. `[server]` Implement `opencodeAbort`:
   - Takes `worktreePath, sessionId`
   - SDK dispatch on `sessionId`
   - OpenCode path: `openCodeService.abort(worktreePath, sessionId)`
   - Claude path: `impl.abort(worktreePath, sessionId)`
   - Returns `SuccessResult`

3. `[server]` Verify: `pnpm build`

---

## Session 61: OpenCode Query — Messages & Session Info

**Goal:** Implement `opencodeMessages`, `opencodeSessionInfo` queries.

**Definition of Done:** Can retrieve message history and session revert state.

**Tasks:**

1. `[server]` Create `src/server/resolvers/query/opencode.resolvers.ts`:

2. `[server]` Implement `opencodeMessages`:
   - Takes `worktreePath, sessionId`
   - SDK dispatch on `sessionId`
   - OpenCode path: `openCodeService.getMessages(worktreePath, sessionId)`
   - Claude path: `impl.getMessages(worktreePath, sessionId)`
   - Returns `OpenCodeMessagesResult { success, messages (JSON), error }`
   - Messages are returned as JSON since their structure varies by SDK

3. `[server]` Implement `opencodeSessionInfo`:
   - Takes `worktreePath, sessionId`
   - SDK dispatch on `sessionId`
   - OpenCode path: `openCodeService.sessionInfo(worktreePath, sessionId)`
   - Claude path: `impl.getSessionInfo(worktreePath, sessionId)`
   - Returns `OpenCodeSessionInfoResult { success, revertMessageID, revertDiff, error }`

4. `[server]` Register in resolver merger.
5. `[server]` Verify: `pnpm build`

---

## Session 62: OpenCode Query — Models

**Goal:** Implement `opencodeModels`, `opencodeModelInfo` queries.

**Definition of Done:** Can list available models and get model details.

**Tasks:**

1. `[server]` Implement `opencodeModels`:
   - Takes optional `agentSdk` argument
   - If `agentSdk === 'claude_code'`: route to Claude implementer's `getAvailableModels()`
   - Default: route to `openCodeService.listModels()`
   - Returns `OpenCodeModelsResult { success, providers (JSON), error }`

2. `[server]` Implement `opencodeModelInfo`:
   - Takes `worktreePath, modelId, agentSdk?`
   - SDK dispatch based on `agentSdk` argument
   - Returns `OpenCodeModelInfoResult { success, model (JSON), error }`

3. `[server]` Verify: `pnpm build`

---

## Session 63: OpenCode Mutation — Model Selection

**Goal:** Implement `opencodeSetModel` mutation.

**Definition of Done:** Can set the selected model for future prompts.

**Tasks:**

1. `[server]` Implement `opencodeSetModel`:
   - Takes `SetModelInput { providerID, modelID, variant, agentSdk }`
   - If `agentSdk === 'claude_code'`: route to Claude implementer's `setSelectedModel()`
   - Default: route to `openCodeService.setModel()`
   - Returns `SuccessResult`

2. `[server]` Verify: `pnpm build`

---

## Session 64: OpenCode Mutation — Undo & Redo

**Goal:** Implement `opencodeUndo`, `opencodeRedo` mutations.

**Definition of Done:** Can undo/redo the last assistant turn.

**Tasks:**

1. `[server]` Implement `opencodeUndo`:
   - Takes `worktreePath, sessionId`
   - SDK dispatch on `sessionId`
   - OpenCode path: `openCodeService.undo(worktreePath, sessionId)`
   - Claude path: `impl.undo(worktreePath, sessionId)`
   - Returns `OpenCodeUndoResult { success, revertMessageID, restoredPrompt, revertDiff, error }`

2. `[server]` Implement `opencodeRedo`:
   - Takes `worktreePath, sessionId`
   - SDK dispatch on `sessionId`
   - Returns `OpenCodeRedoResult { success, revertMessageID, error }`

3. `[server]` Verify: `pnpm build`

---

## Session 65: OpenCode Query — Commands & Capabilities

**Goal:** Implement `opencodeCommands`, `opencodeCapabilities` queries.

**Definition of Done:** Can list available slash commands and SDK capabilities.

**Tasks:**

1. `[server]` Implement `opencodeCommands`:
   - Takes `worktreePath, sessionId?`
   - If `sessionId` provided: SDK dispatch to get session-specific commands
   - Returns `OpenCodeCommandsResult { success, commands: [OpenCodeCommand], error }`

2. `[server]` Implement `opencodeCapabilities`:
   - Takes `sessionId?`
   - If `sessionId` provided: look up SDK and return its capabilities
   - Default: return OpenCode capabilities
   - Returns `OpenCodeCapabilitiesResult { success, capabilities, error }`

   The capabilities object has fields: `supportsUndo`, `supportsRedo`, `supportsCommands`, `supportsPermissionRequests`, `supportsQuestionPrompts`, `supportsModelSelection`, `supportsReconnect`, `supportsPartialStreaming`.

3. `[server]` Verify: `pnpm build`

---

## Session 66: OpenCode Mutation — Command Execution

**Goal:** Implement `opencodeCommand` mutation.

**Definition of Done:** Can execute slash commands (e.g., `/compact`, `/clear`).

**Tasks:**

1. `[server]` Implement `opencodeCommand`:
   - Takes `OpenCodeCommandInput { worktreePath, opencodeSessionId, command, args, model }`
   - SDK dispatch on `opencodeSessionId`
   - OpenCode path: `openCodeService.command(worktreePath, opencodeSessionId, command, args, model)`
   - Claude path: `impl.sendCommand(worktreePath, opencodeSessionId, command, args, model)`
   - Returns `SuccessResult`

2. `[server]` Verify: `pnpm build`

---

## Session 67: OpenCode Mutation — Permissions

**Goal:** Implement `opencodePermissionReply` mutation and `opencodePermissionList` query.

**Definition of Done:** Can list pending permissions and reply to them.

**Tasks:**

1. `[server]` Implement `opencodePermissionList` query:
   - Takes `worktreePath?`
   - Returns list of pending permission requests
   - OpenCode path: `openCodeService.permissionList(worktreePath)`
   - Returns `OpenCodePermissionListResult { success, permissions: [PermissionRequest], error }`

2. `[server]` Implement `opencodePermissionReply` mutation:
   - Takes `PermissionReplyInput { requestId, reply ('once'|'always'|'reject'), worktreePath, message }`
   - OpenCode path: `openCodeService.permissionReply(requestId, reply, worktreePath, message)`
   - Returns `SuccessResult`

3. `[server]` Verify: `pnpm build`

---

## Session 68: OpenCode Mutation — Questions

**Goal:** Implement `opencodeQuestionReply`, `opencodeQuestionReject` mutations.

**Definition of Done:** Can reply to and reject AI-posed questions.

**Tasks:**

1. `[server]` Implement `opencodeQuestionReply`:
   - Takes `QuestionReplyInput { requestId, answers: [[String!]!]!, worktreePath }`
   - OpenCode path: `openCodeService.questionReply(requestId, answers, worktreePath)`
   - Returns `SuccessResult`

2. `[server]` Implement `opencodeQuestionReject`:
   - Takes `requestId, worktreePath?`
   - OpenCode path: `openCodeService.questionReject(requestId, worktreePath)`
   - Returns `SuccessResult`

3. `[server]` Verify: `pnpm build`

---

## Session 69: OpenCode Mutation — Plans

**Goal:** Implement `opencodePlanApprove`, `opencodePlanReject` mutations.

**Definition of Done:** Can approve or reject AI-generated plans.

**Tasks:**

1. `[server]` Implement `opencodePlanApprove`:
   - Takes `PlanApproveInput { worktreePath, hiveSessionId, requestId }`
   - OpenCode path: `openCodeService.planApprove(worktreePath, hiveSessionId, requestId)`
   - Returns `SuccessResult`

2. `[server]` Implement `opencodePlanReject`:
   - Takes `PlanRejectInput { worktreePath, hiveSessionId, feedback, requestId }`
   - OpenCode path: `openCodeService.planReject(worktreePath, hiveSessionId, feedback, requestId)`
   - Returns `SuccessResult`

3. `[server]` Verify: `pnpm build`

---

## Session 70: OpenCode Mutation — Fork & Rename

**Goal:** Implement `opencodeFork`, `opencodeRenameSession` mutations.

**Definition of Done:** Can fork sessions and rename them.

**Tasks:**

1. `[server]` Implement `opencodeFork`:
   - Takes `ForkSessionInput { worktreePath, opencodeSessionId, messageId }`
   - SDK dispatch on `opencodeSessionId`
   - Returns `OpenCodeForkResult { success, sessionId, error }`

2. `[server]` Implement `opencodeRenameSession`:
   - Takes `RenameSessionInput { opencodeSessionId, title, worktreePath }`
   - SDK dispatch on `opencodeSessionId`
   - OpenCode path: `openCodeService.renameSession(opencodeSessionId, title, worktreePath)`
   - Returns `SuccessResult`

3. `[server]` Verify: `pnpm build`

---

## Session 71: OpenCode SDK Dispatch

**Goal:** Verify and harden the SDK dispatch logic across all OpenCode resolvers.

**Definition of Done:** All OpenCode resolvers correctly route `claude-code` sessions to `sdkManager.getImplementer('claude-code')` and `opencode` sessions to `openCodeService`.

**Tasks:**

1. `[server]` Review all OpenCode resolvers from Sessions 59-70 and ensure:
   - Every mutation that takes a `sessionId`/`opencodeSessionId` uses the dispatch helper
   - The dispatch helper correctly handles: missing sdkManager (graceful fallback to opencode), missing session in DB (fallback to opencode), `agent_sdk === 'claude-code'` routes to ClaudeCodeImplementer
   - Error handling wraps all SDK calls in try/catch and returns `{ success: false, error: message }`

2. `[server]` Create the shared dispatch helper (if not already done):
   ```typescript
   // src/server/resolvers/helpers/sdk-dispatch.ts
   export async function withSdkDispatch<T>(
     ctx: GraphQLContext,
     sessionId: string,
     opencodeFn: () => Promise<T>,
     claudeFn: (impl: AgentSdkImplementer) => Promise<T>
   ): Promise<T> {
     if (ctx.sdkManager && ctx.db) {
       const sdkId = ctx.db.getAgentSdkForSession(sessionId)
       if (sdkId === 'claude-code') {
         return claudeFn(ctx.sdkManager.getImplementer('claude-code'))
       }
     }
     return opencodeFn()
   }
   ```

3. `[server]` Verify `pnpm build` succeeds.

---

## Session 72: OpenCode Resolver Tests

**Goal:** Integration tests for all OpenCode resolvers.

**Definition of Done:** Tests for connect, prompt, messages, model listing, permissions, questions, plans, undo/redo, fork, and SDK dispatch — all pass.

**Tasks:**

1. `[server]` Create `test/server/helpers/mock-sdk.ts`:
   - Mock `AgentSdkManager` with mock implementers for both `opencode` and `claude-code`
   - Mock `openCodeService` with predictable responses
   - Each mock method records calls for assertion

2. `[server]` Create `test/server/integration/opencode.test.ts` with tests:
   - **Connect**: `opencodeConnect` with opencode session → calls openCodeService.connect
   - **Connect (Claude)**: `opencodeConnect` with claude-code session → routes to claude implementer
   - **Prompt**: `opencodePrompt` with text message → calls prompt
   - **Prompt (parts)**: `opencodePrompt` with MessagePart array → passes parts correctly
   - **Abort**: `opencodeAbort` → calls abort
   - **Messages**: `opencodeMessages` → returns message array
   - **Models**: `opencodeModels` → returns provider map
   - **Model info**: `opencodeModelInfo` → returns model details
   - **Set model**: `opencodeSetModel` → calls setModel
   - **Undo**: `opencodeUndo` → returns revert info
   - **Redo**: `opencodeRedo` → returns revert info
   - **Commands**: `opencodeCommands` → returns command list
   - **Capabilities**: `opencodeCapabilities` → returns capability flags
   - **Permission list**: `opencodePermissionList` → returns pending permissions
   - **Permission reply**: `opencodePermissionReply` → calls reply
   - **Question reply**: `opencodeQuestionReply` → calls reply with answers
   - **Question reject**: `opencodeQuestionReject` → calls reject
   - **Plan approve**: `opencodePlanApprove` → calls approve
   - **Plan reject**: `opencodePlanReject` → calls reject with feedback
   - **Fork**: `opencodeFork` → returns new session ID
   - **Rename**: `opencodeRenameSession` → calls rename
   - **SDK dispatch**: Session with `agent_sdk='claude-code'` → all operations route to claude implementer

3. `[server]` Run tests: `pnpm vitest run test/server/integration/opencode.test.ts`

**Verification:**
```bash
pnpm vitest run test/server/integration/opencode.test.ts && pnpm build
```

---

## Summary of Files Created

```
src/server/resolvers/
  query/
    opencode.resolvers.ts         — OpenCode query resolvers (messages, models, commands, capabilities, permissions)
  mutation/
    opencode.resolvers.ts         — OpenCode mutation resolvers (connect, prompt, abort, undo, redo, etc.)
  helpers/
    sdk-dispatch.ts               — Shared SDK dispatch helper

test/server/
  helpers/
    mock-sdk.ts                   — Mock AgentSdkManager + mock openCodeService
  integration/
    opencode.test.ts              — OpenCode resolver integration tests
```

## Summary of Files Modified

| File | Change |
|------|--------|
| `src/server/resolvers/index.ts` | Import and merge OpenCode resolvers |

## What Comes Next

Phase 7 (Script, Terminal, Logging Resolvers) implements the remaining non-subscription resolvers for script execution, terminal management, and response logging.
