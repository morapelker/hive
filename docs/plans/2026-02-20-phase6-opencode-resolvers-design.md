# Phase 6 Design: OpenCode AI GraphQL Resolvers

**Date:** 2026-02-20
**PRD Reference:** `docs/plans/mobileapp.md`
**Implementation Plan:** `docs/plans/mobileapp-implementation-phase6.md`

## Overview

Implement 21 GraphQL resolvers (14 mutations, 7 queries) that mirror the OpenCode IPC handlers with SDK-aware dispatch. The GraphQL schema and generated types already exist — this phase creates the resolver implementations.

## Architecture

### SDK Dispatch Pattern

Two dispatch helpers in `src/server/resolvers/helpers/sdk-dispatch.ts`:

1. **`withSdkDispatch(ctx, agentSessionId, opencodeFn, claudeFn)`** — Looks up agent SDK via `ctx.db.getAgentSdkForSession(agentSessionId)`. Routes `'claude-code'` sessions to `ctx.sdkManager.getImplementer('claude-code')`, everything else to `openCodeService`. Falls back to OpenCode if `sdkManager` or `db` is unavailable.

2. **`withSdkDispatchByHiveSession(ctx, hiveSessionId, opencodeFn, claudeFn)`** — Looks up via `ctx.db.getSession(hiveSessionId)?.agent_sdk`. Used only by `opencodeConnect` since the agent session doesn't exist yet at connect time.

Both wrap calls in try/catch and return `{ success: false, error }` on failure.

### Resolver Organization

```
src/server/resolvers/
  helpers/
    sdk-dispatch.ts               — Shared SDK dispatch helpers
  mutation/
    opencode.resolvers.ts         — 14 OpenCode mutation resolvers
  query/
    opencode.resolvers.ts         — 7 OpenCode query resolvers
```

### Mutations

| Mutation | Dispatch | Service Method |
|----------|----------|----------------|
| `opencodeConnect` | by hiveSessionId (getSession) | `connect(worktreePath, hiveSessionId)` |
| `opencodeReconnect` | by opencodeSessionId | `reconnect(worktreePath, opencodeSessionId, hiveSessionId)` |
| `opencodeDisconnect` | by sessionId | `disconnect(worktreePath, sessionId)` |
| `opencodePrompt` | by opencodeSessionId | `prompt(worktreePath, sessionId, parts, model)` |
| `opencodeAbort` | by sessionId | `abort(worktreePath, sessionId)` |
| `opencodeSetModel` | by agentSdk field (direct) | `setModel(input)` |
| `opencodeUndo` | by sessionId | `undo(worktreePath, sessionId)` |
| `opencodeRedo` | by sessionId | `redo(worktreePath, sessionId)` |
| `opencodeCommand` | by opencodeSessionId | `command(...)` / `sendCommand(...)` |
| `opencodeRenameSession` | by opencodeSessionId | `renameSession(...)` |
| `opencodeFork` | by opencodeSessionId | `forkSession(...)` |
| `opencodeQuestionReply` | none (requestId-based) | `questionReply(requestId, answers, worktreePath)` |
| `opencodeQuestionReject` | none (requestId-based) | `questionReject(requestId, worktreePath)` |
| `opencodePlanApprove` | none (opencode only) | `planApprove(worktreePath, hiveSessionId, requestId)` |
| `opencodePlanReject` | none (opencode only) | `planReject(worktreePath, hiveSessionId, feedback, requestId)` |
| `opencodePermissionReply` | none (requestId-based) | `permissionReply(requestId, reply, worktreePath, message)` |

### Queries

| Query | Dispatch | Returns |
|-------|----------|---------|
| `opencodeMessages` | by sessionId | `{ success, messages: JSON }` |
| `opencodeSessionInfo` | by sessionId | `{ success, revertMessageID, revertDiff }` |
| `opencodeModels` | by agentSdk arg (direct) | `{ success, providers: JSON }` |
| `opencodeModelInfo` | by agentSdk arg (direct) | `{ success, model: JSON }` |
| `opencodeCommands` | by sessionId (optional) | `{ success, commands: [OpenCodeCommand] }` |
| `opencodeCapabilities` | by sessionId (optional) | `{ success, capabilities }` |
| `opencodePermissionList` | none | `{ success, permissions }` |

### Import Pattern

Resolvers import `openCodeService` directly from `../../main/services/opencode-service` — matching the IPC handler pattern. The Claude implementer is accessed via `ctx.sdkManager.getImplementer('claude-code')`.

### Error Handling

Every resolver wraps service calls in try/catch:
```typescript
try {
  const result = await serviceCall()
  return { success: true, ...result }
} catch (error) {
  return { success: false, error: error instanceof Error ? error.message : 'Unknown error' }
}
```

## Testing

- **Mock SDK** (`test/server/helpers/mock-sdk.ts`): Mock `AgentSdkManager` with call-recording Claude implementer. Mock `openCodeService` module with vi.mock.
- **Integration tests** (`test/server/integration/opencode.test.ts`): 22+ test cases covering all resolvers and SDK dispatch routing verification.
- Uses existing `createTestServer` with additional SDK mocks in context.

## Session Breakdown

| Session | Scope |
|---------|-------|
| 59 | Dispatch helper + connect/reconnect/disconnect |
| 60 | Prompt + abort |
| 61 | Messages + session info queries |
| 62 | Models + model info queries |
| 63 | Set model mutation |
| 64 | Undo + redo |
| 65 | Commands + capabilities queries |
| 66 | Command execution |
| 67 | Permission list + permission reply |
| 68 | Question reply + reject |
| 69 | Plan approve + reject |
| 70 | Fork + rename |
| 71 | SDK dispatch hardening (review pass) |
| 72 | Integration tests |
